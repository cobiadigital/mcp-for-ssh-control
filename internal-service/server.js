/**
 * Internal command service for the Lightsail box.
 *
 * Listens on 127.0.0.1 only — it is reachable exclusively through the
 * Cloudflare Tunnel (cloudflared makes an outbound connection; no inbound
 * port is ever opened in the Lightsail firewall).
 *
 * Security model:
 *   1. Every request must carry CF-Access-Client-Id / CF-Access-Client-Secret
 *      headers matching the Cloudflare Access service token (checked with a
 *      timing-safe comparison). Cloudflare Access also validates the token at
 *      the edge; this local check is defense in depth.
 *   2. There is no arbitrary shell execution. Only the named commands in the
 *      COMMANDS map below can run, each built as an argv array and executed
 *      with execFile (no shell interpretation, ever).
 *   3. Container and service names are validated against explicit allowlists
 *      (ALLOWED_CONTAINERS / ALLOWED_SERVICES env vars) before execution.
 *   4. File tools (read/write/edit/list) and script tools (check/run) only
 *      operate inside the directory roots listed in ALLOWED_PATHS. Paths are
 *      resolved through realpath so `..` and symlinks can't escape the roots.
 *      If ALLOWED_PATHS is unset, all file/script tools are disabled.
 */

"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");

// ---------------------------------------------------------------------------
// Configuration (env vars, with safe defaults)
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = "127.0.0.1"; // never expose beyond loopback — the tunnel connects here

// Cloudflare Access service token this service accepts. REQUIRED.
const ACCESS_CLIENT_ID = process.env.ACCESS_CLIENT_ID || "";
const ACCESS_CLIENT_SECRET = process.env.ACCESS_CLIENT_SECRET || "";

// Comma-separated allowlists. Adjust to the actual names on this box, e.g.
//   ALLOWED_CONTAINERS=wordpress,wordpress-db,odoo,odoo-db,wanderer,crm
//   ALLOWED_SERVICES=nginx,docker,cloudflared
const ALLOWED_CONTAINERS = (process.env.ALLOWED_CONTAINERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || "nginx,docker,cloudflared")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Comma-separated absolute directory roots the file/script tools may touch,
// e.g. ALLOWED_PATHS=/home/ubuntu/scripts,/home/ubuntu/sites
// Empty (the default) disables read_file/write_file/edit_file/list_directory/
// check_script/run_script entirely.
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 512 * 1024; // read/write size cap for the file tools

if (!ACCESS_CLIENT_ID || !ACCESS_CLIENT_SECRET) {
  console.error(
    "FATAL: ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET must be set " +
      "(the Cloudflare Access service token). Refusing to start without auth."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth middleware — timing-safe comparison of the Access service token
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch; hash first so comparison is
  // always constant-length and length differences don't leak timing.
  const ha = crypto.createHash("sha256").update(ba).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAccessToken(req, res, next) {
  // Requests arriving through Cloudflare Access have had their
  // CF-Access-Client-Id/Secret headers consumed at the edge (Access
  // validates them and forwards a JWT instead), so the Worker sends a
  // second copy in X-Internal-Client-Id/Secret which pass through
  // untouched. Direct/local calls (smoke test on the box) can use either
  // pair. Both compare against the same service token values.
  const id =
    req.get("CF-Access-Client-Id") || req.get("X-Internal-Client-Id") || "";
  const secret =
    req.get("CF-Access-Client-Secret") || req.get("X-Internal-Client-Secret") || "";
  const idOk = timingSafeEqual(id, ACCESS_CLIENT_ID);
  const secretOk = timingSafeEqual(secret, ACCESS_CLIENT_SECRET);
  if (!idOk || !secretOk) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing Access service token" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Argument validators
// ---------------------------------------------------------------------------

// Docker/systemd name shapes — a second line of defense behind the allowlist,
// so even an allowlist typo can't smuggle option-like arguments ("-f", "--x").
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/;

function requireAllowlistedContainer(args) {
  const container = String(args.container || "");
  if (!NAME_RE.test(container)) {
    throw new HttpError(400, `Invalid container name: "${container}"`);
  }
  if (!ALLOWED_CONTAINERS.includes(container)) {
    throw new HttpError(
      403,
      `Container "${container}" is not on the allowlist. Allowed: ${ALLOWED_CONTAINERS.join(", ") || "(none configured)"}`
    );
  }
  return container;
}

function requireAllowlistedService(args) {
  const service = String(args.service || "");
  if (!NAME_RE.test(service)) {
    throw new HttpError(400, `Invalid service name: "${service}"`);
  }
  if (!ALLOWED_SERVICES.includes(service)) {
    throw new HttpError(
      403,
      `Service "${service}" is not on the allowlist. Allowed: ${ALLOWED_SERVICES.join(", ")}`
    );
  }
  return service;
}

function clampLines(args) {
  const n = Number.parseInt(args.lines, 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(Math.max(n, 1), 1000);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve a client-supplied path and enforce that it lives inside one of the
 * ALLOWED_PATHS roots. Both the target and the roots go through realpath, so
 * neither `..` segments nor symlinks planted inside a root can escape it.
 * For not-yet-existing targets (write_file creating a file) the parent
 * directory is resolved instead — it must already exist.
 */
async function resolveAllowedPath(rawPath) {
  if (ALLOWED_PATHS.length === 0) {
    throw new HttpError(
      403,
      "File tools are disabled — set ALLOWED_PATHS (comma-separated directory roots) in the service env and restart."
    );
  }
  const p = String(rawPath || "");
  if (!path.isAbsolute(p) || p.includes("\0")) {
    throw new HttpError(400, `Path must be absolute: "${p}"`);
  }
  let real;
  try {
    real = await fsp.realpath(p);
  } catch {
    let realParent;
    try {
      realParent = await fsp.realpath(path.dirname(p));
    } catch {
      throw new HttpError(400, `Directory does not exist: ${path.dirname(p)}`);
    }
    real = path.join(realParent, path.basename(p));
  }
  for (const root of ALLOWED_PATHS) {
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      continue; // configured root doesn't exist on disk — skip it
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  throw new HttpError(
    403,
    `Path "${p}" is outside the allowed roots: ${ALLOWED_PATHS.join(", ")}`
  );
}

// Interpreters the script tools will invoke, keyed by shebang/extension.
// Anything else is rejected — this keeps run_script from becoming a generic
// "execute any binary" primitive.
const SHEBANG_RUNNERS = {
  bash: "bash",
  sh: "sh",
  dash: "sh",
  python3: "python3",
  python: "python3",
  node: "node",
  nodejs: "node",
};
const EXT_RUNNERS = {
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python3",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
};

/** Pick the interpreter for a script: shebang first, file extension second. */
async function runnerFor(file) {
  const fh = await fsp.open(file, "r");
  let firstLine = "";
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await fh.read(buf, 0, 256, 0);
    firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
  } finally {
    await fh.close();
  }
  if (firstLine.startsWith("#!")) {
    const parts = firstLine.slice(2).trim().split(/\s+/);
    let cmd = path.basename(parts[0] || "");
    if (cmd === "env") cmd = path.basename(parts[1] || "");
    const runner = SHEBANG_RUNNERS[cmd];
    if (!runner) {
      throw new HttpError(
        400,
        `Unsupported interpreter "${firstLine}" — supported: ${Object.keys(SHEBANG_RUNNERS).join(", ")}`
      );
    }
    return runner;
  }
  const runner = EXT_RUNNERS[path.extname(file).toLowerCase()];
  if (!runner) {
    throw new HttpError(
      400,
      `Cannot determine interpreter for "${path.basename(file)}" — add a shebang line or use one of: ${Object.keys(EXT_RUNNERS).join(", ")}`
    );
  }
  return runner;
}

/** Must be an existing regular file inside the allowed roots. */
async function resolveExistingFile(rawPath) {
  const file = await resolveAllowedPath(rawPath);
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, `File not found: ${rawPath}`);
  }
  if (!st.isFile()) throw new HttpError(400, `Not a regular file: ${rawPath}`);
  return { file, size: st.size };
}

function translateFsError(e) {
  if (e instanceof HttpError) return e;
  if (e && e.code === "ENOENT") return new HttpError(404, e.message);
  if (e && e.code === "EACCES") return new HttpError(403, e.message);
  if (e && (e.code === "EISDIR" || e.code === "ENOTDIR")) return new HttpError(400, e.message);
  return e;
}

// ---------------------------------------------------------------------------
// The COMMANDS map — the *only* operations this service can perform.
// Each entry returns an argv array for execFile. No shell, no interpolation.
// ---------------------------------------------------------------------------

const COMMANDS = {
  docker_ps: () => [
    "docker", "ps", "-a",
    "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}",
  ],
  docker_logs: (args) => {
    const container = requireAllowlistedContainer(args);
    const lines = clampLines(args);
    return ["docker", "logs", "--tail", String(lines), container];
  },
  docker_restart: (args) => {
    const container = requireAllowlistedContainer(args);
    return ["docker", "restart", container];
  },
  disk_usage: () => ["df", "-h"],
  memory_usage: () => ["free", "-h"],
  service_status: (args) => {
    const service = requireAllowlistedService(args);
    return ["systemctl", "status", service, "--no-pager"];
  },
  uptime: () => ["uptime"],
};

function runArgv(argv, timeoutMs = EXEC_TIMEOUT_MS) {
  const [cmd, ...cmdArgs] = argv;
  return new Promise((resolve) => {
    execFile(
      cmd,
      cmdArgs,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        // `docker logs` writes to stderr; `systemctl status` exits non-zero
        // for stopped services. Both are still useful output, so return
        // whatever we got and note the failure instead of erroring out.
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (error && error.killed) {
          resolve({ ok: false, output: `Command timed out after ${timeoutMs / 1000}s\n${combined}` });
        } else if (error && combined === "") {
          resolve({ ok: false, output: `Command failed: ${error.message}` });
        } else {
          resolve({ ok: true, output: combined || "(no output)" });
        }
      }
    );
  });
}

/**
 * Like runArgv but keeps the exit code and distinguishes "the interpreter
 * itself is missing" (ENOENT) — check_script needs both to report cleanly.
 */
function execArgv(argv, timeoutMs = EXEC_TIMEOUT_MS) {
  const [cmd, ...cmdArgs] = argv;
  return new Promise((resolve) => {
    execFile(
      cmd,
      cmdArgs,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          missing: Boolean(error && error.code === "ENOENT"),
          timedOut: Boolean(error && error.killed),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// The HANDLERS map — file and script operations. Same contract as COMMANDS
// (name in, {ok, output} out) but implemented directly instead of via argv.
// Every path goes through resolveAllowedPath / resolveExistingFile first.
// ---------------------------------------------------------------------------

function validateScriptArgs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "args must be an array of strings");
  if (raw.length > 16) throw new HttpError(400, "Too many script arguments (max 16)");
  return raw.map((a) => {
    const s = String(a);
    if (s.length > 256 || s.includes("\0")) {
      throw new HttpError(400, "Script arguments must be under 256 characters");
    }
    return s;
  });
}

const HANDLERS = {
  list_directory: async (args) => {
    const dir = await resolveAllowedPath(args.path);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const lines = [];
    for (const entry of entries.slice(0, 500)) {
      let detail = "";
      try {
        const st = await fsp.lstat(path.join(dir, entry.name));
        detail = `${String(st.size).padStart(10)}  ${st.mtime.toISOString()}  `;
      } catch {
        detail = `${"?".padStart(10)}  ${"?".padEnd(24)}  `;
      }
      const kind = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-";
      lines.push(`${kind} ${detail}${entry.name}`);
    }
    if (entries.length > 500) lines.push(`... and ${entries.length - 500} more entries`);
    return { ok: true, output: lines.join("\n") || "(empty directory)" };
  },

  read_file: async (args) => {
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
        ? `\n\n[truncated: showing first ${MAX_FILE_BYTES} of ${size} bytes]`
        : "";
    return { ok: true, output: content + note };
  },

  write_file: async (args) => {
    const file = await resolveAllowedPath(args.path);
    if (typeof args.content !== "string") {
      throw new HttpError(400, "content must be a string");
    }
    if (Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) {
      throw new HttpError(400, `content exceeds the ${MAX_FILE_BYTES}-byte limit`);
    }
    let existed = true;
    try {
      await fsp.stat(file);
    } catch {
      existed = false;
    }
    await fsp.writeFile(file, args.content, "utf8");
    return {
      ok: true,
      output: `${existed ? "Overwrote" : "Created"} ${file} (${Buffer.byteLength(args.content, "utf8")} bytes)`,
    };
  },

  edit_file: async (args) => {
    const { file, size } = await resolveExistingFile(args.path);
    if (size > MAX_FILE_BYTES) {
      throw new HttpError(400, `File exceeds the ${MAX_FILE_BYTES}-byte limit for editing`);
    }
    const oldStr = args.old_string;
    const newStr = args.new_string;
    if (typeof oldStr !== "string" || oldStr === "" || typeof newStr !== "string") {
      throw new HttpError(400, "old_string (non-empty) and new_string are required");
    }
    const content = await fsp.readFile(file, "utf8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      throw new HttpError(400, "old_string not found in the file");
    }
    if (count > 1 && !args.replace_all) {
      throw new HttpError(
        400,
        `old_string occurs ${count} times — provide a longer unique string, or set replace_all`
      );
    }
    const updated = args.replace_all
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    await fsp.writeFile(file, updated, "utf8");
    return {
      ok: true,
      output: `Replaced ${args.replace_all ? count : 1} occurrence(s) in ${file}`,
    };
  },

  check_script: async (args) => {
    const { file } = await resolveExistingFile(args.path);
    const runner = await runnerFor(file);
    const checkers = {
      bash: [["bash", "-n", file]],
      sh: [["sh", "-n", file]],
      python3: [["python3", "-m", "py_compile", file]],
      node: [["node", "--check", file]],
    };
    const argvs = checkers[runner];
    // shellcheck gives far better shell diagnostics than bash -n — use it
    // when installed, skip quietly when not.
    if (runner === "bash" || runner === "sh") {
      argvs.push(["shellcheck", file]);
    }
    const sections = [];
    let allOk = true;
    for (const argv of argvs) {
      const r = await execArgv(argv);
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
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      if (r.code === 0) {
        sections.push(`${header}\n${out || "OK — no issues found"}`);
      } else {
        sections.push(`${header}\n${out || "(no output)"}\n(exit code ${r.code})`);
        allOk = false;
      }
    }
    return { ok: allOk, output: sections.join("\n\n") };
  },

  run_script: async (args) => {
    const { file } = await resolveExistingFile(args.path);
    const runner = await runnerFor(file);
    const extra = validateScriptArgs(args.args);
    const seconds = Number.parseInt(args.timeout_seconds, 10);
    const timeoutMs =
      (Number.isNaN(seconds) ? 30 : Math.min(Math.max(seconds, 1), 120)) * 1000;
    const r = await execArgv([runner, file, ...extra], timeoutMs);
    if (r.missing) {
      return { ok: false, output: `Interpreter "${runner}" is not installed on the server` };
    }
    const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    if (r.timedOut) {
      return { ok: false, output: `Script timed out after ${timeoutMs / 1000}s\n${out}` };
    }
    return {
      ok: r.code === 0,
      output: `exit code: ${r.code}\n${out || "(no output)"}`,
    };
  },
};

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(requireAccessToken); // auth first — unauthenticated requests never reach the parser
// 1mb (up from 16kb) so write_file/edit_file bodies fit; MAX_FILE_BYTES still
// caps the actual file content.
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, commands: [...Object.keys(COMMANDS), ...Object.keys(HANDLERS)] });
});

app.post("/run", async (req, res) => {
  const { command, args = {} } = req.body || {};

  try {
    if (Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
      const argv = COMMANDS[command](args); // validation happens here (allowlists, shapes)
      console.log(`[${new Date().toISOString()}] run ${command}: ${argv.join(" ")}`);
      return res.json(await runArgv(argv));
    }
    if (Object.prototype.hasOwnProperty.call(HANDLERS, command)) {
      // Log the target path but never file content.
      console.log(`[${new Date().toISOString()}] run ${command}: ${args.path ?? ""}`);
      return res.json(await HANDLERS[command](args));
    }
  } catch (e) {
    const err = translateFsError(e);
    const status = err instanceof HttpError ? err.status : 400;
    return res.status(status).json({ error: err.message });
  }

  return res.status(400).json({
    error: `Unknown command "${command}". Available: ${[...Object.keys(COMMANDS), ...Object.keys(HANDLERS)].join(", ")}`,
  });
});

// JSON body parse errors and anything else unexpected.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? "Internal error" : err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`lightsail-mcp internal service listening on http://${HOST}:${PORT}`);
  console.log(`Allowed containers: ${ALLOWED_CONTAINERS.join(", ") || "(none — set ALLOWED_CONTAINERS)"}`);
  console.log(`Allowed services:   ${ALLOWED_SERVICES.join(", ")}`);
  console.log(`Allowed paths:      ${ALLOWED_PATHS.join(", ") || "(none — file/script tools disabled; set ALLOWED_PATHS)"}`);
});
