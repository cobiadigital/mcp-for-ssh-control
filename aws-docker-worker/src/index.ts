import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { missingConfig, type Env, type Props } from "./types";
import {
  parseServers,
  resolveTarget,
  serverArgDescription,
  type ServerTarget,
} from "./servers";

/**
 * How long we wait for an internal service (through its Cloudflare Tunnel)
 * before giving up. If the tunnel or the box itself is down, requests would
 * otherwise hang until the Workers runtime kills them — instead we abort and
 * return a readable MCP tool error.
 */
const INTERNAL_FETCH_TIMEOUT_MS = 20_000;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  // isError:true marks this as a tool-level failure; the model sees the
  // message and can relay it instead of the client throwing a protocol error.
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Forward one whitelisted command to the internal service on `target`. Each
 * service only understands `POST /run {command, args}` and requires the
 * Cloudflare Access service-token headers on every request.
 */
async function callInternal(
  target: ServerTarget,
  command: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  const url = `${target.url}/run`;
  // Diagnostic logging — visible in the Worker's real-time logs. Lets us see
  // whether the internal-service hop succeeds, errors, or times out without
  // having to guess from the MCP transport churn. The alias is included
  // because one Worker now fans out to several boxes.
  const startedAt = Date.now();
  console.log(`callInternal → [${target.alias}] ${command} POST ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Two copies of the same credentials, for the two auth layers:
        // Cloudflare Access validates the CF-Access-* pair at the edge and
        // CONSUMES those headers (the origin never sees them). The
        // X-Internal-* pair passes through Access untouched so the internal
        // service can re-check the token itself as defense in depth.
        "CF-Access-Client-Id": target.accessClientId,
        "CF-Access-Client-Secret": target.accessClientSecret,
        "X-Internal-Client-Id": target.accessClientId,
        "X-Internal-Client-Secret": target.accessClientSecret,
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout raises a DOMException named "TimeoutError";
    // anything else is a connection-level failure (tunnel down, DNS, TLS).
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    console.log(
      `callInternal ✗ [${target.alias}] ${command} ${isTimeout ? "TIMEOUT" : "FETCH-ERROR"} after ${Date.now() - startedAt}ms: ${e instanceof Error ? e.message : String(e)}`
    );
    return err(
      isTimeout
        ? `Timed out after ${INTERNAL_FETCH_TIMEOUT_MS / 1000}s waiting for the internal service on "${target.alias}". ` +
            `Its Cloudflare Tunnel or the server itself may be down.`
        : `Could not reach the internal service on "${target.alias}": ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const text = await res.text();
  console.log(
    `callInternal ← [${target.alias}] ${command} HTTP ${res.status} in ${Date.now() - startedAt}ms (${text.length} bytes)`
  );
  if (!res.ok) {
    // The internal service returns JSON {error} for auth/whitelist/exec
    // failures; Cloudflare Access returns an HTML block page on 403.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; detail?: string };
      detail = parsed.error ?? text;
      if (parsed.detail) detail += `\n${parsed.detail}`;
    } catch {
      if (text.includes("<html")) detail = "(blocked before reaching the internal service — check the Access service token policy)";
    }
    return err(`Internal service on "${target.alias}" returned HTTP ${res.status} for "${command}": ${detail}`);
  }

  try {
    const parsed = JSON.parse(text) as { output?: string };
    return ok(parsed.output ?? text);
  } catch {
    return ok(text);
  }
}

/**
 * The MCP server. Each authenticated session runs inside a Durable Object
 * (binding MCP_OBJECT in wrangler.toml). `this.props` carries the GitHub
 * identity stored by completeAuthorization() in github-handler.ts — by the
 * time a session reaches this class, OAuthProvider has already verified the
 * bearer token, and the OAuth flow only ever issues tokens to the single
 * allowlisted GitHub user.
 *
 * One Worker fronts a fleet: every tool takes an optional `server` argument
 * naming which configured machine to act on (see servers.ts). With a single
 * server configured the argument can be omitted, so an existing single-box
 * deployment behaves exactly as it did before.
 */
export class LightsailMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Remote Server Control",
    version: "1.1.0",
  });

  /**
   * Resolve the requested server and run one command on it. Configuration
   * problems come back as tool errors rather than exceptions so the model can
   * read them and, for an unknown alias, retry with a valid one.
   */
  private async run(
    server: string | undefined,
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<ToolResult> {
    // Vars/secrets are managed in the dashboard (Settings → Variables and
    // Secrets), so a fresh deploy can be missing them — say so explicitly.
    const missing = missingConfig(this.env);
    if (missing.length > 0) {
      return err(
        `Worker is not fully configured — set these in the Cloudflare dashboard ` +
          `(Worker → Settings → Variables and Secrets): ${missing.join(", ")}`
      );
    }

    const target = resolveTarget(this.env, server);
    if (!target.ok) return err(target.error);
    return callInternal(target.value, command, args);
  }

  async init() {
    // Read once per session: the Durable Object restarts on deploy, so a
    // configuration change is picked up with the next session anyway, and
    // this lets the `server` argument advertise the real aliases in its
    // schema instead of making the model call list_servers first.
    const config = parseServers(this.env);

    const serverArg = {
      server: z.string().optional().describe(serverArgDescription(config)),
    };

    const containerArg = {
      container: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "invalid container name")
        .describe("Container name (must be on the target server's allowlist)"),
    };

    this.server.registerTool(
      "list_servers",
      {
        title: "List servers",
        description:
          "List the servers this MCP server can control. Use an alias from here as the `server` argument of the other tools.",
        inputSchema: {},
      },
      async () => {
        if (!config.ok) return err(config.error);
        const lines = config.value.map(
          (t) => `${t.alias}\t${t.url}${t.description ? `\t${t.description}` : ""}`
        );
        return ok(
          `${config.value.length} server(s) configured (alias, internal URL, description):\n` +
            lines.join("\n")
        );
      }
    );

    this.server.registerTool(
      "docker_ps",
      {
        title: "List Docker containers",
        description:
          "List all Docker containers on the target server with their status and ports.",
        inputSchema: serverArg,
      },
      async ({ server }) => this.run(server, "docker_ps")
    );

    this.server.registerTool(
      "docker_logs",
      {
        title: "Tail Docker logs",
        description:
          "Tail the logs of an allowlisted Docker container on the target server.",
        inputSchema: {
          ...serverArg,
          ...containerArg,
          lines: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Number of log lines to return (default 50, max 1000)"),
        },
      },
      async ({ server, container, lines }) =>
        this.run(server, "docker_logs", { container, lines })
    );

    this.server.registerTool(
      "docker_restart",
      {
        title: "Restart Docker container",
        description:
          "Restart an allowlisted Docker container on the target server.",
        inputSchema: { ...serverArg, ...containerArg },
      },
      async ({ server, container }) =>
        this.run(server, "docker_restart", { container })
    );

    this.server.registerTool(
      "disk_usage",
      {
        title: "Disk usage",
        description: "Show filesystem disk usage on the target server (df -h).",
        inputSchema: serverArg,
      },
      async ({ server }) => this.run(server, "disk_usage")
    );

    this.server.registerTool(
      "memory_usage",
      {
        title: "Memory usage",
        description: "Show memory usage on the target server (free -h).",
        inputSchema: serverArg,
      },
      async ({ server }) => this.run(server, "memory_usage")
    );

    this.server.registerTool(
      "service_status",
      {
        title: "Systemd service status",
        description:
          "Show systemctl status for an allowlisted service on the target server (e.g. nginx, docker, cloudflared).",
        inputSchema: {
          ...serverArg,
          service: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/, "invalid service name")
            .describe("Systemd service name (must be on the target server's allowlist)"),
        },
      },
      async ({ server, service }) => this.run(server, "service_status", { service })
    );

    this.server.registerTool(
      "uptime",
      {
        title: "Server uptime",
        description: "Show the target server's uptime and load averages.",
        inputSchema: serverArg,
      },
      async ({ server }) => this.run(server, "uptime")
    );

    // --- File and script tools ---------------------------------------------
    // These only work inside the directory roots configured on each box via
    // ALLOWED_PATHS; anything outside (or any path when ALLOWED_PATHS is
    // unset) is rejected by that server's internal service.

    const pathArg = z
      .string()
      .startsWith("/", "path must be absolute")
      .describe(
        "Absolute path on the target server. Must be inside one of that server's ALLOWED_PATHS roots."
      );

    this.server.registerTool(
      "list_directory",
      {
        title: "List directory",
        description:
          "List the entries of a directory on the target server (type, size, mtime, name).",
        inputSchema: { ...serverArg, path: pathArg },
      },
      async ({ server, path }) => this.run(server, "list_directory", { path })
    );

    this.server.registerTool(
      "read_file",
      {
        title: "Read file",
        description:
          "Read a text file on the target server (truncated past 512KB).",
        inputSchema: { ...serverArg, path: pathArg },
      },
      async ({ server, path }) => this.run(server, "read_file", { path })
    );

    this.server.registerTool(
      "write_file",
      {
        title: "Write file",
        description:
          "Create or overwrite a text file on the target server with the given content (max 512KB). The parent directory must already exist.",
        inputSchema: {
          ...serverArg,
          path: pathArg,
          content: z.string().describe("Full file content to write"),
        },
      },
      async ({ server, path, content }) =>
        this.run(server, "write_file", { path, content })
    );

    this.server.registerTool(
      "edit_file",
      {
        title: "Edit file",
        description:
          "Edit a text file on the target server by exact string replacement. old_string must match exactly once unless replace_all is set.",
        inputSchema: {
          ...serverArg,
          path: pathArg,
          old_string: z.string().min(1).describe("Exact text to find"),
          new_string: z.string().describe("Replacement text"),
          replace_all: z
            .boolean()
            .optional()
            .describe("Replace every occurrence instead of requiring a unique match"),
        },
      },
      async ({ server, path, old_string, new_string, replace_all }) =>
        this.run(server, "edit_file", { path, old_string, new_string, replace_all })
    );

    this.server.registerTool(
      "check_script",
      {
        title: "Check script syntax",
        description:
          "Diagnose a script on the target server without running it: bash -n / sh -n (plus shellcheck when installed) for shell, python3 -m py_compile for Python, node --check for JavaScript. Interpreter is detected from the shebang or file extension.",
        inputSchema: { ...serverArg, path: pathArg },
      },
      async ({ server, path }) => this.run(server, "check_script", { path })
    );

    this.server.registerTool(
      "run_script",
      {
        title: "Run script",
        description:
          "Execute a script on the target server (bash/sh/python3/node, detected from shebang or extension) and return its exit code and output. Use for diagnosing script behavior.",
        inputSchema: {
          ...serverArg,
          path: pathArg,
          args: z
            .array(z.string().max(256))
            .max(16)
            .optional()
            .describe("Arguments passed to the script (max 16, each under 256 chars)"),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(120)
            .optional()
            .describe("Kill the script after this many seconds (default 30, max 120)"),
        },
      },
      async ({ server, path, args, timeout_seconds }) =>
        this.run(server, "run_script", { path, args, timeout_seconds })
    );
  }
}

/**
 * OAuthProvider is the Worker's actual entrypoint. It splits traffic three ways:
 *  - /mcp and /sse are the MCP endpoints; requests must carry a bearer token
 *    previously issued by this provider, and are then routed into the
 *    LightsailMCP Durable Object with the grant's props attached.
 *  - /authorize, /token, /register implement the OAuth server that MCP
 *    clients (Claude apps) talk to. Client registration is dynamic (RFC 7591),
 *    which is what lets claude.ai add this server as a custom connector.
 *  - Everything else falls through to GitHubHandler, which runs the human
 *    half of the flow (GitHub login + single-user allowlist check).
 */
export default new OAuthProvider({
  apiHandlers: {
    // Streamable HTTP is the current MCP transport; SSE kept for older clients.
    "/mcp": LightsailMCP.serve("/mcp", { binding: "MCP_OBJECT" }),
    "/sse": LightsailMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }),
  },
  defaultHandler: GitHubHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
