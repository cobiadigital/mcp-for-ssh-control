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
 */

"use strict";

const express = require("express");
const crypto = require("node:crypto");
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

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

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

function runArgv(argv) {
  const [cmd, ...cmdArgs] = argv;
  return new Promise((resolve) => {
    execFile(
      cmd,
      cmdArgs,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        // `docker logs` writes to stderr; `systemctl status` exits non-zero
        // for stopped services. Both are still useful output, so return
        // whatever we got and note the failure instead of erroring out.
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (error && error.killed) {
          resolve({ ok: false, output: `Command timed out after ${EXEC_TIMEOUT_MS / 1000}s\n${combined}` });
        } else if (error && combined === "") {
          resolve({ ok: false, output: `Command failed: ${error.message}` });
        } else {
          resolve({ ok: true, output: combined || "(no output)" });
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(requireAccessToken); // auth first — unauthenticated requests never reach the parser
app.use(express.json({ limit: "16kb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, commands: Object.keys(COMMANDS) });
});

app.post("/run", async (req, res) => {
  const { command, args = {} } = req.body || {};
  const builder = Object.prototype.hasOwnProperty.call(COMMANDS, command)
    ? COMMANDS[command]
    : null;
  if (!builder) {
    return res.status(400).json({
      error: `Unknown command "${command}". Available: ${Object.keys(COMMANDS).join(", ")}`,
    });
  }

  let argv;
  try {
    argv = builder(args); // validation happens here (allowlists, shapes)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return res.status(status).json({ error: e.message });
  }

  console.log(`[${new Date().toISOString()}] run ${command}: ${argv.join(" ")}`);
  const result = await runArgv(argv);
  res.json(result);
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
});
