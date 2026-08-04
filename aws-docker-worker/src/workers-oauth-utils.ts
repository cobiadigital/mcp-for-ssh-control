/**
 * Helpers for the "approve this MCP client?" interstitial shown during
 * /authorize, adapted from Cloudflare's remote-mcp-github-oauth template.
 *
 * Why this exists: MCP clients self-register via /register (dynamic client
 * registration), so *any* client can start an OAuth flow. The dialog gives
 * the human a chance to see which client is asking before being bounced to
 * GitHub. Once approved, the client id is remembered in an HMAC-signed
 * cookie so subsequent authorizations skip straight to GitHub.
 *
 * The cookie is signed (not encrypted): it only contains client ids, nothing
 * secret — the signature just stops someone from forging approval for a
 * client the user never saw. COOKIE_ENCRYPTION_KEY is the HMAC secret.
 */

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

const COOKIE_NAME = "mcp_approved_clients";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("COOKIE_ENCRYPTION_KEY is not set — run: wrangler secret put COOKIE_ENCRYPTION_KEY");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signData(secret: string, data: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(secret: string, signatureHex: string, data: string): Promise<boolean> {
  const key = await importKey(secret);
  try {
    const sig = new Uint8Array(signatureHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Approval cookie
// ---------------------------------------------------------------------------

/** Read and verify the approved-clients cookie; returns [] if absent/invalid. */
async function getApprovedClients(request: Request, secret: string): Promise<string[]> {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return [];

  const value = match.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf(".");
  if (dot === -1) return [];
  const [signature, payload] = [value.slice(0, dot), value.slice(dot + 1)];

  if (!(await verifySignature(secret, signature, payload))) return [];
  try {
    const parsed = JSON.parse(atob(payload));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** True if this client id was previously approved on this browser. */
export async function clientIdAlreadyApproved(
  request: Request,
  clientId: string,
  cookieSecret: string
): Promise<boolean> {
  return (await getApprovedClients(request, cookieSecret)).includes(clientId);
}

// ---------------------------------------------------------------------------
// Approval dialog
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: { name: string; description?: string };
  /** Opaque state round-tripped through the form (the parsed AuthRequest). */
  state: { oauthReqInfo: AuthRequest };
}

/**
 * Render the approval page. The pending AuthRequest is carried in a hidden
 * form field (base64 JSON) so the POST handler can resume the flow without
 * any server-side session storage.
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const { client, server, state } = options;
  const encodedState = btoa(JSON.stringify(state));
  const clientName = escapeHtml(client?.clientName || client?.clientId || "Unknown MCP client");
  const serverName = escapeHtml(server.name);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${clientName}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 2rem; max-width: 26rem;
            box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    h1 { font-size: 1.2rem; margin-top: 0; }
    .client { font-weight: 600; }
    button { background: #f6821f; color: white; border: 0; border-radius: 6px;
             padding: .6rem 1.4rem; font-size: 1rem; cursor: pointer; }
    button:hover { background: #d96f16; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${serverName}</h1>
    <p><span class="client">${clientName}</span> is requesting access to your
       Lightsail server controls. Approving will send you to GitHub to verify
       your identity.</p>
    <form method="post" action="${new URL(request.url).pathname}">
      <input type="hidden" name="state" value="${escapeHtml(encodedState)}">
      <button type="submit">Approve &amp; continue to GitHub</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle the approval form POST: recover the AuthRequest from the hidden
 * field and produce a Set-Cookie header remembering this client id as
 * approved, so the next /authorize for the same client skips the dialog.
 */
export async function parseRedirectApproval(
  request: Request,
  cookieSecret: string
): Promise<{ state: { oauthReqInfo: AuthRequest }; headers: Record<string, string> }> {
  const form = await request.formData();
  const encodedState = form.get("state");
  if (typeof encodedState !== "string" || !encodedState) {
    throw new Error("Missing state in approval form");
  }

  let state: { oauthReqInfo: AuthRequest };
  try {
    state = JSON.parse(atob(encodedState));
  } catch {
    throw new Error("Invalid state in approval form");
  }
  if (!state?.oauthReqInfo?.clientId) {
    throw new Error("Invalid state in approval form");
  }

  const approved = await getApprovedClients(request, cookieSecret);
  if (!approved.includes(state.oauthReqInfo.clientId)) {
    approved.push(state.oauthReqInfo.clientId);
  }
  const payload = btoa(JSON.stringify(approved));
  const signature = await signData(cookieSecret, payload);

  return {
    state,
    headers: {
      "Set-Cookie": `${COOKIE_NAME}=${signature}.${payload}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    },
  };
}
