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

export function requireAllowlistedContainer(container) {
  const name = String(container ?? "");
  if (!NAME_RE.test(name)) {
    throw new ToolError(`Invalid container name: "${name}"`);
  }
  if (!ALLOWED_CONTAINERS.includes(name)) {
    throw new ToolError(
      `Container "${name}" is not on this server's allowlist. Allowed: ${
        ALLOWED_CONTAINERS.join(", ") || "(none configured — set ALLOWED_CONTAINERS)"
      }`
    );
  }
  return name;
}

export function requireAllowlistedService(service) {
  const name = String(service ?? "");
  if (!NAME_RE.test(name)) {
    throw new ToolError(`Invalid service name: "${name}"`);
  }
  if (!ALLOWED_SERVICES.includes(name)) {
    throw new ToolError(
      `Service "${name}" is not on this server's allowlist. Allowed: ${ALLOWED_SERVICES.join(", ")}`
    );
  }
  return name;
}

/**
 * Resolve a caller-supplied path and enforce that it lives inside one of the
 * ALLOWED_PATHS roots. Both the target and each root go through realpath.
 *
 * For a target that does not exist yet (write_file creating a file) the parent
 * directory is resolved instead and must already exist — this keeps the check
 * honest without letting a write create directories outside the roots.
 */
export async function resolveAllowedPath(rawPath) {
  if (ALLOWED_PATHS.length === 0) {
    throw new ToolError(
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

  for (const root of ALLOWED_PATHS) {
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      continue; // a configured root that isn't on disk simply matches nothing
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }

  throw new ToolError(
    `Path "${p}" is outside this server's allowed roots: ${ALLOWED_PATHS.join(", ")}`
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
