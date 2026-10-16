import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { renderLiveRosterViewer } from "../src/roster-viewer.js";
import {
  CAPTAIN_SCOPES, CAPTAIN_SCOPE_DESCRIPTIONS, auditCaptainScopes
} from "../src/captain-scopes.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const fullScope = CAPTAIN_SCOPES;
const state = "a".repeat(43), verifier = "b".repeat(43);
const cookies = "__Host-losp_oauth_state=" + state +
  "; __Host-losp_oauth_verifier=" + verifier +
  "; __Host-losp_oauth_captain=" + state;
const env = { SCOPELY_CLIENT_ID: "client-test", SCOPELY_CLIENT_SECRET: "secret-test" };
const callbackRequest = rawCookie => new Request(origin +
  "/oauth/callback?state=" + state + "&code=PRIVATE_AUTH_CODE", {
    headers: { Cookie: rawCookie }
  });

test("comprehensive list has no duplicates and exactly seven read-only categories", () => {
  assert.equal(CAPTAIN_SCOPE_DESCRIPTIONS.length, 9);
  assert.equal(new Set(CAPTAIN_SCOPE_DESCRIPTIONS.map(row => row.scope)).size, 9);
  assert.equal(CAPTAIN_SCOPES, [
    "openid", "m3p.f.pr.pro", "m3p.f.pr.ros", "m3p.f.pr.inv",
    "m3p.f.pr.act", "m3p.f.pr.buy", "m3p.f.ar.pro",
    "m3p.f.ar.ros", "offline"
  ].join(" "));
  assert.doesNotMatch(CAPTAIN_SCOPES, /m3p\.f\.ar\.(?:inv|raid|war|act)(?:\s|$)/);
});

test("new captain OAuth flow asks all documented permissions with PKCE while old routes stay intact", async () => {
  const cases = [
    ["/login", "openid m3p.f.pr.pro", 2],
    ["/login/rosters", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros", 3],
    ["/login/captain", CAPTAIN_SCOPES, 3]
  ];
  for (const [route, expected, cookiesCount] of cases) {
    const response = await worker.fetch(new Request(origin + route), env);
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location"));
    assert.equal(target.searchParams.get("scope"), expected);
    assert.equal(target.searchParams.get("response_type"), "code");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    assert.equal(target.searchParams.has("client_secret"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.getSetCookie().length, cookiesCount);
    if (route === "/login/captain") {
      const marker = response.headers.getSetCookie().find(row =>
        row.startsWith("__Host-losp_oauth_captain="));
      assert.ok(marker);
      assert.match(marker, /Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      assert.ok(marker.includes("=" + target.searchParams.get("state") + ";"));
    }
  }
});

test("permission audit reports exact scopes, missing ones and unreported grants", () => {
  const full = auditCaptainScopes(fullScope + " future-scope");
  assert.equal(full.state, "complete");
  assert.equal(full.granted, 9);
  const subset = auditCaptainScopes("openid m3p.f.ar.pro m3p.f.ar.ros");
  assert.equal(subset.state, "partial");
  assert.equal(subset.granted, 3);
  assert.equal(subset.scopes.find(row => row.scope === "offline").granted, false);
  const unknown = auditCaptainScopes(undefined);
  assert.equal(unknown.state, "unreported");
  assert.equal(unknown.granted, 0);
  const falseMatch = auditCaptainScopes("openid m3p.f.ar.ros.more");
  assert.equal(falseMatch.scopes.find(row => row.scope === "m3p.f.ar.ros").granted, false);
});

test("full captain login shows granted permissions and real roster while disclosing no tokens", async () => {
  const calls = [];
  const response = await handleCallback(callbackRequest(cookies), env, async (url, init) => {
    calls.push(url);
    if (url.endsWith("/oauth2/token")) {
      return Response.json({
        access_token: "PRIVATE_ACCESS_TOKEN",
        refresh_token: "PRIVATE_REFRESH_TOKEN",
        token_type: "Bearer", scope: fullScope
      });
    }
    assert.equal(init.headers.Authorization, "Bearer PRIVATE_ACCESS_TOKEN");
    if (url.endsWith("/alliance/members")) {
      return Response.json({ data: [
        { id: "self", isSelf: true, card: { rosterShare: true } },
        { id: "shared-member", isSelf: false,
          card: { name: "Shared ally", rosterShare: true } }
      ] });
    }
    if (url.includes("/roster/member/")) {
      return Response.json({ data: [
        { id: "hero-1", info: { name: "Captain Marvel" }, power: 10000 }
      ], meta: { page: 1, perPage: 100, perTotal: 1 } });
    }
    throw Error("Unexpected request: " + url);
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(response.headers.getSetCookie().length, 4);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await response.text();
  assert.match(html, /Autorisations accordées : 9 \/ 9/);
  assert.match(html, /Captain Marvel/);
  assert.match(html, /Inventaire personnel/);
  assert.match(html, /Consultation des offres/);
  assert.match(html, /les jetons sont détruits/);
  assert.doesNotMatch(html + JSON.stringify([...response.headers]),
    /PRIVATE_(ACCESS_TOKEN|REFRESH_TOKEN|AUTH_CODE)|shared-member|Bearer /);
});

test("partial grants still report missing permissions and only use roster if granted", async () => {
  for (const scope of [
    "openid m3p.f.pr.pro",
    "openid m3p.f.ar.pro m3p.f.ar.ros"
  ]) {
    const calls = [];
    const response = await handleCallback(callbackRequest(cookies), env, async url => {
      calls.push(url);
      if (url.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "PRIVATE_ACCESS_TOKEN",
          token_type: "Bearer", scope });
      }
      if (url.endsWith("/alliance/members")) return Response.json({ data: [] });
      throw Error("Unexpected URL");
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Certaines permissions manquent/);
    assert.match(html, /non confirmé/);
    assert.equal(calls.length, scope.includes("m3p.f.ar.ros") ? 2 : 1);
  }
});

test("stale captain cookie cannot activate the comprehensive permission flow", async () => {
  const stale = cookies.replace("__Host-losp_oauth_captain=" + state,
    "__Host-losp_oauth_captain=" + "z".repeat(43));
  const calls = [];
  const response = await handleCallback(callbackRequest(stale), env, async url => {
    calls.push(url);
    if (url.endsWith("/oauth2/token")) return Response.json({
      access_token: "PRIVATE_ACCESS_TOKEN", token_type: "Bearer", scope: fullScope
    });
    if (url.endsWith("/player/v1/card")) return Response.json({
      data: { name: "Captain", level: { completedTier: 110 } }
    });
    throw Error("No captain data should be accessed");
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(await response.text(), /Autorisations accordées/);
});

test("rendered scope labels are escaped if accidentally untrusted", async () => {
  const scopeReport = auditCaptainScopes(fullScope);
  scopeReport.scopes[0].label = "<img src=x onerror=alert(1)>";
  const response = renderLiveRosterViewer({
    status: "scope-not-granted",
    captainScopeAudit: scopeReport
  });
  const html = await response.text();
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
