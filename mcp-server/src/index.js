/**
 * MCP server for one managed box.
 *
 * Binds 127.0.0.1 only. The single way in is the Cloudflare Tunnel that
 * cloudflared dials outward from this machine, so no inbound port is ever
 * opened in the firewall. Cloudflare Access authenticates the MCP portal at
 * the edge; this process re-checks the service token itself (see auth.js).
 *
 * Transport: Streamable HTTP at POST /mcp, stateless. Stateless is the right
 * shape here — every call is a short command against the machine's current
 * state, nothing needs to be remembered between them, and it means a tunnel
 * reconnect or a service restart can never strand a session.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ALLOWED_CONTAINERS,
  ALLOWED_PATHS,
  ALLOWED_SERVICES,
  HOST,
  PORT,
  SERVER_ID,
  configErrors,
} from "./config.js";
import { requireServiceToken } from "./auth.js";
import { describeAllowlist } from "./sandbox.js";
import { registerTools } from "./tools.js";

const errors = configErrors();
if (errors.length > 0) {
  console.error("FATAL: refusing to start with an invalid configuration:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

/** A fresh server instance per request — see the stateless note above. */
function createServer() {
  const server = new McpServer(
    { name: `server-control-${SERVER_ID}`, version: "2.0.0" },
    {
      instructions:
        `Tools for operating the server "${SERVER_ID}". Every operation is restricted to ` +
        `explicit allowlists configured on the box; call server_info to see what this ` +
        `server permits before assuming a container, service, or path is reachable.`,
    }
  );
  registerTools(server);
  return server;
}

const app = express();
app.disable("x-powered-by");

// Auth runs before the body parser, so an unauthenticated request is rejected
// without this process ever parsing bytes it did not ask for.
app.use(requireServiceToken);
app.use(express.json({ limit: "1mb" }));

/**
 * Liveness check for the tunnel and for the smoke test. It sits behind the
 * same auth as everything else, because the allowlists it reports are useful
 * reconnaissance to anyone who should not be here.
 */
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    server_id: SERVER_ID,
    version: "2.0.0",
    containers: ALLOWED_CONTAINERS.length,
    services: ALLOWED_SERVICES.length,
    file_tools: ALLOWED_PATHS.length > 0,
  });
});

/**
 * The MCP endpoint is POST-only.
 *
 * Streamable HTTP also defines GET, for a standalone SSE stream the server
 * can push notifications down. A stateless server has nothing to push — every
 * call is one request and one reply — and leaving GET wired to the transport
 * opens a keep-alive stream that never terminates, so a probe or a health
 * check on this URL hangs instead of failing fast. The spec's answer for a
 * server that does not offer that stream is 405, so say so.
 */
app.all("/mcp", (req, res, next) => {
  if (req.method === "POST") return next();
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: `Method Not Allowed: this MCP endpoint accepts POST only, not ${req.method}.`,
    },
    id: null,
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session ids to track
    enableJsonResponse: true, // plain JSON replies rather than an SSE stream
  });

  // Tear both down when the response ends, however it ends — otherwise a
  // client that disconnects mid-call would leak a server instance per request.
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] /mcp request failed:`, e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Anything else — including the v1 `POST /run` endpoint, which no longer
// exists — gets a clear answer instead of a bare 404 body.
app.use((req, res) => {
  res.status(404).json({
    error: `Not found: ${req.method} ${req.path}. This is an MCP server; the endpoint is POST /mcp.`,
  });
});

// Body-parser failures and anything else unexpected.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? "Internal error" : err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`MCP server "${SERVER_ID}" v2.0.0 listening on http://${HOST}:${PORT}/mcp`);
  console.log(`  containers: ${describeAllowlist(ALLOWED_CONTAINERS, "container")}`);
  console.log(`  services:   ${describeAllowlist(ALLOWED_SERVICES, "service")}`);
  console.log(`  path roots: ${ALLOWED_PATHS.join(", ") || "(none — file and script tools disabled)"}`);
});
