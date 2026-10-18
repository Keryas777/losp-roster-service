import { handleCallback, handleOAuthStatus } from "./oauth-callback.js";
import { getAllianceScopeProbe, allianceScopeRequest } from "./alliance-scope-probes.js";
import { CAPTAIN_SCOPES } from "./captain-scopes.js";
import { captainConfigReady } from "./captain-vault.js";
import { handleCaptainSession, handleCaptainLogout, handleCaptainLanding, handleCaptainRosters, handleCaptainCoverage, renewCaptainGrants } from "./captain-session-routes.js";
export { CaptainRefreshCoordinator } from "./captain-refresh-coordinator.js";
import { buildPrivateCoverage } from "./alliance-coverage.js";
import { handleAdmin } from "./admin-routes.js";

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

  if (url.pathname === "/login/captain" && env?.CAPTAIN_SESSIONS_ENABLED === "true" &&
      !captainConfigReady(env)) {
    return new Response("Captain session storage is not configured", {
      status: 503, headers: { "Cache-Control": "no-store" }
    });
  }
  const clientId = env?.SCOPELY_CLIENT_ID;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return new Response("OAuth is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  if (url.pathname === "/login/captain" && captainConfigReady(env)) {
    // A returning captain must not be sent through the emailed-code OAuth flow.
    const status=await handleCaptainSession(request,env);
    if(status.ok) {
      const previous=await status.json();
      if(previous.status==="connected"){
        const redirect=Response.redirect(APP_ORIGIN+"/captain",302);
        // Extend the sliding browser lease only when the Worker confirmed
        // the opaque session. No token is ever sent to the browser.
        const headers=new Headers(redirect.headers);
        for(const cookie of status.headers.getSetCookie())headers.append("Set-Cookie",cookie);
        headers.set("Cache-Control","no-store");
        return new Response(null,{status:302,headers});
      }
      if(previous.status==="temporarily-unavailable")
        return new Response("Connexion temporairement indisponible : réessayer plus tard",{
          status:503,headers:{"Cache-Control":"no-store"}
        });
    } else {
      return new Response("Vérification de session indisponible : réessayer plus tard",{
        status:503,headers:{"Cache-Control":"no-store"}
      });
    }
  }

  const state = randomBase64Url();
  const codeVerifier = randomBase64Url();
  const codeChallenge = await sha256Base64Url(codeVerifier);

  const authorize = new URL(SCOPELY_AUTH_URL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId.trim());
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  const profilesProbe = url.pathname === "/login/profiles-test";
  const coverageProbe = url.pathname === "/login/coverage-test";
  const cardTypesProbe = url.pathname === "/login/card-types-test";
  const metricsProbe = url.pathname === "/login/metrics-test";
  const isoIconsProbe = url.pathname === "/login/iso-icons-test";
  const inventoryProbe = url.pathname === "/login/inventory-test";
  const rosterScopeProbe = url.pathname === "/login/roster-scope-test";
  const allianceScopeProbe = url.pathname === "/login/alliance-scope-test";
  const collectionProbe = url.pathname === "/login/alliance-collection-test";
  const rosterViewerMode = url.pathname === "/login/rosters";
  const captainMode = url.pathname === "/login/captain";
  const scopeProbe = getAllianceScopeProbe(url.pathname);
  const allianceProbe = url.pathname === "/login/alliance-test" || rosterScopeProbe;
  const scopes = allianceProbe || allianceScopeProbe || collectionProbe || rosterViewerMode || profilesProbe || coverageProbe || cardTypesProbe || metricsProbe
    ? LOGIN_SCOPES + " m3p.f.ar.pro" : LOGIN_SCOPES;
  authorize.searchParams.set("scope", captainMode ? CAPTAIN_SCOPES :
    scopeProbe ? allianceScopeRequest(scopeProbe) :
    inventoryProbe ? LOGIN_SCOPES + " m3p.f.pr.inv" :
    (allianceScopeProbe || collectionProbe || rosterViewerMode) ? scopes + " m3p.f.ar.ros" :
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
  if (allianceScopeProbe) headers.append("Set-Cookie", "__Host-losp_oauth_alliance_scope_test=" + state + "; " + attributes);
  if (collectionProbe) headers.append("Set-Cookie", "__Host-losp_oauth_collection_test=" + state + "; " + attributes);
  if (rosterViewerMode) headers.append("Set-Cookie", "__Host-losp_oauth_roster_viewer=" + state + "; " + attributes);
  if (captainMode) headers.append("Set-Cookie", "__Host-losp_oauth_captain=" + state + "; " + attributes);
  if (scopeProbe) headers.append("Set-Cookie", scopeProbe.cookie + "=" + state + "; " + attributes);
  if (inventoryProbe) headers.append("Set-Cookie", "__Host-losp_oauth_inventory_test=" + state + "; " + attributes);
  if (profilesProbe) headers.append("Set-Cookie", "__Host-losp_oauth_profiles_test=" + state + "; " + attributes);
  if (coverageProbe) headers.append("Set-Cookie", "__Host-losp_oauth_coverage_test=" + state + "; " + attributes);
  if (cardTypesProbe) headers.append("Set-Cookie", "__Host-losp_oauth_card_types_test=" + state + "; " + attributes);
  if (metricsProbe) headers.append("Set-Cookie", "__Host-losp_oauth_metrics_test=" + state + "; " + attributes);
  if (isoIconsProbe) headers.append("Set-Cookie", "__Host-losp_oauth_iso_icons_test=" + state + "; " + attributes);
  return new Response(null, { status: 302, headers });
}

export default {
  async scheduled(controller, env) {
    // Scheduled refresh is disabled unless all private storage bindings exist.
    // No player or roster information is fetched or logged.
    try {
      const result=await renewCaptainGrants(env);
      // Global counts only: never log token values, player names, IDs or grants.
      const report={version:1,checkedAt:new Date().toISOString(),
        status:result.status,checked:result.checked,failed:result.failed||0,
        rotated:result.rotated||0};
      console.info("captain-refresh-cron",JSON.stringify(report));
      if(result.status!=="disabled" && env?.CAPTAIN_BUCKET?.put){
        // One private aggregate record, overwritten on every scheduled check.
        try {await env.CAPTAIN_BUCKET.put("oauth-monitoring/v1/last-refresh-check.json",
          JSON.stringify(report));} catch {}
      }
    } catch {
      console.warn("captain-refresh-cron",JSON.stringify({status:"unavailable"}));
    }
    // Separate daily opt-in discovery; disabled by default. No roster sync.
    if (controller?.cron === "15 3 * * *" && env?.CAPTAIN_COVERAGE_ENABLED === "true") {
      try { await buildPrivateCoverage(env); } catch {}
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }

    if (getAllianceScopeProbe(url.pathname) ||
        url.pathname === "/login" || url.pathname === "/login/alliance-test" ||
        url.pathname === "/login/roster-scope-test" ||
        url.pathname === "/login/alliance-scope-test" ||
        url.pathname === "/login/alliance-collection-test" ||
        url.pathname === "/login/rosters" ||
        url.pathname === "/login/captain" ||
        url.pathname === "/login/inventory-test" ||
        url.pathname === "/login/profiles-test" ||
        url.pathname === "/login/coverage-test" ||
        url.pathname === "/login/card-types-test" ||
        url.pathname === "/login/metrics-test" ||
        url.pathname === "/login/iso-icons-test") {
      return startLogin(request, env, url);
    }

    if (url.pathname === "/captain") {
      return handleCaptainLanding(request, env);
    }
    if (url.pathname === "/captain/rosters") {
      return handleCaptainRosters(request, env);
    }
    if (url.pathname === "/captain/coverage") {
      return handleCaptainCoverage(request, env);
    }
    if (url.pathname === "/session") {
      return handleCaptainSession(request, env);
    }
    if (url.pathname === "/logout") {
      return handleCaptainLogout(request, env);
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
