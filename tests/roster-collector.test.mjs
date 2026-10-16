import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import {
  collectAllianceRosterSample, renderRosterCollectionSample
} from "../src/roster-collector.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const TOKEN = "PRIVATE_ACCESS_TOKEN";
const state = "a".repeat(43), verifier = "b".repeat(43);
const cookies = "__Host-losp_oauth_state=" + state +
  "; __Host-losp_oauth_verifier=" + verifier +
  "; __Host-losp_oauth_collection_test=" + state;
const env = { SCOPELY_CLIENT_ID: "client", SCOPELY_CLIENT_SECRET: "secret" };
const members = [
  { id: "self", isSelf: true, card: { name: "Self", rosterShare: true } },
  ...["x1", "x2", "x3", "x4"].map(id => ({
    id, isSelf: false, card: { name: "PRIVATE_" + id, rosterShare: true }
  })),
  { id: "hidden", isSelf: false, card: { name: "PRIVATE_HIDDEN", rosterShare: false } }
];
const roster = id => Array.from({ length: 207 },
  (_, i) => ({ id: id + "-char-" + i, power: 111, iso8: { class: "striker" } }));
function server(calls, custom) {
  return async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.Authorization, "Bearer " + TOKEN);
    assert.ok(opts.headers["x-api-key"]);
    assert.equal(opts.headers["User-Agent"], "APIClient/1.0 (Server)");
    assert.equal(opts.redirect, "manual");
    assert.equal(opts.cache, "no-store");
    if (custom) {
      const result = custom(url, calls.length);
      if (result) return result;
    }
    if (url.endsWith("/alliance/members")) return Response.json({ data: members });
    const target = new URL(url);
    const parts = target.pathname.split("/");
    const id = parts.at(-1), page = Number(target.searchParams.get("page"));
    const perPage = Number(target.searchParams.get("perPage"));
    assert.equal(target.searchParams.get("statsFormat"), "csv");
    const items = roster(id);
    return Response.json({
      data: items.slice((page - 1) * perPage, page * perPage),
      meta: { page, perPage, perTotal: items.length, asOf: "snapshot-1" }
    });
  };
}

test("the opt-in pilot changes no other scopes and uses state-bound OAuth", async () => {
  for (const [path, expected, count] of [
    ["/login", "openid m3p.f.pr.pro", 2],
    ["/login/alliance-scope-test", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros", 3],
    ["/login/alliance-collection-test", "openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros", 3]
  ]) {
    const res = await worker.fetch(new Request(origin + path), env);
    assert.equal(res.status, 302);
    const dest = new URL(res.headers.get("location"));
    assert.equal(dest.searchParams.get("scope"), expected);
    assert.equal(dest.searchParams.get("code_challenge_method"), "S256");
    assert.equal(res.headers.getSetCookie().length, count);
    if (path.includes("collection")) {
      assert.match(res.headers.getSetCookie().join(";"),
        /__Host-losp_oauth_collection_test=/);
      assert.match(res.headers.getSetCookie().join(";"), /HttpOnly/);
    }
  }
});

test("three complete paginated shared rosters, no self or opt-out request", async () => {
  const calls = [];
  const result = await collectAllianceRosterSample(TOKEN, server(calls));
  assert.equal(result.status, "complete");
  assert.deepEqual({
    memberCount: result.memberCount, sharedCount: result.sharedCount,
    selectedCount: result.selectedCount, completedCount: result.completedCount,
    characterCount: result.characterCount, pages: result.pages, requests: result.requests
  }, {
    memberCount: 6, sharedCount: 4, selectedCount: 3,
    completedCount: 3, characterCount: 621, pages: 9, requests: 10
  });
  assert.equal(result.rosters.length, 3);
  for (const item of result.rosters) assert.equal(item.chars.length, 207);
  assert.ok(calls.every(x => !x.includes("/hidden") && !x.includes("/self")));
  assert.equal(calls.filter(x => x.includes("/roster/member/")).length, 9);
  const res = renderRosterCollectionSample(result);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(res.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.equal(res.headers.getSetCookie().length, 3);
  const html = await res.text();
  assert.match(html, /621/);
  assert.match(html, /history.replaceState/);
  assert.doesNotMatch(html, /PRIVATE_|x1-char|x2-char|x3-char|Bearer/);
});

test("unshared players are not read, empty candidate group performs one GET", async () => {
  const calls = [];
  const result = await collectAllianceRosterSample(TOKEN, server(calls, url =>
    url.endsWith("/alliance/members")
      ? Response.json({ data: [
        { id: "self", isSelf: true, card: { rosterShare: true } },
        { id: "no", isSelf: false, card: { rosterShare: false } }
      ] }) : null
  ));
  assert.equal(result.status, "complete");
  assert.equal(result.completedCount, 0);
  assert.equal(result.sharedCount, 0);
  assert.equal(calls.length, 1);
});

test("429 stops all work immediately without retrying or exposing private data", async () => {
  const calls = [];
  const result = await collectAllianceRosterSample(TOKEN, server(calls, url =>
    url.includes("/roster/member/")
      ? new Response("PRIVATE_PROVIDER_BODY", { status: 429, headers: { "Retry-After": "80" } })
      : null
  ));
  assert.equal(result.status, "rate-limited");
  assert.equal(calls.length, 2);
  assert.equal(result.rosters, undefined);
  assert.doesNotMatch(await renderRosterCollectionSample(result).text(), /PRIVATE_/);
});

test("503, 552, 553 and permission denial fail closed and perform no retries", async () => {
  for (const [code, status] of [
    [503, "service-unavailable"], [552, "service-unavailable"],
    [553, "service-unavailable"], [403, "forbidden"], [464, "no-access"]
  ]) {
    const calls = [];
    const r = await collectAllianceRosterSample(TOKEN, server(calls,
      url => url.includes("/roster/member/") ? new Response("PRIVATE_SECRET", { status: code }) : null));
    assert.equal(r.status, status);
    assert.equal(calls.length, 2);
    assert.equal(r.rosters, undefined);
  }
});

test("472 halves the page size and restarts from page 1, preserving complete data", async () => {
  const calls = [];
  let once = false;
  const r = await collectAllianceRosterSample(TOKEN, server(calls, url => {
    if (url.includes("/roster/member/") && !once) {
      once = true;
      return new Response("PRIVATE_TOO_LARGE", { status: 472 });
    }
    return null;
  }), { maxMembers: 1 });
  assert.equal(r.status, "complete");
  assert.equal(r.rosters[0].chars.length, 207);
  assert.match(calls[1], /page=1&perPage=100/);
  assert.match(calls[2], /page=1&perPage=50/);
  assert.equal(r.pages, 5);
});

test("duplicate characters or changed page totals abort and discard partial rosters", async () => {
  for (const reason of ["duplicate", "changed-total", "changed-asof", "wrong-page"]) {
    const calls = [];
    const r = await collectAllianceRosterSample(TOKEN, server(calls, url => {
      if (!url.includes("/roster/member/")) return null;
      const u = new URL(url), page = Number(u.searchParams.get("page"));
      if (page !== 2) return null;
      const data = roster("x1").slice(100, 200);
      if (reason === "duplicate") data[0] = { id: "x1-char-0" };
      return Response.json({ data, meta: {
        page: reason === "wrong-page" ? 3 : 2,
        perPage: 100,
        perTotal: reason === "changed-total" ? 209 : 207,
        asOf: reason === "changed-asof" ? "snapshot-2" : "snapshot-1"
      } });
    }), { maxMembers: 1 });
    assert.equal(r.status, reason === "duplicate" ? "duplicate-character" :
      reason === "wrong-page" ? "invalid-pagination" : "changed-during-read");
    assert.equal(r.rosters, undefined);
  }
});

test("a malformed member entry or malformed character object is never trusted", async () => {
  for (const [kind, expected] of [
    ["member", "invalid-members"],
    ["character", "invalid-character"]
  ]) {
    const calls = [];
    const r = await collectAllianceRosterSample(TOKEN, server(calls, url => {
      if (kind === "member" && url.endsWith("/alliance/members"))
        return Response.json({ data: [{ id: "same" }, { id: "same" }] });
      if (kind === "character" && url.includes("/roster/member/"))
        return Response.json({ data: [{ id: "" }], meta: { page: 1, perPage: 100, perTotal: 1 } });
      return null;
    }));
    assert.equal(r.status, expected);
    assert.equal(r.rosters, undefined);
  }
});

test("bad maxMembers configuration makes zero API requests", async () => {
  let calls = 0;
  const result = await collectAllianceRosterSample(TOKEN, () => { calls++; },
    { maxMembers: 101 });
  assert.equal(result.status, "invalid-configuration");
  assert.equal(calls, 0);
});

const callbackRequest = cookie => new Request(origin +
  "/oauth/callback?state=" + state + "&code=PRIVATE_AUTH_CODE", {
    headers: { Cookie: cookie }
  });

test("callback with granted scope runs one pilot; without scope it runs zero GETs", async () => {
  for (const present of [true, false]) {
    const calls = [];
    const res = await handleCallback(callbackRequest(cookies), env, async (url, opts) => {
      if (url.endsWith("/oauth2/token")) {
        calls.push(url);
        return Response.json({ access_token: TOKEN, token_type: "Bearer",
          scope: present ? "openid m3p.f.ar.pro m3p.f.ar.ros" : "openid m3p.f.ar.pro" });
      }
      return server(calls)(url, opts);
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, present ? /Collecte paginée terminée/ : /scope-not-granted/);
    assert.equal(calls.length, present ? 11 : 1);
    assert.doesNotMatch(html + JSON.stringify([...res.headers]), /PRIVATE_(ACCESS|AUTH)|x1-char-/);
    assert.equal(res.headers.getSetCookie().length, 3);
  }
});

test("stale collection cookie cannot enter private collector", async () => {
  const stale = cookies.replace("__Host-losp_oauth_collection_test=" + state,
    "__Host-losp_oauth_collection_test=" + "z".repeat(43));
  const calls = [];
  const res = await handleCallback(callbackRequest(stale), env, async (url) => {
    calls.push(url);
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: TOKEN, token_type: "Bearer", scope: "m3p.f.ar.ros" });
    if (url.endsWith("/player/v1/card"))
      return Response.json({ data: { name: "Private player", level: { completedTier: 1 } } });
    throw Error("Must not collect roster");
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(await res.text(), /Collecte paginée terminée/);
});
