/**
 * The human half of the OAuth flow, following Cloudflare's
 * remote-mcp-server-with-auth template pattern.
 *
 * OAuthProvider (src/index.ts) routes anything that isn't /mcp, /sse, /token
 * or /register here. Two routes matter:
 *
 *   GET/POST /authorize — entry point. OAuthProvider has already parsed the
 *     MCP client's authorization request; we show a one-time approval dialog,
 *     then bounce the browser to GitHub, smuggling the parsed AuthRequest
 *     through GitHub's `state` parameter (base64 JSON, no server-side session).
 *
 *   GET /callback — GitHub sends the browser back with a `code`. We exchange
 *     it for a GitHub access token, look up who logged in, enforce the
 *     single-user allowlist, and only then call
 *     env.OAUTH_PROVIDER.completeAuthorization(), which mints the MCP-side
 *     authorization code and redirects back to the MCP client. This is the
 *     step that actually issues the MCP token — without it the client would
 *     hang at "waiting for authorization" forever.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./types";
import {
  clientIdAlreadyApproved,
  parseRedirectApproval,
  renderApprovalDialog,
} from "./workers-oauth-utils";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Send the browser to GitHub. The full parsed AuthRequest rides along in
 * `state` so /callback can resume the MCP authorization without us storing
 * anything. GitHub echoes `state` back untouched.
 */
function redirectToGitHub(
  request: Request,
  oauthReqInfo: AuthRequest,
  env: Env,
  extraHeaders: Record<string, string> = {}
): Response {
  const callbackUrl = new URL("/callback", request.url).href;
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: "read:user",
    state: btoa(JSON.stringify(oauthReqInfo)),
  });
  return new Response(null, {
    status: 302,
    headers: {
      ...extraHeaders,
      Location: `${GITHUB_AUTHORIZE_URL}?${params}`,
    },
  });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // parseAuthRequest validates the MCP client's request (client_id known,
  // redirect_uri registered, PKCE params present) and hands back a typed
  // AuthRequest we must return to completeAuthorization() later.
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) {
    return new Response("Invalid OAuth request", { status: 400 });
  }

  // Skip the approval dialog if this browser already approved this client.
  if (await clientIdAlreadyApproved(request, oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY)) {
    return redirectToGitHub(request, oauthReqInfo, env);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  return renderApprovalDialog(request, {
    client,
    server: {
      name: "Lightsail Server Control",
      description: "MCP tools for managing the Lightsail box",
    },
    state: { oauthReqInfo },
  });
}

async function handleAuthorizeApproval(request: Request, env: Env): Promise<Response> {
  // The approval form posts back the AuthRequest it was rendered with, plus
  // we get a Set-Cookie header marking the client as approved for next time.
  const { state, headers } = await parseRedirectApproval(request, env.COOKIE_ENCRYPTION_KEY);
  return redirectToGitHub(request, state.oauthReqInfo, env, headers);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Recover the original MCP authorization request from GitHub's state echo.
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(url.searchParams.get("state") ?? "")) as AuthRequest;
  } catch {
    return new Response("Invalid state parameter", { status: 400 });
  }
  if (!oauthReqInfo.clientId) {
    return new Response("Invalid state parameter", { status: 400 });
  }

  // The state is attacker-visible (it went through the browser), so don't
  // trust it blindly: re-check that the client still exists and that the
  // redirect URI inside the state is one the client actually registered.
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!client || !client.redirectUris.includes(oauthReqInfo.redirectUri)) {
    return new Response("Unknown client or unregistered redirect URI", { status: 400 });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  // --- Step 1: exchange the GitHub code for a GitHub access token ---------
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", request.url).href,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) {
    return new Response("Failed to exchange code with GitHub", { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return new Response(`GitHub token exchange failed: ${tokenJson.error ?? "no access_token"}`, {
      status: 400,
    });
  }

  // --- Step 2: find out who just logged in --------------------------------
  const userRes = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: "application/vnd.github+json",
      // GitHub's API rejects requests without a User-Agent.
      "User-Agent": "lightsail-mcp-worker",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) {
    return new Response("Failed to fetch GitHub user", { status: 502 });
  }
  const user = (await userRes.json()) as { login: string; name: string | null };

  // --- Step 3: single-user allowlist ---------------------------------------
  // This is the whole point of the auth layer: a valid GitHub login is not
  // enough — it must be *my* GitHub login. GitHub usernames are
  // case-insensitive, so compare case-insensitively.
  if (user.login.toLowerCase() !== env.ALLOWED_GITHUB_USER.toLowerCase()) {
    return new Response(
      `Access denied: GitHub user "${user.login}" is not authorized to use this server.`,
      { status: 403 }
    );
  }

  // --- Step 4: complete the MCP-side authorization -------------------------
  // This stores the grant in OAUTH_KV, mints the authorization code the MCP
  // client will exchange at /token, and tells us where to send the browser.
  // `props` becomes `this.props` inside the LightsailMCP Durable Object.
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.login,
    metadata: { label: user.name ?? user.login },
    scope: oauthReqInfo.scope,
    props: {
      login: user.login,
      name: user.name ?? user.login,
      accessToken: tokenJson.access_token,
    } satisfies Props,
  });

  return Response.redirect(redirectTo, 302);
}

export const GitHubHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (pathname === "/authorize" && request.method === "POST") {
      return handleAuthorizeApproval(request, env);
    }
    if (pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
