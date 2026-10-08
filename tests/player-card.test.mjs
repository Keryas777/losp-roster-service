import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlayerCard, showEphemeralPlayerCard } from "../src/player-card.js";

test("GET player card uses the three official headers and no cache", async () => {
  let called = 0;
  const output = await getPlayerCard("ONLY_IN_WORKER_TOKEN", async (url, options) => {
    called++;
    assert.equal(url, "https://api.marvelstrikeforce.com/player/v1/card");
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer ONLY_IN_WORKER_TOKEN");
    assert.equal(options.headers["x-api-key"], "17wMKJLRxy3pYDCKG5ciP7VSU45OVumB2biCzzgw");
    assert.equal(options.headers.Accept, "application/json");
    return Response.json({ data: { name: "My Player", level: { completedTier: 110 }, tcp: 1000 } });
  });
  assert.equal(called, 1);
  assert.equal(output.ok, true);
  assert.equal(output.card.name, "My Player");
});

test("unavailable token prevents any API request", async () => {
  const response = await getPlayerCard(null, async () => { throw Error("must not call"); });
  assert.deepEqual(response, { ok: false, status: "profile-unavailable" });
});

test("invalid card format, provider errors and transports yield safe statuses", async () => {
  const cases = [
    [async () => Response.json({data:null}), "profile-invalid-response"],
    [async () => Response.json({data:{name:""}}), "profile-invalid-response"],
    [async () => new Response("not JSON", {status:200}), "profile-invalid-response"],
    [async () => Response.json({error:"sensitive message"}, {status:401}), "profile-forbidden"],
    [async () => Response.json({}, {status:429}), "profile-rate-limit"],
    [async () => Response.json({}, {status:503}), "profile-unavailable"],
    [async () => new Response(null,{status:302,headers:{Location:"https://bad.example"}}), "profile-unavailable"],
    [async () => {throw new TypeError("PRIVATE_TOKEN");}, "profile-network"]
  ];
  for(const [provider, status] of cases) {
    const answer = await getPlayerCard("TOKEN", provider);
    assert.equal(answer.ok, false);
    assert.equal(answer.status, status);
    assert.equal(JSON.stringify(answer).includes("sensitive"), false);
  }
});

test("HTML display escapes hostile commander names and omits provider's other fields", async () => {
  const card = {
    name: '<img src=x onerror="alert(1)"> & "A"',
    level: { completedTier: 110 }, tcp: 1234567, stp: 555,
    charactersCollected: 333, warMvp: 11,
    privateField: "PRIVATE_UNAUTHORIZED_DATA", access_token: "PRIVATE_ACCESS_TOKEN"
  };
  const result = showEphemeralPlayerCard(card);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.match(result.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(result.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.equal(result.headers.getSetCookie().length, 2);
  const html = await result.text();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /PRIVATE_(UNAUTHORIZED_DATA|ACCESS_TOKEN)/);
  assert.match(html, /history.replaceState\(null,"","\/oauth\/status\?result=profile-expired"\)/);
  assert.doesNotMatch(html, /Bearer |code_verifier=|access_token=/);
});

test("missing numeric fields display unavailable, not zero", async () => {
  const page = await showEphemeralPlayerCard({name:"Player",tcp:0}).text();
  assert.match(page, /Non renseigné/);
  assert.match(page, /<dd>0<\/dd>/);
});

test("hostile user name cannot break HTML even with quote and ampersand", async () => {
  const page = await showEphemeralPlayerCard({name:'" onload="x" & \'<svg>'}).text();
  assert.doesNotMatch(page, /<svg>/);
  assert.match(page, /&quot; onload=&quot;x&quot; &amp; &#39;&lt;svg&gt;/);
});
