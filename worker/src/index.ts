import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { missingConfig, type Env, type Props } from "./types";

/**
 * How long we wait for the internal service (through the Cloudflare Tunnel)
 * before giving up. If the tunnel or the Lightsail box is down, requests
 * would otherwise hang until the Workers runtime kills them — instead we
 * abort and return a readable MCP tool error.
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
 * Forward one whitelisted command to the internal service on the Lightsail
 * box. The service only understands `POST /run {command, args}` and requires
 * the Cloudflare Access service-token headers on every request.
 */
async function callInternal(
  env: Env,
  command: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  // Vars/secrets are managed in the dashboard (Settings → Variables and
  // Secrets), so a fresh deploy can be missing them — say so explicitly.
  const missing = missingConfig(env);
  if (missing.length > 0) {
    return err(
      `Worker is not fully configured — set these in the Cloudflare dashboard ` +
        `(Worker → Settings → Variables and Secrets): ${missing.join(", ")}`
    );
  }

  const url = `${env.INTERNAL_SERVICE_URL.replace(/\/$/, "")}/run`;
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
        "CF-Access-Client-Id": env.ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET,
        "X-Internal-Client-Id": env.ACCESS_CLIENT_ID,
        "X-Internal-Client-Secret": env.ACCESS_CLIENT_SECRET,
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout raises a DOMException named "TimeoutError";
    // anything else is a connection-level failure (tunnel down, DNS, TLS).
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    return err(
      isTimeout
        ? `Timed out after ${INTERNAL_FETCH_TIMEOUT_MS / 1000}s waiting for the Lightsail internal service. ` +
            `The Cloudflare Tunnel or the server itself may be down.`
        : `Could not reach the Lightsail internal service: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const text = await res.text();
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
    return err(`Internal service returned HTTP ${res.status} for "${command}": ${detail}`);
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
 */
export class LightsailMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Lightsail Server Control",
    version: "1.0.0",
  });

  async init() {
    const containerArg = {
      container: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "invalid container name")
        .describe("Container name (must be on the server's allowlist)"),
    };

    this.server.registerTool(
      "docker_ps",
      {
        title: "List Docker containers",
        description:
          "List all Docker containers on the Lightsail server with their status and ports.",
        inputSchema: {},
      },
      async () => callInternal(this.env, "docker_ps")
    );

    this.server.registerTool(
      "docker_logs",
      {
        title: "Tail Docker logs",
        description:
          "Tail the logs of an allowlisted Docker container on the Lightsail server.",
        inputSchema: {
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
      async ({ container, lines }) =>
        callInternal(this.env, "docker_logs", { container, lines })
    );

    this.server.registerTool(
      "docker_restart",
      {
        title: "Restart Docker container",
        description:
          "Restart an allowlisted Docker container on the Lightsail server.",
        inputSchema: containerArg,
      },
      async ({ container }) =>
        callInternal(this.env, "docker_restart", { container })
    );

    this.server.registerTool(
      "disk_usage",
      {
        title: "Disk usage",
        description: "Show filesystem disk usage on the Lightsail server (df -h).",
        inputSchema: {},
      },
      async () => callInternal(this.env, "disk_usage")
    );

    this.server.registerTool(
      "memory_usage",
      {
        title: "Memory usage",
        description: "Show memory usage on the Lightsail server (free -h).",
        inputSchema: {},
      },
      async () => callInternal(this.env, "memory_usage")
    );

    this.server.registerTool(
      "service_status",
      {
        title: "Systemd service status",
        description:
          "Show systemctl status for an allowlisted service (e.g. nginx, docker, cloudflared).",
        inputSchema: {
          service: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/, "invalid service name")
            .describe("Systemd service name (must be on the server's allowlist)"),
        },
      },
      async ({ service }) => callInternal(this.env, "service_status", { service })
    );

    this.server.registerTool(
      "uptime",
      {
        title: "Server uptime",
        description: "Show the Lightsail server's uptime and load averages.",
        inputSchema: {},
      },
      async () => callInternal(this.env, "uptime")
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
