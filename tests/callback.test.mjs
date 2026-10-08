import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCallback, handleOAuthStatus } from "../src/oauth-callback.js";
import worker from "../src/index.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const client = { SCOPELY_CLIENT_ID: "client-id-test", SCOPELY_CLIENT_SECRET: "secret-test" };
const state = "a".repeat(43);
const verifier = "b".repeat(43);
const cookie = "__Host-losp_oauth_state=" + state +
  "; __Host-losp_oauth_verifier=" + verifier;
const req = (path, options = {}) => new Request(origin + path, options);
const cb = (query, options = {}) => req("/oauth/callback?" + query, {
  headers: { Cookie: cookie }, ...options
});

function checkRedirect(res, result) {
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), origin + "/oauth/status?result=" + result);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.getSetCookie().length, 2);
  for (const entry of res.headers.getSetCookie()) {
    assert.match(entry, /Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  }
}

test("valid OAuth fetches the player card once without exposing tokens", async () => {
  const requests = [];
  const spy = async (url, init) => {
    requests.push({url, init});
    if (requests.length === 1) {
      assert.equal(url, "https://hydra-public.prod.m3.scopelypv.com/oauth2/token");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization,
        "Basic " + Buffer.from("client-id-test:secret-test").toString("base64"));
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("redirect_uri"), origin + "/oauth/callback");
      assert.equal(body.get("code_verifier"), verifier);
      assert.equal(body.get("code"), "sample-code");
      return Response.json({
        access_token: "PRIVATE_ACCESS_TOKEN",
        refresh_token: "PRIVATE_REFRESH_TOKEN",
        id_token: "PRIVATE_ID_TOKEN",
        token_type: "Bearer", expires_in: 3600
      });
    }
    assert.equal(url, "https://api.marvelstrikeforce.com/player/v1/card");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer PRIVATE_ACCESS_TOKEN");
    assert.equal(init.headers["User-Agent"], "APIClient/1.0 (Server)");
    assert.equal(init.redirect, "manual");
    assert.ok(init.headers["x-api-key"]);
    assert.equal(init.cache, "no-store");
    return Response.json({
      data: { name: "Capitaine MSF", level: { completedTier: 110 },
        tcp: 123456789, stp: 222222, charactersCollected: 355, warMvp: 5 }
    });
  };
  const res = await handleCallback(cb("state=" + state + "&code=sample-code"), client, spy);
  assert.equal(requests.length, 2);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(res.headers.getSetCookie().length, 2);
  assert.match(res.headers.get("content-security-policy"), /script-src 'nonce-/);
  const page = await res.text();
  assert.match(page, /Capitaine MSF/);
  assert.match(page, /123.456.789|123[\u202f ]456[\u202f ]789/);
  assert.match(page, /history.replaceState/);
  assert.doesNotMatch(page + JSON.stringify([...res.headers]), /PRIVATE_(ACCESS|REFRESH|ID)_TOKEN/);
  assert.doesNotMatch(page + JSON.stringify([...res.headers]), /sample-code|client-id-test|secret-test/);
});

test("profile API failure discards token and clears OAuth cookies", async () => {
  const spy = async (url) => url.includes("/oauth2/token")
    ? Response.json({ access_token: "PRIVATE_ACCESS_TOKEN", token_type: "Bearer" })
    : Response.json({error:"PRIVATE_PROVIDER_MESSAGE"}, {status:403});
  const res = await handleCallback(cb("state=" + state + "&code=sample-code"), client, spy);
  checkRedirect(res, "profile-forbidden");
  assert.doesNotMatch(JSON.stringify([...res.headers]), /PRIVATE_ACCESS_TOKEN|PRIVATE_PROVIDER_MESSAGE/);
});

test("missing, mismatched, malformed or duplicate cookie state prevents exchange", async () => {
  let count = 0;
  const spy = async () => { count++; throw Error("never request"); };
  const cases = [
    req("/oauth/callback?state=" + state + "&code=hello"),
    cb("state=" + "z".repeat(43) + "&code=hello"),
    cb("state=invalid&code=hello"),
    cb("state=" + state + "&code=hello", {
      headers: { Cookie: cookie + "; __Host-losp_oauth_state=" + state }
    }),
    cb("state=" + state + "&code=hello", {
      headers: { Cookie: "__Host-losp_oauth_state=" + state }
    })
  ];
  for (const input of cases) checkRedirect(await handleCallback(input, client, spy), "invalid");
  assert.equal(count, 0);
});

test("OAuth refusal with matching state performs no token exchange", async () => {
  checkRedirect(await handleCallback(
    cb("state=" + state + "&error=access_denied&error_description=private"),
    client,
    async () => { throw Error("must not exchange"); }
  ), "denied");
});

test("missing code or oversized code are rejected without exchange", async () => {
  const spy = async () => { throw Error("must not exchange"); };
  checkRedirect(await handleCallback(cb("state=" + state), client, spy), "invalid");
  checkRedirect(await handleCallback(cb("state=" + state + "&code=" + "x".repeat(8193)), client, spy), "invalid");
});

test("missing runtime credentials fail closed before exchange", async () => {
  const res = await handleCallback(cb("state=" + state + "&code=hello"), {}, async () => {
    throw Error("must not exchange");
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.getSetCookie().length, 2);
});

test("known OAuth failures are classified without exposing provider details", async () => {
  for (const [oauthError, expected] of [
    ["invalid_client", "exchange-invalid-client"],
    ["invalid_grant", "exchange-invalid-grant"],
    ["invalid_request", "exchange-invalid-request"],
    ["unauthorized_client", "exchange-unauthorized-client"]
  ]) {
    const response = await handleCallback(
      cb("state=" + state + "&code=hello"), client,
      async () => Response.json({
        error: oauthError,
        error_description: "PRIVATE_SECRET_TOKEN_123"
      }, { status: 400 })
    );
    checkRedirect(response, expected);
    assert.doesNotMatch(response.headers.get("location"), /PRIVATE_SECRET|error_description|hello/);
  }
});

test("unexpected and non-JSON failures produce bounded categories", async () => {
  for (const [fake, expected] of [
    [async () => new Response("<html>PRIVATE_SECRET_TOKEN_123</html>", { status: 401 }), "exchange-http-auth"],
    [async () => new Response("unavailable", { status: 503 }), "exchange-server"],
    [async () => Response.json({error: "PRIVATE_SECRET_TOKEN_123"}, { status: 400 }), "exchange-http-400"],
    [async () => Response.json({ token_type: "Bearer" }), "exchange-unexpected-response"],
    [async () => { throw Error("PRIVATE_SECRET_TOKEN_123"); }, "exchange-fetch-error"],
    [async () => { throw new TypeError("PRIVATE_SECRET_TOKEN_123"); }, "exchange-fetch-type-error"],
    [async () => { throw new DOMException("PRIVATE_SECRET_TOKEN_123", "TimeoutError"); }, "exchange-timeout"],
    [async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/PRIVATE_SECRET_TOKEN_123" } }), "exchange-redirect"]
  ]) {
    const response = await handleCallback(cb("state=" + state + "&code=hello"), client, fake);
    checkRedirect(response, expected);
    assert.doesNotMatch(JSON.stringify([...response.headers]), /PRIVATE_SECRET|hello/);
  }
});

test("redirect handling never follows or exposes target location", async () => {
  let captured;
  const response = await handleCallback(
    cb("state=" + state + "&code=hello"), client,
    async (_url, requestInit) => {
      captured = requestInit;
      return new Response(null, {
        status: 307,
        headers: { Location: "https://PRIVATE_SECRET_TOKEN_123.evil.example/" }
      });
    }
  );
  assert.equal(captured.redirect, "manual");
  checkRedirect(response, "exchange-redirect");
  assert.doesNotMatch(JSON.stringify([...response.headers]), /PRIVATE_SECRET_TOKEN_123|evil.example/);
});

test("profile authorization failure pages use fixed non-sensitive messages", async () => {
  for (const [status, title] of [
    ["profile-unauthorized", "401"],
    ["profile-forbidden", "403"],
    ["profile-no-access", "464"]
  ]) {
    const res = handleOAuthStatus(req("/oauth/status?result=" + status +
      "&detail=PRIVATE_ACCESS_TOKEN"));
    const html = await res.text();
    assert.match(html, new RegExp(title));
    assert.doesNotMatch(html, /PRIVATE_ACCESS_TOKEN/);
    assert.match(res.headers.get("cache-control"), /no-store/);
  }
});

test("OAuth status page shows only predefined diagnostic texts", async () => {
  const invalidClient = await handleOAuthStatus(req("/oauth/status?result=exchange-invalid-client")).text();
  assert.match(invalidClient, /Identifiants OAuth refusés/);
  const grant = await handleOAuthStatus(req("/oauth/status?result=exchange-invalid-grant")).text();
  assert.match(grant, /Code d'autorisation refusé/);
  const sanitized = await handleOAuthStatus(
    req("/oauth/status?result=exchange-invalid-client&error_description=PRIVATE_SECRET")
  ).text();
  assert.doesNotMatch(sanitized, /PRIVATE_SECRET/);
});

test("callback requires GET and correct origin", async () => {
  assert.equal((await handleCallback(cb("state=" + state, { method: "POST" }), client)).status, 405);
  assert.equal((await handleCallback(
    new Request("https://preview.example.workers.dev/oauth/callback"), client)).status, 404);
});

test("result page escapes all user-controlled URL values with fixed messages", async () => {
  const res = handleOAuthStatus(req("/oauth/status?result=%3Cscript%3Ealert(1)%3C/script%3E"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await res.text();
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Vérification de sécurité/);
  const success = await handleOAuthStatus(req("/oauth/status?result=validated")).text();
  assert.match(success, /aucun token n'a été conservé/);
});

test("router preserves login, health and existing home routes", async () => {
  const health = await worker.fetch(req("/health"), client);
  assert.deepEqual(await health.json(), {
    status: "ok", service: "losp-roster-service", version: "0.1.2"
  });
  assert.equal((await worker.fetch(req("/"), client)).status, 302);
  const status = await worker.fetch(req("/oauth/status?result=denied"), client);
  assert.equal(status.status, 200);
  const login = await worker.fetch(req("/login"), client);
  assert.equal(login.status, 302);
});
