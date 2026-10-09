import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { probeCoverage, renderCoverage } from "../src/coverage-test.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const state = "a".repeat(43), verifier = "b".repeat(43);
const token = "PRIVATE_TOKEN";
const alliance = {
  id: "SENSITIVE_ALLIANCE_ID", name: "PRIVATE_ALLIANCE_NAME",
  warLeague: {id: 9, name: "DIAMOND II"}, level: {completedTier: 20},
  qualifications: {tcp: 100, raids: []}, count: 24, tcp: 100000,
  description: "PRIVATE_DESCRIPTION", unknownField: "PRIVATE_UNKNOWN"
};
const members = [
  {id: "PRIVATE_OTHER_ID", rank: "member", isSelf: false,
    card: {name:"PRIVATE_PLAYER_NAME", daysInAlliance: 33, rosterShare: true}},
  {id: "PRIVATE_SELF_ID", rank: "captain", isSelf: true,
    card: {name:"PRIVATE_SELF_NAME", rosterShare:true}}
];
const card = {name: "PRIVATE_MEMBER_CARD", tcp: 9999, stp: -2,
  level: {completedTier: 108, goalTier: 110}, bestArena: null,
  qualifications: {warLeague: {id: 8, name: "PRIVATE_LEAGUE"}, raids: []},
  application: {id: "PRIVATE_APP_ID", message: "PRIVATE_MESSAGE"}};
function fixture(url) {
  if (url.endsWith("/alliance/card")) return Response.json({data: alliance});
  if (url.endsWith("/alliance/members")) return Response.json({data: members});
  if (url.includes("/card/member/PRIVATE_OTHER_ID")) return Response.json({data: card});
  if (url.endsWith("/alliance/recruiting/applications")) return Response.json({data: []});
  if (url.endsWith("/recruiting/recruits?page=1&perPage=1")) {
    return Response.json({data: [{recruitId:"PRIVATE_RECRUIT_ID",
      ad:{tcp: 999, level: 99}, card:{name:"PRIVATE_RECRUIT_NAME"}}]});
  }
  throw new Error("unexpected URL: "+url);
}

test("coverage OAuth mode is opt-in, state bound and uses existing scopes", async () => {
  const env = {SCOPELY_CLIENT_ID: "PUBLIC_TEST_CLIENT"};
  for (const [path,scope,count] of [
    ["/login", "openid m3p.f.pr.pro", 2],
    ["/login/profiles-test", "openid m3p.f.pr.pro m3p.f.ar.pro", 3],
    ["/login/coverage-test", "openid m3p.f.pr.pro m3p.f.ar.pro", 3]
  ]) {
    const res = await worker.fetch(new Request(origin+path), env);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")).searchParams.get("scope"), scope);
    assert.equal(res.headers.getSetCookie().length, count);
    if (path.endsWith("/coverage-test")) {
      assert.match(res.headers.getSetCookie().join(" "),
        /__Host-losp_oauth_coverage_test=.*Secure; HttpOnly; SameSite=Lax/);
    }
  }
});

test("five GET requests maximum; field types and absence are not conflated", async () => {
  const urls = [];
  const report = await probeCoverage(token, async (url, opts) => {
    urls.push(url);
    assert.equal(opts.method, "GET");
    assert.equal(opts.headers.Authorization, "Bearer " + token);
    assert.equal(opts.headers["User-Agent"], "APIClient/1.0 (Server)");
    assert.equal(opts.cache, "no-store");
    assert.equal(opts.redirect, "manual");
    return fixture(url);
  });
  assert.equal(report.status, "complete");
  assert.equal(urls.length, 5);
  assert.equal(report.probes.alliance.fields["level.completedTier"], "type-ok");
  assert.equal(report.probes.alliance.extraKeys, 1);
  assert.equal(report.probes.members.fields["card.daysInAlliance"], "type-ok");
  assert.equal(report.probes.player.fields.bestArena, "null");
  assert.equal(report.probes.player.fields.stp, "type-invalid");
  assert.equal(report.probes.player.fields["qualifications.warLeague.name"], "type-ok");
  assert.equal(report.probes.applications.count, 0);
  assert.equal(report.probes.recruits.count, 1);
  const page = renderCoverage(report);
  assert.equal(page.status, 200);
  assert.equal(page.headers.getSetCookie().length, 3);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  const html = await page.text();
  assert.match(html, /bestArena/);
  assert.match(html, /type-invalid/);
  assert.doesNotMatch(html,
    /PRIVATE_TOKEN|PRIVATE_ALLIANCE|PRIVATE_PLAYER|PRIVATE_MEMBER|PRIVATE_RECRUIT|PRIVATE_APP|PRIVATE_MESSAGE|PRIVATE_UNKNOWN|PRIVATE_DESCRIPTION|PRIVATE_LEAGUE/);
});

test("first 429 ends immediately and reports exact status", async () => {
  const urls = [];
  const report = await probeCoverage(token, async (url) => {
    urls.push(url);
    if (urls.length === 1) return new Response("", {status: 429});
    throw Error("must stop");
  });
  assert.equal(report.status, "stopped");
  assert.equal(urls.length, 1);
  assert.equal(report.probes.alliance.http, 429);
  assert.equal(report.probes.alliance.status, "http-429");
});

test("403 on a member does not prove all routes fail; no bulk traversal", async () => {
  let count = 0;
  const report = await probeCoverage(token, async url => {
    count++;
    if (url.includes("/card/member/")) return new Response("", {status:403});
    return fixture(url);
  });
  assert.equal(count, 5);
  assert.equal(report.probes.player.http, 403);
  assert.equal(report.probes.applications.status, "ok");
  assert.equal(report.probes.recruits.status, "ok");
});

test("missing target ID never triggers member card access", async () => {
  const urls = [];
  const report = await probeCoverage(token, async url => {
    urls.push(url);
    if (url.endsWith("/alliance/members")) {
      return Response.json({data:[{id:"SELF", isSelf:true,card:{name:"SELF"}}]});
    }
    return fixture(url);
  });
  assert.equal(urls.length, 4);
  assert.equal(report.probes.player.status, "no-other-member");
  assert.ok(urls.every(url => !url.includes("/card/member/")));
});

test("callback only runs audit with matching state-bound marker", async () => {
  const cookie = "__Host-losp_oauth_state="+state+
    "; __Host-losp_oauth_verifier="+verifier+
    "; __Host-losp_oauth_coverage_test="+state;
  const seen = [];
  const response = await handleCallback(new Request(origin+
    "/oauth/callback?state="+state+"&code=PRIVATE_CODE", {headers:{Cookie:cookie}}),
    {SCOPELY_CLIENT_ID:"client", SCOPELY_CLIENT_SECRET:"secret"},
    async (url) => {
      seen.push(url);
      if (url.includes("/oauth2/token")) return Response.json({
        access_token:token,token_type:"Bearer"
      });
      return fixture(url);
    });
  assert.equal(response.status,200);
  assert.equal(seen.length,6); // One OAuth exchange and five bounded API reads.
  const html = await response.text();
  assert.match(html,/Audit ponctuel des schémas API/);
  assert.match(html,/history.replaceState/);
  assert.doesNotMatch(html,/PRIVATE_CODE|PRIVATE_TOKEN|PRIVATE_APP_ID/);
});
