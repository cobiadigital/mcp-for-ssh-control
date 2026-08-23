import type { Env } from "./types";

/**
 * A single machine this Worker can control.
 *
 * One Worker fronts a fleet: every target is a separate internal service
 * (its own Cloudflare Tunnel hostname), reached with a Cloudflare Access
 * service token. Tokens default to the Worker-wide ACCESS_CLIENT_ID /
 * ACCESS_CLIENT_SECRET secrets and can be overridden per server.
 */
export type ServerTarget = {
  alias: string;
  url: string;
  description?: string;
  accessClientId: string;
  accessClientSecret: string;
};

export type Resolution<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Alias used when the fleet is described by the legacy single-server
 * INTERNAL_SERVICE_URL variable instead of SERVERS. With only one target the
 * alias never has to be typed, so its exact value rarely surfaces.
 */
export const DEFAULT_SERVER_ALIAS = "default";

// Aliases are what the model types into the `server` argument, so keep them
// short and shell-safe rather than accepting arbitrary JSON keys.
const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s === "" ? undefined : s;
}

/**
 * Turn one SERVERS entry into a target. Entries are either a bare URL string
 * or an object with `url` plus optional `description` and per-server Access
 * credentials. Returns an error string (not a throw) so the caller can hand
 * the message straight back to the model.
 */
function toTarget(env: Env, alias: string, entry: unknown): ServerTarget | string {
  let rawUrl: unknown;
  let description: unknown;
  let clientId: unknown;
  let clientSecret: unknown;

  if (typeof entry === "string") {
    rawUrl = entry;
  } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const fields = entry as Record<string, unknown>;
    rawUrl = fields.url;
    description = fields.description;
    clientId = fields.access_client_id;
    clientSecret = fields.access_client_secret;
  } else {
    return `Server "${alias}" in SERVERS must be a URL string or an object with a "url" property.`;
  }

  const url = trimmed(rawUrl);
  if (!url) return `Server "${alias}" in SERVERS is missing a "url".`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Server "${alias}" in SERVERS has an invalid url ${JSON.stringify(url)}.`;
  }
  // Same rule as the single-server setup: plain http doesn't route through the
  // Cloudflare Tunnel, and the tool calls 404 in a way that's hard to read.
  if (parsed.protocol !== "https:") {
    return `Server "${alias}" must use an https:// url — plain http does not route through the Cloudflare Tunnel.`;
  }

  const accessClientId = trimmed(clientId) ?? trimmed(env.ACCESS_CLIENT_ID);
  const accessClientSecret = trimmed(clientSecret) ?? trimmed(env.ACCESS_CLIENT_SECRET);
  if (!accessClientId || !accessClientSecret) {
    return (
      `Server "${alias}" has no Cloudflare Access service token — set ACCESS_CLIENT_ID ` +
      `and ACCESS_CLIENT_SECRET as Worker secrets, or give this server its own ` +
      `"access_client_id" / "access_client_secret" inside SERVERS.`
    );
  }

  return {
    alias,
    // Trailing slashes would double up when we append /run.
    url: url.replace(/\/+$/, ""),
    description: trimmed(description),
    accessClientId,
    accessClientSecret,
  };
}

/**
 * Read the fleet out of the dashboard-managed configuration.
 *
 * Preferred form is SERVERS, a JSON object keyed by alias:
 *
 *   {"lightsail": "https://lightsail-internal.example.com",
 *    "aws-docker": {"url": "https://aws-docker-internal.example.com",
 *                   "description": "Docker host"}}
 *
 * If SERVERS is absent we fall back to the original single-server
 * INTERNAL_SERVICE_URL variable, so an existing deployment keeps working
 * untouched after this Worker is updated.
 */
export function parseServers(env: Env): Resolution<ServerTarget[]> {
  const raw = trimmed(env.SERVERS);

  if (!raw) {
    const url = trimmed(env.INTERNAL_SERVICE_URL);
    if (!url) {
      return {
        ok: false,
        error:
          `No servers are configured — set SERVERS (a JSON object mapping an alias to each ` +
          `server) or INTERNAL_SERVICE_URL (single server) in the Cloudflare dashboard under ` +
          `Worker → Settings → Variables and Secrets.`,
      };
    }
    const target = toTarget(env, DEFAULT_SERVER_ALIAS, url);
    if (typeof target !== "string") return { ok: true, value: [target] };
    // toTarget phrases its errors in terms of a SERVERS entry; on this path
    // there is no SERVERS, so name the variable the user actually set.
    return {
      ok: false,
      error: target
        .replace(`Server "${DEFAULT_SERVER_ALIAS}" in SERVERS`, "INTERNAL_SERVICE_URL")
        .replace(`Server "${DEFAULT_SERVER_ALIAS}"`, "INTERNAL_SERVICE_URL"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error:
        `SERVERS is not valid JSON (${e instanceof Error ? e.message : String(e)}). Expected ` +
        `{"alias": "https://host", ...} or {"alias": {"url": "https://host"}, ...}.`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `SERVERS must be a JSON object, e.g. {"lightsail": "https://lightsail-internal.example.com"}.`,
    };
  }

  const targets: ServerTarget[] = [];
  for (const [alias, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALIAS_PATTERN.test(alias)) {
      return {
        ok: false,
        error:
          `SERVERS contains an invalid alias ${JSON.stringify(alias)} — use letters, digits, ` +
          `"-" or "_", starting with a letter or digit, up to 32 characters.`,
      };
    }
    const target = toTarget(env, alias, entry);
    if (typeof target === "string") return { ok: false, error: target };
    targets.push(target);
  }
  if (targets.length === 0) {
    return { ok: false, error: `SERVERS is an empty object — add at least one server.` };
  }
  return { ok: true, value: targets };
}

export function aliasList(targets: ServerTarget[]): string {
  return targets.map((t) => t.alias).join(", ");
}

/**
 * Pick the target for one tool call. `requested` is the tool's optional
 * `server` argument; it may be omitted only when the fleet has a single
 * member, which is what keeps single-server deployments call-compatible.
 */
export function resolveTarget(
  env: Env,
  requested: string | undefined
): Resolution<ServerTarget> {
  const config = parseServers(env);
  if (!config.ok) return config;
  const targets = config.value;

  const wanted = trimmed(requested);
  if (!wanted) {
    if (targets.length === 1) return { ok: true, value: targets[0] };
    return {
      ok: false,
      error:
        `This MCP server controls ${targets.length} machines — pass "server" with one of: ` +
        `${aliasList(targets)}.`,
    };
  }

  const match = targets.find((t) => t.alias.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    return { ok: false, error: `Unknown server "${wanted}". Configured servers: ${aliasList(targets)}.` };
  }
  return { ok: true, value: match };
}

/**
 * Description for the shared `server` argument. Built from the live
 * configuration so the model sees the actual aliases in the tool schema
 * instead of having to call list_servers first.
 */
export function serverArgDescription(config: Resolution<ServerTarget[]>): string {
  if (!config.ok) return `Alias of the target server (server configuration is currently invalid).`;
  const targets = config.value;
  if (targets.length === 1) {
    return `Alias of the target server. Optional — "${targets[0].alias}" is the only configured server.`;
  }
  const described = targets
    .map((t) => (t.description ? `${t.alias} (${t.description})` : t.alias))
    .join(", ");
  return `Alias of the target server. Required — one of: ${described}.`;
}
