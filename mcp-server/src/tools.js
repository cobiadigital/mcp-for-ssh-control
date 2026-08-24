/**
 * Tool definitions.
 *
 * In v1 these schemas lived in the Cloudflare Worker and every call was
 * forwarded to a private JSON API on the box. There is no Worker in v2: the
 * schema and the implementation sit next to each other here, and the
 * Cloudflare MCP portal talks to this process directly.
 *
 * Note there is no `server` argument any more. One box runs one MCP server;
 * the portal aggregates them and namespaces every tool as
 * `{server_id}_{tool_name}` (for example `lightsail_docker_ps`).
 */

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  ALLOWED_COMPOSE_PATHS,
  ALLOWED_CONTAINERS,
  ALLOWED_PATHS,
  ALLOWED_SERVICES,
  COMPOSE_TIMEOUT_MS,
  EXEC_TIMEOUT_MS,
  MAX_FILE_BYTES,
  SERVER_ID,
} from "./config.js";
import {
  ToolError,
  asToolError,
  combinedOutput,
  composeCommand,
  describeAllowlist,
  exec,
  execToText,
  requireAllowlistedContainer,
  requireAllowlistedService,
  resolveAllowedPath,
  resolveComposeFile,
  resolveExistingFile,
  runnerFor,
  validateComposeServices,
} from "./sandbox.js";

const text = (body) => ({ content: [{ type: "text", text: body }] });
const failure = (body) => ({ content: [{ type: "text", text: body }], isError: true });

/**
 * Register one tool, wrapping the handler so a ToolError becomes a readable
 * MCP tool error the model can act on, while an unexpected exception is
 * logged and reported without leaking internals.
 */
function defineTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    const started = Date.now();
    // Log the call, never file contents: `path` is useful for auditing, and
    // `content` / `old_string` deliberately never reach the log.
    console.log(`[${new Date().toISOString()}] ${name} ${args?.path ?? args?.container ?? args?.service ?? ""}`.trimEnd());
    try {
      const result = await handler(args ?? {});
      console.log(`[${new Date().toISOString()}] ${name} ok in ${Date.now() - started}ms`);
      return result;
    } catch (e) {
      const error = asToolError(e);
      if (error instanceof ToolError) {
        console.log(`[${new Date().toISOString()}] ${name} rejected: ${error.message}`);
        return failure(error.message);
      }
      console.error(`[${new Date().toISOString()}] ${name} failed:`, error);
      return failure(`Internal error running "${name}" on ${SERVER_ID}.`);
    }
  });
}

const pathArg = z
  .string()
  .startsWith("/", "path must be absolute")
  .describe("Absolute path on this server. Must be inside one of its ALLOWED_PATHS roots.");

const containerArg = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "invalid container name")
  .describe("Container name (must be on this server's allowlist)");

export function registerTools(server) {
  // --- Orientation --------------------------------------------------------

  defineTool(
    server,
    "server_info",
    {
      title: "Server info",
      description:
        "Describe this server and what the other tools are permitted to touch on it: hostname, allowlisted containers and services, and the directory roots open to the file and script tools. Call this first when you do not know how the box is configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lines = [
        `server id:        ${SERVER_ID}`,
        `hostname:         ${os.hostname()}`,
        `platform:         ${os.type()} ${os.release()}`,
        `uptime:           ${Math.floor(os.uptime() / 3600)}h`,
        `containers:       ${describeAllowlist(ALLOWED_CONTAINERS, "container")}`,
        `services:         ${describeAllowlist(ALLOWED_SERVICES, "service")}`,
        `file/script roots: ${
          ALLOWED_PATHS.join(", ") || "(none — file and script tools are disabled)"
        }`,
        `compose roots:    ${
          ALLOWED_COMPOSE_PATHS.join(", ") || "(none — compose tools are disabled)"
        }`,
      ];
      return text(lines.join("\n"));
    }
  );

  // --- Docker -------------------------------------------------------------

  defineTool(
    server,
    "docker_ps",
    {
      title: "List Docker containers",
      description: "List all Docker containers on this server with their status and ports.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        await execToText([
          "docker", "ps", "-a",
          "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}",
        ])
      )
  );

  defineTool(
    server,
    "docker_logs",
    {
      title: "Tail Docker logs",
      description: "Tail the logs of an allowlisted Docker container on this server.",
      inputSchema: {
        container: containerArg,
        lines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Number of log lines to return (default 50, max 1000)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ container, lines }) => {
      const name = requireAllowlistedContainer(container);
      const tail = Math.min(Math.max(Number.parseInt(lines, 10) || 50, 1), 1000);
      return text(await execToText(["docker", "logs", "--tail", String(tail), name]));
    }
  );

  defineTool(
    server,
    "docker_restart",
    {
      title: "Restart Docker container",
      description: "Restart an allowlisted Docker container on this server.",
      inputSchema: { container: containerArg },
      annotations: { destructiveHint: true },
    },
    async ({ container }) => {
      const name = requireAllowlistedContainer(container);
      return text(await execToText(["docker", "restart", name]));
    }
  );

  // --- Docker Compose -----------------------------------------------------
  // Creating containers goes through a compose file on disk rather than a
  // free-form `docker run`. The file is jailed to ALLOWED_COMPOSE_PATHS, and
  // no image, flag, mount or capability is ever taken from a tool argument —
  // it all comes from a file a human can read and diff.

  const composeFileArg = z
    .string()
    .startsWith("/", "path must be absolute")
    .describe(
      "Absolute path to a docker-compose .yml/.yaml file, inside one of this server's ALLOWED_COMPOSE_PATHS roots."
    );

  const composeServicesArg = z
    .array(z.string())
    .max(32)
    .optional()
    .describe("Limit the action to these compose services. Omit for all of them.");

  /** Every compose tool resolves the file the same way, then runs one action. */
  const compose = async (file, action, extra = [], timeoutMs = COMPOSE_TIMEOUT_MS) => {
    const resolved = await resolveComposeFile(file);
    const base = await composeCommand();
    return text(
      await execToText([...base, "-f", resolved, ...action, ...extra], timeoutMs)
    );
  };

  defineTool(
    server,
    "docker_compose_up",
    {
      title: "Bring up a compose stack",
      description:
        "Create and start the containers defined in a docker-compose file (compose up -d). Use this to create new containers: write or edit the compose file first with write_file/edit_file, then bring it up. Images, ports, mounts and every other setting come from the file, not from this call.",
      inputSchema: {
        path: composeFileArg,
        services: composeServicesArg,
        recreate: z
          .boolean()
          .optional()
          .describe("Force-recreate containers even if their config is unchanged."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: file, services, recreate }) =>
      compose(
        file,
        ["up", "-d", ...(recreate ? ["--force-recreate"] : [])],
        validateComposeServices(services)
      )
  );

  defineTool(
    server,
    "docker_compose_down",
    {
      title: "Take down a compose stack",
      description:
        "Stop and remove the containers defined in a docker-compose file (compose down). Named volumes are preserved — this never deletes data.",
      inputSchema: { path: composeFileArg },
      annotations: { destructiveHint: true },
    },
    // No --volumes, deliberately: a tool call should not be able to destroy
    // a database. Removing volumes stays an SSH job.
    async ({ path: file }) => compose(file, ["down"])
  );

  defineTool(
    server,
    "docker_compose_pull",
    {
      title: "Pull compose images",
      description:
        "Pull the images referenced by a docker-compose file without starting anything. Run before docker_compose_up to separate a slow download from the restart.",
      inputSchema: { path: composeFileArg, services: composeServicesArg },
      annotations: { readOnlyHint: true },
    },
    async ({ path: file, services }) =>
      compose(file, ["pull"], validateComposeServices(services))
  );

  defineTool(
    server,
    "docker_compose_ps",
    {
      title: "Compose stack status",
      description:
        "Show the containers belonging to a docker-compose file and their current state.",
      inputSchema: { path: composeFileArg },
      annotations: { readOnlyHint: true },
    },
    async ({ path: file }) => compose(file, ["ps"], [], EXEC_TIMEOUT_MS)
  );

  // --- Host health --------------------------------------------------------

  defineTool(
    server,
    "disk_usage",
    {
      title: "Disk usage",
      description: "Show filesystem disk usage on this server (df -h).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await execToText(["df", "-h"]))
  );

  defineTool(
    server,
    "memory_usage",
    {
      title: "Memory usage",
      description: "Show memory usage on this server (free -h).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await execToText(["free", "-h"]))
  );

  defineTool(
    server,
    "uptime",
    {
      title: "Server uptime",
      description: "Show this server's uptime and load averages.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await execToText(["uptime"]))
  );

  defineTool(
    server,
    "service_status",
    {
      title: "Systemd service status",
      description:
        "Show systemctl status for an allowlisted service on this server (for example nginx, docker, cloudflared).",
      inputSchema: {
        service: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/, "invalid service name")
          .describe("Systemd service name (must be on this server's allowlist)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ service }) => {
      const name = requireAllowlistedService(service);
      return text(await execToText(["systemctl", "status", name, "--no-pager"]));
    }
  );

  // --- Files --------------------------------------------------------------
  // Every one of these resolves through the ALLOWED_PATHS jail first, and all
  // six are disabled outright when ALLOWED_PATHS is unset.

  defineTool(
    server,
    "list_directory",
    {
      title: "List directory",
      description:
        "List the entries of a directory on this server (type, size, mtime, name).",
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const dir = await resolveAllowedPath(args.path);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const lines = [];
      for (const entry of entries.slice(0, 500)) {
        let detail;
        try {
          const st = await fsp.lstat(path.join(dir, entry.name));
          detail = `${String(st.size).padStart(10)}  ${st.mtime.toISOString()}  `;
        } catch {
          detail = `${"?".padStart(10)}  ${"?".padEnd(24)}  `;
        }
        const kind = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-";
        lines.push(`${kind} ${detail}${entry.name}`);
      }
      if (entries.length > 500) {
        lines.push(`... and ${entries.length - 500} more entries`);
      }
      return text(lines.join("\n") || "(empty directory)");
    }
  );

  defineTool(
    server,
    "read_file",
    {
      title: "Read file",
      description: `Read a text file on this server (truncated past ${MAX_FILE_BYTES} bytes).`,
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { file, size } = await resolveExistingFile(args.path);
      const fh = await fsp.open(file, "r");
      let content;
      try {
        const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        content = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
      const note =
        size > MAX_FILE_BYTES
          ? `\n\n[truncated: showing the first ${MAX_FILE_BYTES} of ${size} bytes]`
          : "";
      return text(content + note);
    }
  );

  defineTool(
    server,
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a text file on this server with the given content. The parent directory must already exist.",
      inputSchema: {
        path: pathArg,
        content: z
          .string()
          .max(MAX_FILE_BYTES, `content exceeds the ${MAX_FILE_BYTES}-byte limit`)
          .describe("Full file content to write"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const file = await resolveAllowedPath(args.path);
      const bytes = Buffer.byteLength(args.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        throw new ToolError(`content exceeds the ${MAX_FILE_BYTES}-byte limit`);
      }
      let existed = true;
      try {
        await fsp.stat(file);
      } catch {
        existed = false;
      }
      await fsp.writeFile(file, args.content, "utf8");
      return text(`${existed ? "Overwrote" : "Created"} ${file} (${bytes} bytes)`);
    }
  );

  defineTool(
    server,
    "edit_file",
    {
      title: "Edit file",
      description:
        "Edit a text file on this server by exact string replacement. old_string must match exactly once unless replace_all is set.",
      inputSchema: {
        path: pathArg,
        old_string: z.string().min(1).describe("Exact text to find"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence instead of requiring a unique match"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const { file, size } = await resolveExistingFile(args.path);
      if (size > MAX_FILE_BYTES) {
        throw new ToolError(`File exceeds the ${MAX_FILE_BYTES}-byte limit for editing`);
      }
      const content = await fsp.readFile(file, "utf8");
      const count = content.split(args.old_string).length - 1;
      if (count === 0) {
        throw new ToolError("old_string was not found in the file");
      }
      if (count > 1 && !args.replace_all) {
        throw new ToolError(
          `old_string occurs ${count} times — provide a longer unique string, or set replace_all`
        );
      }
      const updated = args.replace_all
        ? content.split(args.old_string).join(args.new_string)
        : content.replace(args.old_string, args.new_string);
      await fsp.writeFile(file, updated, "utf8");
      return text(`Replaced ${args.replace_all ? count : 1} occurrence(s) in ${file}`);
    }
  );

  // --- Scripts ------------------------------------------------------------

  defineTool(
    server,
    "check_script",
    {
      title: "Check script syntax",
      description:
        "Diagnose a script on this server without running it: bash -n / sh -n (plus shellcheck when installed) for shell, python3 -m py_compile for Python, node --check for JavaScript. The interpreter is detected from the shebang or file extension.",
      inputSchema: { path: pathArg },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { file } = await resolveExistingFile(args.path);
      const runner = await runnerFor(file);
      const checkers = {
        bash: [["bash", "-n", file]],
        sh: [["sh", "-n", file]],
        python3: [["python3", "-m", "py_compile", file]],
        node: [["node", "--check", file]],
      };
      const argvs = [...checkers[runner]];
      // shellcheck gives far better diagnostics than `bash -n` — use it when
      // it is installed, skip it quietly when it is not.
      if (runner === "bash" || runner === "sh") argvs.push(["shellcheck", file]);

      const sections = [];
      let allOk = true;
      for (const argv of argvs) {
        const r = await exec(argv);
        const header = `$ ${argv.join(" ")}`;
        if (r.missing) {
          sections.push(`${header}\n(${argv[0]} is not installed — skipped)`);
          continue;
        }
        if (r.timedOut) {
          sections.push(`${header}\n(timed out)`);
          allOk = false;
          continue;
        }
        const out = combinedOutput(r);
        if (r.code === 0) {
          sections.push(`${header}\n${out || "OK — no issues found"}`);
        } else {
          sections.push(`${header}\n${out || "(no output)"}\n(exit code ${r.code})`);
          allOk = false;
        }
      }
      const body = sections.join("\n\n");
      return allOk ? text(body) : failure(body);
    }
  );

  defineTool(
    server,
    "run_script",
    {
      title: "Run script",
      description:
        "Execute a script on this server (bash/sh/python3/node, detected from the shebang or extension) and return its exit code and output. Only script files inside ALLOWED_PATHS can be run — this is not a general shell.",
      inputSchema: {
        path: pathArg,
        args: z
          .array(z.string().max(256))
          .max(16)
          .optional()
          .describe("Arguments passed to the script (max 16, each under 256 characters)"),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Kill the script after this many seconds (default 30, max 120)"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const { file } = await resolveExistingFile(args.path);
      const runner = await runnerFor(file);
      const extra = (args.args ?? []).map((a) => {
        const s = String(a);
        if (s.includes("\0")) throw new ToolError("Script arguments must not contain null bytes");
        return s;
      });
      const seconds = Number.parseInt(args.timeout_seconds, 10);
      const timeoutMs =
        (Number.isNaN(seconds) ? 30 : Math.min(Math.max(seconds, 1), 120)) * 1000;

      const r = await exec([runner, file, ...extra], timeoutMs);
      if (r.missing) {
        return failure(`Interpreter "${runner}" is not installed on this server`);
      }
      const out = combinedOutput(r);
      if (r.timedOut) {
        return failure(`Script timed out after ${timeoutMs / 1000}s\n${out}`.trim());
      }
      const body = `exit code: ${r.code}\n${out || "(no output)"}`;
      return r.code === 0 ? text(body) : failure(body);
    }
  );
}
