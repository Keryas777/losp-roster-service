import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import {
  ALLIANCE_SCOPE_PROBES, getAllianceScopeProbe,
  allianceScopeRequest, auditAllianceScopeProbe
} from "../src/alliance-scope-probes.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const state = "a".repeat(43);
const verifier = "b".repeat(43);
const env = { SCOPELY_CLIENT_ID: "client", SCOPELY_CLIENT_SECRET: "secret" };
const tokenEndpoint = "https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const withCookie = probe => [
  "__Host-losp_oauth_state=" + state,
  "__Host-losp_oauth_verifier=" + verifier,
  probe.cookie + "=" + state
].join("; ");
const cb = (probe, query = "code=PRIVATE_CODE") =>
  new Request(origin + "/oauth/callback?state=" + state + "&" + query,
    { headers: { Cookie: withCookie(probe) } });

test("five fixed paths, no arbitrary scope requests, correct state cookie and PKCE", async () => {
  assert.equal(ALLIANCE_SCOPE_PROBES.length, 5);
  assert.equal(getAllianceScopeProbe("/login/scope-probe/unknown"), null);
  assert.equal(getAllianceScopeProbe("/login/scope-probe/all?scope=foo"), null);
  for (const probe of ALLIANCE_SCOPE_PROBES) {
    const res = await worker.fetch(new Request(origin + probe.path), env);
    assert.equal(res.status, 302);
    const oauth = new URL(res.headers.get("location"));
    assert.equal(oauth.searchParams.get("scope"), allianceScopeRequest(probe));
    assert.equal(oauth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(oauth.searchParams.get("response_type"), "code");
    assert.equal(oauth.searchParams.has("client_secret"), false);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.getSetCookie().length, 3);
    const marker = res.headers.getSetCookie().find(row => row.startsWith(probe.cookie + "="));
    assert.ok(marker);
    assert.match(marker, /Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    assert.ok(marker.includes("=" + oauth.searchParams.get("state") + ";"));
  }
  const unknown = await worker.fetch(new Request(origin + "/login/scope-probe/unknown"), env);
  assert.equal(unknown.status, 404);
});

test("existing routes and permissions unaffected", async () => {
  for (const [path, scopes] of [
    ["/login", "openid m3p.f.pr.pro"],
    ["/login/rosters", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros"]
  ]) {
    const res = await worker.fetch(new Request(origin + path), env);
    assert.equal(new URL(res.headers.get("location")).searchParams.get("scope"), scopes);
  }
});

test("exact token scope results: all, subset, none, not returned", () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  assert.equal(auditAllianceScopeProbe(probe, probe.scopes.join(" ")).status, "all-granted");
  assert.equal(auditAllianceScopeProbe(probe, probe.scopes[0]).status, "some-granted");
  assert.equal(auditAllianceScopeProbe(probe, "openid m3p.f.ar.ros").status, "none-granted");
  assert.equal(auditAllianceScopeProbe(probe, undefined).status, "unreported");
  assert.equal(auditAllianceScopeProbe(probe, "m3p.f.ar.inv.extra").checks[0].granted, false);
});

test("valid OAuth response only checks scopes, never calls private API or stores tokens", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  const calls = [];
  const res = await handleCallback(cb(probe), env, async (url, init) => {
    calls.push(url);
    assert.equal(url, tokenEndpoint);
    assert.equal(init.method, "POST");
    return Response.json({
      access_token: "PRIVATE_ACCESS_TOKEN",
      refresh_token: "PRIVATE_REFRESH_TOKEN",
      token_type: "Bearer",
      scope: "openid m3p.f.pr.pro m3p.f.ar.pro " + probe.scopes.join(" ")
    });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [tokenEndpoint]);
  assert.equal(res.headers.getSetCookie().length, 3);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(res.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await res.text();
  assert.match(html, /toutes les permissions demandées/);
  assert.match(html, /m3p\.f\.ar\.raid/);
  assert.match(html, /Accordée/);
  assert.match(html, /history.replaceState/);
  assert.doesNotMatch(html + JSON.stringify([...res.headers]),
    /PRIVATE_(ACCESS_TOKEN|REFRESH_TOKEN|CODE)|Bearer/);
});

test("an absent, partial or unrelated token scope is reported conservatively", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  for (const [scope, text] of [
    [undefined, /Impossible de déterminer les permissions/],
    [probe.scopes[1], /Certaines permissions ont été accordées/],
    ["openid m3p.f.ar.pro", /Aucune des permissions expérimentales/]
  ]) {
    const res = await handleCallback(cb(probe), env, async url => {
      assert.equal(url, tokenEndpoint);
      return Response.json({ access_token: "PRIVATE_ACCESS_TOKEN", token_type: "Bearer", ...(scope === undefined ? {} : { scope }) });
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), text);
  }
});

test("each of the four individual scopes reports only its own grant", async () => {
  for (const probe of ALLIANCE_SCOPE_PROBES.slice(1)) {
    const res = await handleCallback(cb(probe), env, async url => {
      assert.equal(url, tokenEndpoint);
      return Response.json({ access_token: "PRIVATE_ACCESS_TOKEN", token_type: "Bearer", scope: probe.scopes[0] });
    });
    const html = await res.text();
    assert.match(html, /toutes les permissions demandées/);
    assert.match(html, new RegExp(probe.scopes[0].replaceAll(".", "\\.")));
    assert.doesNotMatch(html, /PRIVATE_ACCESS_TOKEN/);
  }
});

test("invalid_scope at authorization is handled with zero token or API calls", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  let calls = 0;
  const res = await handleCallback(cb(probe, "error=invalid_scope&error_description=PRIVATE_REASON"),
    env, async () => { calls++; throw Error("Must not call token"); });
  assert.equal(calls, 0);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /invalid_scope/);
  assert.doesNotMatch(html, /PRIVATE_REASON/);
});

test("invalid_scope at token exchange is handled with no secondary API calls", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  let calls = 0;
  const res = await handleCallback(cb(probe), env, async url => {
    calls++;
    assert.equal(url, tokenEndpoint);
    return Response.json({ error: "invalid_scope", error_description: "PRIVATE_REASON" }, { status: 400 });
  });
  assert.equal(calls, 1);
  assert.match(await res.text(), /invalid_scope/);
  assert.equal(res.headers.getSetCookie().length, 3);
});

test("stale or forged marker cannot authorize experimental diagnostic", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  const request = new Request(origin + "/oauth/callback?state=" + state + "&code=PRIVATE_CODE",
    { headers: { Cookie: withCookie(probe).replace(probe.cookie + "=" + state, probe.cookie + "=" + "z".repeat(43)) } });
  const calls = [];
  const res = await handleCallback(request, env, async url => {
    calls.push(url);
    if (url === tokenEndpoint) return Response.json({
      access_token: "PRIVATE_ACCESS_TOKEN", token_type: "Bearer", scope: probe.scopes.join(" ")
    });
    if (url.endsWith("/player/v1/card")) return Response.json({
      data: { name: "Owner", level: { completedTier: 1 } }
    });
    throw Error("Unexpected route");
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(await res.text(), /Permissions d.alliance/);
});

test("invalid state always short-circuits before token exchange", async () => {
  const probe = ALLIANCE_SCOPE_PROBES[0];
  const request = new Request(origin + "/oauth/callback?state=" + "c".repeat(43) +
    "&error=invalid_scope", { headers: { Cookie: withCookie(probe) } });
  let calls = 0;
  const res = await handleCallback(request, env, async () => { calls++; throw Error("unexpected"); });
  assert.equal(calls, 0);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /result=invalid/);
});
