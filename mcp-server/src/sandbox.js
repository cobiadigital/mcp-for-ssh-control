/**
 * The sandbox: every check that stands between a tool call and the machine.
 *
 * Three independent guarantees live here, and no tool may bypass them:
 *
 *   1. No arbitrary shell, ever. Commands are built as argv arrays and run
 *      through execFile with shell:false. There is no string interpolation
 *      into a command line anywhere in this codebase.
 *   2. Names are allowlisted. Container and unit names must match a strict
 *      shape *and* appear in ALLOWED_CONTAINERS / ALLOWED_SERVICES, so a
 *      typo in an allowlist still cannot smuggle option-like arguments.
 *   3. Paths are jailed. Every path is resolved with realpath and must land
 *      inside an ALLOWED_PATHS root, so neither `..` segments nor symlinks
 *      planted inside a root can escape it.
 */

import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  ALLOWED_COMPOSE_PATHS,
  ALLOWED_CONTAINERS,
  ALLOWED_PATHS,
  ALLOWED_SERVICES,
  EXEC_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
} from "./config.js";

/**
 * A rejection the caller is meant to read and correct — a name off the
 * allowlist, a path outside the roots, a malformed argument. Tool handlers
 * turn these into MCP tool errors; anything else is a bug and surfaces as a
 * generic internal error.
 */
export class ToolError extends Error {}

/**
 * Docker and systemd name shape. Anchored, and required to start with an
 * alphanumeric so a name can never be read as a command-line option.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/;

/**
 * A lone `*` opens the allowlist to every name of the right shape. The shape
 * check still runs — that is what stops a name from being read as a
 * command-line option — so `*` widens *which* containers the tools may name,
 * never what may be done to them.
 */
export const isWildcard = (allowlist) =>
  allowlist.length === 1 && allowlist[0] === "*";

/** How an allowlist reads in tool output and startup logs. */
export function describeAllowlist(allowlist, noun) {
  if (isWildcard(allowlist)) return `* (every ${noun} on this box)`;
  return allowlist.join(", ") || `(none allowlisted)`;
}

function requireAllowlisted(value, allowlist, noun, envVar) {
  const name = String(value ?? "");
  if (!NAME_RE.test(name)) {
    throw new ToolError(`Invalid ${noun} name: "${name}"`);
  }
  if (isWildcard(allowlist)) return name;
  if (!allowlist.includes(name)) {
    throw new ToolError(
      `${noun[0].toUpperCase()}${noun.slice(1)} "${name}" is not on this server's allowlist. Allowed: ${
        allowlist.join(", ") || `(none configured — set ${envVar})`
      }`
    );
  }
  return name;
}

export const requireAllowlistedContainer = (container) =>
  requireAllowlisted(container, ALLOWED_CONTAINERS, "container", "ALLOWED_CONTAINERS");

export const requireAllowlistedService = (service) =>
  requireAllowlisted(service, ALLOWED_SERVICES, "service", "ALLOWED_SERVICES");

/**
 * Resolve a caller-supplied path and enforce that it lives inside one of the
 * ALLOWED_PATHS roots. Both the target and each root go through realpath.
 *
 * For a target that does not exist yet (write_file creating a file) the parent
 * directory is resolved instead and must already exist — this keeps the check
 * honest without letting a write create directories outside the roots.
 */
export async function resolveAllowedPath(rawPath, roots = ALLOWED_PATHS, disabledHint = null) {
  if (roots.length === 0) {
    throw new ToolError(
      disabledHint ??
        "File and script tools are disabled on this server — set ALLOWED_PATHS (comma-separated directory roots) in the service env and restart."
    );
  }
  const p = String(rawPath ?? "");
  if (!path.isAbsolute(p) || p.includes("\0")) {
    throw new ToolError(`Path must be absolute: "${p}"`);
  }

  let real;
  try {
    real = await fsp.realpath(p);
  } catch {
    let realParent;
    try {
      realParent = await fsp.realpath(path.dirname(p));
    } catch {
      throw new ToolError(`Directory does not exist: ${path.dirname(p)}`);
    }
    real = path.join(realParent, path.basename(p));
  }

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      continue; // a configured root that isn't on disk simply matches nothing
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }

  throw new ToolError(
    `Path "${p}" is outside this server's allowed roots: ${roots.join(", ")}`
  );
}

/** Resolve to an existing regular file inside the roots. */
export async function resolveExistingFile(rawPath) {
  const file = await resolveAllowedPath(rawPath);
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new ToolError(`File not found: ${rawPath}`);
  }
  if (!st.isFile()) throw new ToolError(`Not a regular file: ${rawPath}`);
  return { file, size: st.size };
}

/** Turn common filesystem errno failures into readable tool errors. */
export function asToolError(e) {
  if (e instanceof ToolError) return e;
  if (e?.code === "ENOENT") return new ToolError(`No such file or directory: ${e.path ?? ""}`);
  if (e?.code === "EACCES") return new ToolError(`Permission denied: ${e.path ?? ""}`);
  if (e?.code === "EISDIR") return new ToolError(`Path is a directory, not a file: ${e.path ?? ""}`);
  if (e?.code === "ENOTDIR") return new ToolError(`Path is not a directory: ${e.path ?? ""}`);
  return e;
}

/**
 * Interpreters the script tools may invoke, keyed by shebang command and by
 * file extension. Restricting this set is what keeps run_script from becoming
 * a generic "execute any binary" primitive.
 */
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

/** Pick the interpreter for a script: shebang first, extension second. */
export async function runnerFor(file) {
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
      throw new ToolError(
        `Unsupported interpreter "${firstLine}" — supported: ${Object.keys(SHEBANG_RUNNERS).join(", ")}`
      );
    }
    return runner;
  }

  const runner = EXT_RUNNERS[path.extname(file).toLowerCase()];
  if (!runner) {
    throw new ToolError(
      `Cannot determine the interpreter for "${path.basename(file)}" — add a shebang line, or use one of: ${Object.keys(EXT_RUNNERS).join(", ")}`
    );
  }
  return runner;
}

/**
 * Run an argv array. Never resolves to a rejected promise: the result carries
 * whatever the process produced plus how it ended, because several of these
 * commands are useful precisely when they "fail" (`systemctl status` exits
 * non-zero for a stopped unit, `docker logs` writes to stderr).
 */
export function exec(argv, timeoutMs = EXEC_TIMEOUT_MS) {
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
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

/** stdout and stderr interleaved, trimmed — how tool output is presented. */
export function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

/**
 * Run an argv array and render it as tool text. Used by the diagnostic
 * commands, where the output matters more than the exit code.
 */
export async function execToText(argv, timeoutMs = EXEC_TIMEOUT_MS) {
  const r = await exec(argv, timeoutMs);
  const out = combinedOutput(r);
  if (r.missing) {
    throw new ToolError(`"${argv[0]}" is not installed on this server`);
  }
  if (r.timedOut) {
    return `Command timed out after ${timeoutMs / 1000}s\n${out}`.trim();
  }
  if (r.code !== 0 && out === "") {
    return `Command failed with exit code ${r.code} (no output)`;
  }
  return out || "(no output)";
}

// ---------------------------------------------------------------------------
// Docker Compose
// ---------------------------------------------------------------------------

const COMPOSE_FILE_RE = /\.ya?ml$/i;

/**
 * Resolve a compose file against ALLOWED_COMPOSE_PATHS — its own root list,
 * not the file tools' roots. Bringing a stack up is a heavier grant than
 * editing a script, because a compose file may request bind mounts and
 * privileged containers, so it takes a separate deliberate opt-in.
 */
export async function resolveComposeFile(rawPath) {
  const file = await resolveAllowedPath(
    rawPath,
    ALLOWED_COMPOSE_PATHS,
    "Compose tools are disabled on this server — set ALLOWED_COMPOSE_PATHS (comma-separated directory roots) in the service env and restart."
  );
  if (!COMPOSE_FILE_RE.test(file)) {
    throw new ToolError(`Not a compose file (expected .yml or .yaml): ${rawPath}`);
  }
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new ToolError(`Compose file not found: ${rawPath}`);
  }
  if (!st.isFile()) throw new ToolError(`Not a regular file: ${rawPath}`);
  return file;
}

/**
 * Compose ships two ways: as the `docker compose` CLI plugin (current) and as
 * the standalone `docker-compose` binary (older boxes). Probe once and cache,
 * so a box with only one of them still works without configuration.
 */
let composeBaseArgv = null;
export async function composeCommand() {
  if (composeBaseArgv) return composeBaseArgv;
  const plugin = await exec(["docker", "compose", "version"], 10_000);
  if (plugin.code === 0) {
    composeBaseArgv = ["docker", "compose"];
    return composeBaseArgv;
  }
  const standalone = await exec(["docker-compose", "version"], 10_000);
  if (standalone.code === 0) {
    composeBaseArgv = ["docker-compose"];
    return composeBaseArgv;
  }
  throw new ToolError(
    "Neither `docker compose` nor `docker-compose` is available on this server."
  );
}

/**
 * Compose service names named by a caller. Shape-checked only: they are
 * already scoped to one jailed compose file, and the check is what keeps a
 * name from being read as a command-line option.
 */
export function validateComposeServices(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError("services must be an array of strings");
  if (raw.length > 32) throw new ToolError("Too many services (max 32)");
  return raw.map((value) => {
    const name = String(value);
    if (!NAME_RE.test(name)) throw new ToolError(`Invalid compose service name: "${name}"`);
    return name;
  });
}
