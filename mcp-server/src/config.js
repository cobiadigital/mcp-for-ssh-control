/**
 * Configuration for the on-box MCP server, read once from the environment.
 *
 * Everything sensitive comes from the service's env file (see .env.example);
 * nothing is ever committed. The process refuses to start without a service
 * token, so an unauthenticated server cannot exist even by accident.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the .env sitting beside the service into process.env.
 *
 * systemd hands these over through `EnvironmentFile=`, but pm2 has no
 * equivalent and a bare `node src/index.js` has none either — so without this
 * the same .env that works under systemd leaves the process with no
 * credentials, and it exits reporting a missing service token. Reading the
 * file here makes all three launch methods behave the same.
 *
 * Variables already present in the environment always win, so systemd's
 * EnvironmentFile and an explicit `FOO=bar node src/index.js` both still
 * override the file rather than fighting it.
 */
function loadEnvFile() {
  const envPath = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    ".env"
  );
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env is fine — the environment may supply everything
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way systemd and dotenv do.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

const list = (value, fallback = "") =>
  String(value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Loopback only. The tunnel connects here; no inbound port is ever opened. */
export const HOST = "127.0.0.1";
export const PORT = Number.parseInt(process.env.PORT || "8787", 10);

/**
 * Identifies this box in tool output. Keep it aligned with the Server ID you
 * give the box in Cloudflare Access, because the portal namespaces every tool
 * as `{server_id}_{tool_name}`.
 */
export const SERVER_ID = process.env.SERVER_ID || "server";

/** The Cloudflare Access service token this server accepts. Required. */
export const ACCESS_CLIENT_ID = process.env.ACCESS_CLIENT_ID || "";
export const ACCESS_CLIENT_SECRET = process.env.ACCESS_CLIENT_SECRET || "";

/** Docker containers and systemd units the tools may name. */
export const ALLOWED_CONTAINERS = list(process.env.ALLOWED_CONTAINERS);
export const ALLOWED_SERVICES = list(
  process.env.ALLOWED_SERVICES,
  "nginx,docker,cloudflared"
);

/**
 * Absolute directory roots the file and script tools may touch. Empty (the
 * default) disables those six tools outright.
 */
export const ALLOWED_PATHS = list(process.env.ALLOWED_PATHS);

/**
 * Directory roots under which the docker_compose_* tools may act on a compose
 * file. Deliberately a separate list from ALLOWED_PATHS rather than a reuse
 * of it: a compose file can request bind mounts and privileged containers, so
 * bringing one up is a heavier grant than editing a script. Empty (the
 * default) disables the compose tools outright.
 */
export const ALLOWED_COMPOSE_PATHS = list(process.env.ALLOWED_COMPOSE_PATHS);

export const EXEC_TIMEOUT_MS = 30_000;
/** Compose pulls images and waits on healthchecks; 30s is not enough. */
export const COMPOSE_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Fail fast rather than start an unauthenticated server. Returns the list of
 * problems so the caller decides how loudly to complain.
 */
export function configErrors() {
  const errors = [];
  if (!ACCESS_CLIENT_ID || !ACCESS_CLIENT_SECRET) {
    errors.push(
      "ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET must be set (the Cloudflare Access service token)"
    );
  }
  if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
    errors.push(`PORT is not a valid port number: ${process.env.PORT}`);
  }
  for (const [name, roots] of [
    ["ALLOWED_PATHS", ALLOWED_PATHS],
    ["ALLOWED_COMPOSE_PATHS", ALLOWED_COMPOSE_PATHS],
  ]) {
    for (const root of roots) {
      if (!root.startsWith("/")) {
        errors.push(`${name} entries must be absolute paths: "${root}"`);
      }
    }
  }
  return errors;
}
