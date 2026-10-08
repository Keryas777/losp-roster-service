import { handleCallback, handleOAuthStatus } from "./oauth-callback.js";

const SCOPELY_AUTH_URL = "https://hydra-public.prod.m3.scopelypv.com/oauth2/auth";
const APP_ORIGIN = "https://losp-roster-service.deliriousfan7.workers.dev";
const REDIRECT_URI = APP_ORIGIN + "/oauth/callback";
const LOGIN_SCOPES = "openid m3p.f.pr.pro";
const LOGIN_COOKIE_AGE_SECONDS = 600;

function randomBase64Url(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function startLogin(request, env, url) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" }
    });
  }

  // The OAuth callback is registered for this production hostname only.
  // Do not initiate production OAuth from preview URLs or forwarded hosts.
  if (url.origin !== APP_ORIGIN) {
    return new Response("Not Found", { status: 404 });
  }

  const clientId = env?.SCOPELY_CLIENT_ID;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return new Response("OAuth is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const state = randomBase64Url();
  const codeVerifier = randomBase64Url();
  const codeChallenge = await sha256Base64Url(codeVerifier);

  const authorize = new URL(SCOPELY_AUTH_URL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId.trim());
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  const inventoryProbe = url.pathname === "/login/inventory-test";
  const rosterScopeProbe = url.pathname === "/login/roster-scope-test";
  const allianceProbe = url.pathname === "/login/alliance-test" || rosterScopeProbe;
  const scopes = allianceProbe ? LOGIN_SCOPES + " m3p.f.ar.pro" : LOGIN_SCOPES;
  authorize.searchParams.set("scope", inventoryProbe ? LOGIN_SCOPES + " m3p.f.pr.inv" :
    rosterScopeProbe ? scopes + " m3p.f.pr.ros" : scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  // Short-lived, host-only cookies for the future callback's validation.
  // They are not OAuth access tokens and contain no client secret.
  const headers = new Headers({
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex"
  });
  const attributes = "Max-Age=" + LOGIN_COOKIE_AGE_SECONDS +
    "; Path=/; Secure; HttpOnly; SameSite=Lax";
  headers.append("Set-Cookie", "__Host-losp_oauth_state=" + state + "; " + attributes);
  headers.append("Set-Cookie", "__Host-losp_oauth_verifier=" + codeVerifier + "; " + attributes);
  if (allianceProbe) headers.append("Set-Cookie", "__Host-losp_oauth_alliance_test=" + state + "; " + attributes);
  if (rosterScopeProbe) headers.append("Set-Cookie", "__Host-losp_oauth_roster_scope_test=" + state + "; " + attributes);
  if (inventoryProbe) headers.append("Set-Cookie", "__Host-losp_oauth_inventory_test=" + state + "; " + attributes);
  return new Response(null, { status: 302, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login" || url.pathname === "/login/alliance-test" ||
        url.pathname === "/login/roster-scope-test" ||
        url.pathname === "/login/inventory-test") {
      return startLogin(request, env, url);
    }

    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, env);
    }

    if (url.pathname === "/oauth/status") {
      return handleOAuthStatus(request);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(new URL("/index.html", url), 302);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          service: "losp-roster-service",
          version: "0.1.2"
        },
        {
          headers: {
            "Cache-Control": "no-store"
          }
        }
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};
