import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { publicIconUrl, summarizeIsoIcons, probeIsoIcons, renderIsoIcons } from "../src/iso-icons-test.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const state = "a".repeat(43), verifier = "b".repeat(43);
const token = "PRIVATE_ACCESS_TOKEN";
const cdn = "https://assets.marvelstrikeforce.com/imgs/";
const official = suffix => cdn + "ICON_EXTRA_ABILITY_ISO8_" + suffix + "_ae128ffa.png";
const ability = name => ({
  name: "PRIVATE_NAME_" + name,
  icons: [official(name + "_0"), official(name + "_1"),
    official(name + "_2"), official(name + "_3"), official(name + "_4")]
});
const payload = {data: {
  striker: ability("STRIKER"), raider: ability("RAIDER"),
  skirmisher: ability("SKIRMISHER"), healer: ability("HEALER"),
  fortifier: ability("FORTIFIER")
}};

test("optional route keeps OAuth PKCE scopes and existing routes unchanged", async () => {
  const env = {SCOPELY_CLIENT_ID:"public-client-id"};
  const cases = [
    ["/login","openid m3p.f.pr.pro",2],
    ["/login/profiles-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/coverage-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/metrics-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/card-types-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/inventory-test","openid m3p.f.pr.pro m3p.f.pr.inv",3],
    ["/login/roster-scope-test","openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros",4],
    ["/login/iso-icons-test","openid m3p.f.pr.pro",3]
  ];
  for (const [path, scopes, cookies] of cases) {
    const res = await worker.fetch(new Request(origin + path), env);
    assert.equal(res.status,302);
    const oauth = new URL(res.headers.get("location"));
    assert.equal(oauth.searchParams.get("scope"),scopes);
    assert.equal(oauth.searchParams.get("code_challenge_method"),"S256");
    assert.equal(res.headers.getSetCookie().length,cookies);
    if (path === "/login/iso-icons-test") {
      const marker = res.headers.getSetCookie().find(x =>
        x.startsWith("__Host-losp_oauth_iso_icons_test="));
      assert.ok(marker && marker.includes("=" + oauth.searchParams.get("state") + ";"));
      assert.match(marker,/Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    }
  }
  assert.equal((await worker.fetch(new Request(origin+"/login/iso-icons-test",
    {method:"POST"}),env)).status,405);
});

test("one official GET returns five class icon sequences and safe tier four", async () => {
  const calls=[];
  const report=await probeIsoIcons(token,async(url,opts)=>{
    calls.push(url);
    assert.equal(opts.method,"GET");
    assert.equal(opts.headers.Authorization,"Bearer "+token);
    assert.equal(opts.headers["User-Agent"],"APIClient/1.0 (Server)");
    assert.ok(opts.headers["x-api-key"]);
    assert.equal(opts.cache,"no-store");
    assert.equal(opts.redirect,"manual");
    assert.ok(opts.signal);
    return Response.json(payload);
  });
  assert.deepEqual(calls,["https://api.marvelstrikeforce.com/game/v1/iso8Abilities"]);
  assert.equal(report.status,"ok");
  assert.equal(report.classes.length,5);
  for (const entry of report.classes) {
    assert.equal(entry.status,"ok");
    assert.equal(entry.count,5);
    assert.equal(entry.slots[0].index,0);
    assert.equal(entry.slots[4].index,4);
    assert.equal(entry.slots[4].state,"official-url");
    assert.ok(entry.slots[4].url.startsWith(cdn));
  }
  const response=renderIsoIcons(report);
  assert.equal(response.status,200);
  assert.equal(response.headers.getSetCookie().length,3);
  assert.match(response.headers.get("cache-control"),/no-store/);
  assert.match(response.headers.get("content-security-policy"),/img-src https:\/\/assets\.marvelstrikeforce\.com/);
  assert.match(response.headers.get("content-security-policy"),/script-src 'nonce-/);
  assert.equal(response.headers.get("x-frame-options"),"DENY");
  const html=await response.text();
  assert.match(html,/Tier 4/);
  assert.match(html,/Striker/);
  assert.match(html,/history.replaceState/);
  assert.match(html,/referrerpolicy="no-referrer"/);
  assert.match(html,/URL officielle/);
  assert.match(html,/ICON_EXTRA_ABILITY_ISO8_STRIKER_4_ae128ffa.png/);
  assert.doesNotMatch(html,/PRIVATE_ACCESS_TOKEN|PRIVATE_NAME_/);
});

test("public asset URL allowlist rejects redirects, malicious hosts and query secrets", () => {
  const allowed=official("ASSASSIN_4");
  assert.equal(publicIconUrl(allowed),allowed);
  for (const bad of [
    "https://assets.marvelstrikeforce.com.evil.test/imgs/ICON_EXTRA.png",
    "https://evil.test/imgs/picture.png",
    "http://assets.marvelstrikeforce.com/imgs/a.png",
    "https://assets.marvelstrikeforce.com/imgs/a.png?token=PRIVATE_TOKEN",
    "https://assets.marvelstrikeforce.com/imgs/a.png#PRIVATE_HASH",
    "https://user:secret@assets.marvelstrikeforce.com/imgs/a.png",
    "https://assets.marvelstrikeforce.com:444/imgs/a.png",
    "javascript:alert(1)",
    "data:image/png;base64,PRIVATE_BASE64",
    "https://assets.marvelstrikeforce.com/imgs/../../private.png",
    "https://assets.marvelstrikeforce.com/private/a.png",
    "https://assets.marvelstrikeforce.com/imgs/a.svg",
    "<script>PRIVATE_XSS</script>",
    null, 500, {}
  ]) assert.equal(publicIconUrl(bad),null);
});

test("unrecognized icons never expose upstream URL or load external images", async () => {
  const upstream="https://bad.example/SECRET_ID.png?bearer=PRIVATE_TOKEN";
  const output=summarizeIsoIcons({
    striker:{icons:[upstream,"javascript:alert(1)",null]},
    raider:{icons:[official("RAIDER_3")]},
    skirmisher:{icons:[]},
    healer:{icons:Array(17).fill(official("HEALER"))}
  });
  assert.equal(output.status,"ok");
  assert.equal(output.classes[0].slots[0].state,"unrecognized-url");
  assert.equal(output.classes[0].slots[1].state,"unrecognized-url");
  assert.equal(output.classes[0].slots[2].state,"empty");
  assert.equal(output.classes[2].count,0);
  assert.equal(output.classes[3].status,"too-many-icons");
  assert.equal(output.classes[4].status,"absent");
  const html=await renderIsoIcons(output).text();
  assert.doesNotMatch(html,/bad\.example|SECRET_ID|PRIVATE_TOKEN|javascript:alert|PRIVATE_XSS/);
  assert.match(html,/unrecognized-url/);
});

test("missing or short sequences do not invent tier four or new colors",async()=>{
  const result=summarizeIsoIcons({
    striker:{icons:[official("STRIKER_0"),official("STRIKER_1"),official("STRIKER_2"),official("STRIKER_3")]},
    raider:{icons:[]},
    skirmisher:{},
    healer:null,
    fortifier:{icons:[official("FORTIFIER_0"), official("FORTIFIER_1")]}
  });
  const html=await renderIsoIcons(result).text();
  assert.equal(result.classes[0].slots.length,4);
  assert.match(html,/Indice 4 \(tier 4 potentiel\) : absent/);
  assert.equal(result.classes[3].status,"absent");
  assert.doesNotMatch(html,/orange confirmé|Orange confirmé/);
});

test("HTTP 401, 403, 429, 464, malformed JSON and redirect never leak bodies",async()=>{
  for(const status of [401,403,429,464,500]) {
    let calls=0;
    const report=await probeIsoIcons(token,async()=>{
      calls++;return new Response("PRIVATE_ERROR_BODY",{status});
    });
    assert.equal(calls,1);
    assert.equal(report.status,"http-error");
    assert.equal(report.http,status);
    const html=await renderIsoIcons(report).text();
    assert.match(html,new RegExp("HTTP "+status));
    assert.doesNotMatch(html,/PRIVATE_ERROR_BODY/);
  }
  const redirect=await probeIsoIcons(token,async() =>
    new Response(null,{status:302,headers:{Location:"https://evil.example/SECRET"}}));
  assert.equal(redirect.status,"redirect");
  const invalid=await probeIsoIcons(token,async()=>
    new Response("PRIVATE_BAD_JSON",{status:200}));
  assert.equal(invalid.status,"invalid-json");
  assert.equal(summarizeIsoIcons(["wrong"]).status,"invalid-data");
  assert.equal((await probeIsoIcons("",async()=>{throw Error("must not call") })).status,"missing-token");
});

test("state-bound opt-in callback executes exactly one game GET and clears cookies",async()=>{
  const base="__Host-losp_oauth_state="+state+"; __Host-losp_oauth_verifier="+verifier;
  const env={SCOPELY_CLIENT_ID:"id",SCOPELY_CLIENT_SECRET:"secret"};
  for (const [marker, optIn] of [
    ["; __Host-losp_oauth_iso_icons_test="+state,true],
    ["; __Host-losp_oauth_iso_icons_test="+"z".repeat(43),false]
  ]) {
    const urls=[];
    const response=await handleCallback(
      new Request(origin+"/oauth/callback?state="+state+"&code=PRIVATE_OAUTH_CODE",{
        headers:{Cookie:base+marker}}),
      env,async(url)=>{
        urls.push(url);
        if(url.includes("/oauth2/token")) return Response.json({
          access_token:token,token_type:"Bearer"
        });
        if(url.endsWith("/game/v1/iso8Abilities")) return Response.json(payload);
        if(url.endsWith("/player/v1/card")) return Response.json({data:{name:"SELF_TEST_NAME"}});
        throw Error("Unexpected URL");
      }
    );
    assert.equal(response.status,200);
    const html=await response.text();
    if(optIn) {
      assert.equal(urls.length,2); // One OAuth code exchange + ONE Scopely game GET
      assert.equal(response.headers.getSetCookie().length,3);
      assert.match(html,/Diagnostic des icônes ISO-8/);
      assert.doesNotMatch(html,/PRIVATE_OAUTH_CODE|PRIVATE_ACCESS_TOKEN|SELF_TEST_NAME/);
    } else {
      assert.equal(urls.length,2);
      assert.match(html,/SELF_TEST_NAME/);
      assert.doesNotMatch(html,/Diagnostic des icônes ISO-8/);
    }
  }
});
