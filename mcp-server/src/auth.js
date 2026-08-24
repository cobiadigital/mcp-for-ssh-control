/**
 * Service-token authentication.
 *
 * Cloudflare Access already validates the service token at the edge and
 * strips the CF-Access-* headers before the request reaches this origin, so
 * the MCP portal is configured to send a second, differently named copy that
 * passes through untouched. This module re-checks that copy locally: if the
 * Access application is ever misconfigured or removed, the origin still
 * refuses everything that cannot prove it holds the token.
 */

import crypto from "node:crypto";
import { ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET } from "./config.js";

/**
 * Constant-time string compare. crypto.timingSafeEqual throws on length
 * mismatch, so both sides are hashed first — the comparison is then always
 * over 32 bytes and length differences leak nothing.
 */
function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Express middleware. Accepts either header pair so that a smoke test running
 * on the box itself (which does not pass through Access) can authenticate the
 * same way the portal does.
 */
export function requireServiceToken(req, res, next) {
  const id =
    req.get("X-Internal-Client-Id") || req.get("CF-Access-Client-Id") || "";
  const secret =
    req.get("X-Internal-Client-Secret") ||
    req.get("CF-Access-Client-Secret") ||
    "";

  // Both comparisons always run — no early return on the id — so a valid id
  // paired with a bad secret takes the same time as two bad values.
  const idOk = timingSafeEqual(id, ACCESS_CLIENT_ID);
  const secretOk = timingSafeEqual(secret, ACCESS_CLIENT_SECRET);

  if (!idOk || !secretOk) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid or missing service token" },
      id: null,
    });
    return;
  }
  next();
}
