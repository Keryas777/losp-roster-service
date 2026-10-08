import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { probeInventory, renderInventoryProbe } from "../src/inventory-test.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const token = "PRIVATE_ACCESS_TOKEN";
const state = "a".repeat(43);
const verifier = "b".repeat(43);

test("inventory login requests only View Inventory and does not alter existing routes", async () => {
  const env = { SCOPELY_CLIENT_ID: "client-test" };
  const cases = [
    ["/login", "openid m3p.f.pr.pro", 2],
    ["/login/alliance-test", "openid m3p.f.pr.pro m3p.f.ar.pro", 3],
    ["/login/roster-scope-test", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros", 4],
    ["/login/inventory-test", "openid m3p.f.pr.pro m3p.f.pr.inv", 3]
  ];
  for (const [path, scope, cookies] of cases) {
    const res = await worker.fetch(new Request(origin + path), env);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")).searchParams.get("scope"), scope);
    assert.equal(res.headers.getSetCookie().length, cookies);
    if (path === "/login/inventory-test") {
      const marker = res.headers.getSetCookie().find(c => c.startsWith("__Host-losp_oauth_inventory_test="));
      assert.ok(marker);
      assert.match(marker, /Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      const returnedState = new URL(res.headers.get("location")).searchParams.get("state");
      assert.ok(marker.includes("=" + returnedState + ";"));
    }
  }
});

test("one authenticated inventory request is paginated and uses all headers", async () => {
  const calls = [];
  const result = await probeInventory(token, async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.headers["User-Agent"], "APIClient/1.0 (Server)");
    assert.ok(options.headers["x-api-key"]);
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "manual");
    return Response.json({ data: [
      { item: { id: "PRIVATE_ITEM_ID", name: "PRIVATE_ITEM_NAME" }, quantity: 999999 }
    ], meta: { total: 900 } });
  });
  assert.deepEqual(calls, ["https://api.marvelstrikeforce.com/player/v1/inventory?page=1&perPage=1"]);
  assert.deepEqual(result, { status: "accessible", returnedItems: 1 });
  const page = renderInventoryProbe(result);
  assert.equal(page.status, 200);
  assert.equal(page.headers.getSetCookie().length, 3);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await page.text();
  assert.match(html, /Accès à l'inventaire confirmé/);
  assert.match(html, /HTTP 200/);
  assert.match(html, /history.replaceState/);
  assert.doesNotMatch(html + JSON.stringify([...page.headers]), /PRIVATE_ITEM_ID|PRIVATE_ITEM_NAME|999999|PRIVATE_ACCESS_TOKEN/);
});

test("a successful empty inventory page counts as accessible, not an error", async () => {
  const result = await probeInventory(token, async () => Response.json({ data: [], meta: {} }));
  assert.deepEqual(result, { status: "accessible", returnedItems: 0 });
});

test("401, 403, 464 and 429 are mapped without returning provider data", async () => {
  const cases = [[401, "unauthorized"], [403, "forbidden"], [464, "no-access"], [429, "rate-limited"], [472, "too-large"]];
  for (const [code, status] of cases) {
    const result = await probeInventory(token, async () =>
      new Response("PRIVATE_API_ERROR_WITH_TOKEN", { status: code }));
    assert.deepEqual(result, { status });
    assert.doesNotMatch(await renderInventoryProbe(result).text(), /PRIVATE_API_ERROR|TOKEN/);
  }
});

test("non-JSON, invalid shape and oversized mock result are not exposed", async () => {
  const cases = [
    async () => new Response("PRIVATE_HTML_PAGE"),
    async () => Response.json({data: "PRIVATE_STRING"}),
    async () => Response.json({data: [{quantity: 1}, {quantity: 2}]}),
    async () => Response.json({data: [null]}),
    async () => { throw new Error("PRIVATE_NETWORK_ERROR"); }
  ];
  for (const provider of cases) {
    const result = await probeInventory(token, provider);
    assert.ok(["unexpected-response", "network-error"].includes(result.status));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test("no token makes no outgoing request", async () => {
  const result = await probeInventory("", async () => { throw new Error("should not call"); });
  assert.deepEqual(result, { status: "missing-token" });
});

test("rendered count cannot inject markup or script", async () => {
  const page = await renderInventoryProbe({status: "accessible",
    returnedItems: '<script>PRIVATE_XSS</script>' }).text();
  assert.doesNotMatch(page, /PRIVATE_XSS|<script>PRIVATE_XSS/);
});

test("callback calls inventory only when mode marker matches OAuth state", async () => {
  const basic = "__Host-losp_oauth_state=" + state +
    "; __Host-losp_oauth_verifier=" + verifier;
  const env = { SCOPELY_CLIENT_ID: "test-id", SCOPELY_CLIENT_SECRET: "test-secret" };
  for (const [marker, inventoryExpected] of [
    ["; __Host-losp_oauth_inventory_test=" + state, true],
    ["; __Host-losp_oauth_inventory_test=" + "z".repeat(43), false],
    ["", false]
  ]) {
    const calls = [];
    const response = await handleCallback(
      new Request(origin + "/oauth/callback?state=" + state + "&code=PRIVATE_CODE", {
        headers: { Cookie: basic + marker }
      }),
      env,
      async (url) => {
        calls.push(url);
        if (url.includes("/oauth2/token")) {
          return Response.json({access_token: token, token_type: "Bearer"});
        }
        if (url.includes("/player/v1/inventory")) {
          return Response.json({data: [{item:{id:"PRIVATE_ITEM"}, quantity: 72}]});
        }
        if (url.endsWith("/player/v1/card")) {
          return Response.json({data: {name: "Keryas test"}});
        }
        throw new Error("unexpected URL");
      }
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    const html = await response.text();
    if (inventoryExpected) {
      assert.match(calls[1], /\/player\/v1\/inventory\?/);
      assert.match(html, /inventaire MSF/);
    } else {
      assert.match(calls[1], /\/player\/v1\/card$/);
      assert.match(html, /Keryas test/);
    }
    assert.doesNotMatch(html, /PRIVATE_CODE|PRIVATE_ITEM|PRIVATE_ACCESS_TOKEN/);
  }
});
