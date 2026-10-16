import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const state = "a".repeat(43);
const verifier = "b".repeat(43);
const token = "PRIVATE_ACCESS_TOKEN";
const env = { SCOPELY_CLIENT_ID: "test-client", SCOPELY_CLIENT_SECRET: "test-secret" };
const cookie = [
  "__Host-losp_oauth_state=" + state,
  "__Host-losp_oauth_verifier=" + verifier,
  "__Host-losp_oauth_alliance_scope_test=" + state
].join("; ");

const req = cookies => new Request(origin + "/oauth/callback?state=" + state +
  "&code=PRIVATE_CODE", { headers: { Cookie: cookies } });

function apiResponse(url, calls, memberStatus = 200) {
  calls.push(url);
  if (url.endsWith("/alliance/members")) {
    return Response.json({ data: [
      { id: "self", isSelf: true, card: { name: "Owner", rosterShare: true } },
      { id: "private-member-id", isSelf: false,
        card: { name: "Shared player", rosterShare: true } }
    ] });
  }
  if (url.includes("/roster/member/")) {
    if (memberStatus !== 200) return new Response("PRIVATE_DENIAL", { status: memberStatus });
    return Response.json({ data: [{ id: "PRIVATE_CHARACTER" }] });
  }
  throw Error("Unexpected request: " + url);
}

async function probe(scope, memberStatus = 200, cookies = cookie) {
  const calls = [];
  const res = await handleCallback(req(cookies), env, async url => {
    calls.push(url);
    if (url.endsWith("/oauth2/token")) {
      const payload = { access_token: token, token_type: "Bearer" };
      if (scope !== undefined) payload.scope = scope;
      return Response.json(payload);
    }
    // The mock records one entry per actual GET; token exchange is excluded below.
    calls.pop();
    return apiResponse(url, calls, memberStatus);
  });
  return { res, calls, html: await res.text() };
}

test("new consent route requests only the extra alliance roster permission", async () => {
  const cases = [
    ["/login", "openid m3p.f.pr.pro", 2],
    ["/login/alliance-test", "openid m3p.f.pr.pro m3p.f.ar.pro", 3],
    ["/login/roster-scope-test", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros", 4],
    ["/login/alliance-scope-test", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros", 3]
  ];
  for (const [path, expected, cookieCount] of cases) {
    const r = await worker.fetch(new Request(origin + path), env);
    assert.equal(r.status, 302);
    const target = new URL(r.headers.get("location"));
    assert.equal(target.searchParams.get("scope"), expected);
    assert.equal(target.searchParams.has("client_secret"), false);
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    assert.equal(r.headers.getSetCookie().length, cookieCount);
    assert.equal(r.headers.get("cache-control"), "no-store");
    if (path === "/login/alliance-scope-test") {
      const marker = r.headers.getSetCookie().find(c =>
        c.startsWith("__Host-losp_oauth_alliance_scope_test="));
      assert.ok(marker);
      assert.match(marker, /Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      assert.ok(marker.includes("=" + target.searchParams.get("state") + ";"));
    }
  }
});

test("a granted exact scope makes at most two private GETs and exposes no roster", async () => {
  const { res, calls, html } = await probe("openid m3p.f.ar.pro m3p.f.ar.ros");
  assert.deepEqual(calls, [
    "https://hydra-public.prod.m3.scopelypv.com/oauth2/token",
    "https://api.marvelstrikeforce.com/player/v1/alliance/members",
    "https://api.marvelstrikeforce.com/player/v1/roster/member/private-member-id?page=1&perPage=1"
  ]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.getSetCookie().length, 5);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(res.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.match(html, /Permission OAuth accordée/);
  assert.match(html, /Accès au roster confirmé/);
  assert.doesNotMatch(html + JSON.stringify([...res.headers]), /PRIVATE_(ACCESS_TOKEN|CODE|CHARACTER)|private-member-id/);
});

test("a granted scope can still produce a separate 403 without retries", async () => {
  const { calls, html } = await probe("m3p.f.ar.ros", 403);
  assert.equal(calls.length, 3);
  assert.match(html, /Permission OAuth accordée/);
  assert.match(html, /403/);
  assert.doesNotMatch(html, /PRIVATE_DENIAL|PRIVATE_ACCESS_TOKEN|private-member-id/);
});

test("missing, absent or inexact scope never contacts members or rosters", async () => {
  for (const scope of [
    undefined, "", "openid m3p.f.ar.pro",
    "m3p.f.ar.ros.extra", "other_m3p.f.ar.ros"
  ]) {
    const { calls, html } = await probe(scope);
    assert.equal(calls.length, 1);
    assert.match(html, scope === undefined ? /Permission non vérifiable/ : /Permission non accordée/);
    assert.match(html, /Aucun roster n.a été interrogé/);
    assert.doesNotMatch(html, /PRIVATE_ACCESS_TOKEN|PRIVATE_CODE/);
  }
});

test("provider invalid_scope error is handled without a roster read", async () => {
  let calls = 0;
  const r = await handleCallback(req(cookie), env, async () => {
    calls++;
    return Response.json({ error: "invalid_scope", error_description: "PRIVATE_REASON" }, { status: 400 });
  });
  assert.equal(calls, 1);
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /exchange-invalid-scope/);
  assert.doesNotMatch(JSON.stringify([...r.headers]), /PRIVATE_REASON|PRIVATE_CODE/);
});

test("unmatched marker never authorizes the special flow", async () => {
  const mismatched = cookie.replace("__Host-losp_oauth_alliance_scope_test=" + state,
    "__Host-losp_oauth_alliance_scope_test=" + "z".repeat(43));
  const called = [];
  const res = await handleCallback(req(mismatched), env, async url => {
    called.push(url);
    if (url.endsWith("/oauth2/token")) {
      return Response.json({ access_token: token, token_type: "Bearer", scope: "m3p.f.ar.ros" });
    }
    if (url.endsWith("/player/v1/card")) {
      return Response.json({ data: { name: "Own card", level: { completedTier: 1 } } });
    }
    throw Error("No other request expected");
  });
  assert.equal(res.status, 200);
  assert.deepEqual(called, [
    "https://hydra-public.prod.m3.scopelypv.com/oauth2/token",
    "https://api.marvelstrikeforce.com/player/v1/card"
  ]);
  assert.doesNotMatch(await res.text(), /Permission OAuth accordée/);
});
