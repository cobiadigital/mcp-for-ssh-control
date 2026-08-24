/**
 * Configuration for the on-box MCP server, read once from the environment.
 *
 * Everything sensitive comes from the service's env file (see .env.example);
 * nothing is ever committed. The process refuses to start without a service
 * token, so an unauthenticated server cannot exist even by accident.
 */

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

export const EXEC_TIMEOUT_MS = 30_000;
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
  for (const root of ALLOWED_PATHS) {
    if (!root.startsWith("/")) {
      errors.push(`ALLOWED_PATHS entries must be absolute paths: "${root}"`);
    }
  }
  return errors;
}
