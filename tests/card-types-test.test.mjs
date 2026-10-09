import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { inspectCardTypes, probeCardTypes, renderCardTypes, jsonKind } from "../src/card-types-test.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const state = "a".repeat(43), verifier = "b".repeat(43);
const token = "PRIVATE_ACCESS_TOKEN", code = "PRIVATE_OAUTH_CODE";
const privateMemberId = "PRIVATE_MEMBER_ID";
const members = [
  {id: privateMemberId, isSelf: false, card:{name:"PRIVATE_OTHER_NAME",rosterShare:true}},
  {id: "PRIVATE_SELF_ID", isSelf:true, card:{name:"PRIVATE_SELF_NAME",rosterShare:true}}
];
const secret = "PRIVATE_PERSONAL_VALUE";
const raw = {
  name:"PRIVATE_CARD_NAME", rosterShare: {PRIVATE_NESTED_KEY: secret},
  aid: 12345, wwPoints: 99999, PRIVATE_UNEXPECTED_KEY: secret
};
function responseFor(url) {
  if (url.endsWith("/alliance/members")) return Response.json({data: members});
  if (url.includes("/card/member/")) return Response.json({data:raw});
  throw Error("Unexpected URL " + url);
}

test("new opt-in OAuth login scope and cookie; all other login modes unchanged", async () => {
  const env = {SCOPELY_CLIENT_ID:"test-public-client"};
  const cases = [
    ["/login","openid m3p.f.pr.pro",2],
    ["/login/alliance-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/roster-scope-test","openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros",4],
    ["/login/inventory-test","openid m3p.f.pr.pro m3p.f.pr.inv",3],
    ["/login/profiles-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/coverage-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
    ["/login/card-types-test","openid m3p.f.pr.pro m3p.f.ar.pro",3]
  ];
  for (const [path,scope,cookies] of cases) {
    const r = await worker.fetch(new Request(origin+path),env);
    assert.equal(r.status,302);
    assert.equal(new URL(r.headers.get("location")).searchParams.get("scope"),scope);
    assert.equal(r.headers.getSetCookie().length,cookies);
    if(path === "/login/card-types-test") {
      const marker = r.headers.getSetCookie().find(c =>
        c.startsWith("__Host-losp_oauth_card_types_test="));
      assert.ok(marker);
      assert.match(marker,/Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      assert.ok(marker.includes("="+new URL(r.headers.get("location")).searchParams.get("state")+";"));
    }
  }
  assert.equal((await worker.fetch(new Request(origin+"/login/card-types-test",{method:"POST"}),env)).status,405);
});

test("exactly two safe no-store GETs and only one non-self shared member", async () => {
  const seen=[];
  const result=await probeCardTypes(token,async(url,opts)=>{
    seen.push(url);
    assert.equal(opts.method,"GET");
    assert.equal(opts.headers.Authorization,"Bearer "+token);
    assert.equal(opts.headers["User-Agent"],"APIClient/1.0 (Server)");
    assert.ok(opts.headers["x-api-key"]);
    assert.equal(opts.cache,"no-store");
    assert.equal(opts.redirect,"manual");
    return responseFor(url);
  });
  assert.deepEqual(seen,[
    "https://api.marvelstrikeforce.com/player/v1/alliance/members",
    "https://api.marvelstrikeforce.com/player/v1/card/member/"+privateMemberId
  ]);
  assert.deepEqual(result,{
    status:"ok",rosterShare:"object",aid:"number",
    legacyField:"number",unknownCount:1
  });
  const page=renderCardTypes(result);
  assert.equal(page.status,200);
  assert.equal(page.headers.getSetCookie().length,3);
  assert.match(page.headers.get("cache-control"),/no-store/);
  assert.match(page.headers.get("content-security-policy"),/script-src 'nonce-/);
  assert.match(page.headers.get("x-frame-options"),/DENY/);
  const html=await page.text();
  assert.match(html,/rosterShare/);
  assert.match(html,/aid/);
  assert.match(html,/wwPoints \(historique, exclu\)/);
  assert.match(html,/object/);
  assert.match(html,/number/);
  assert.match(html,/history.replaceState/);
  assert.doesNotMatch(html, /PRIVATE_|12345|99999|PRIVATE_UNEXPECTED_KEY|PRIVATE_NESTED_KEY/);
});

test("types absent, null, arrays and primitive kinds; never reveal arbitrary unknown key",()=>{
  assert.equal(jsonKind(null),"null");
  assert.equal(jsonKind(null,false),"absent");
  assert.equal(jsonKind([]),"array");
  assert.equal(jsonKind(false),"boolean");
  assert.equal(jsonKind(""),"string");
  assert.equal(jsonKind(3),"number");
  const summary=inspectCardTypes({
    name:"PRIVATE_NAME",rosterShare:false,aid:null,
    PRIVATE_UNKNOWN_SECRET:"SECRET"
  });
  assert.deepEqual(summary,{
    status:"ok",rosterShare:"boolean",aid:"null",
    legacyField:"absent",unknownCount:1
  });
  const html=renderCardTypes(summary);
  return html.text().then(text=>{
    assert.doesNotMatch(text,/PRIVATE_UNKNOWN_SECRET|SECRET|PRIVATE_NAME/);
  });
});

test("single-member refusal 403 is preserved; no access to other members",async()=>{
  const paths=[];
  const result=await probeCardTypes(token,async url=>{
    paths.push(url);
    if(url.endsWith("/alliance/members")) return Response.json({data:members});
    return new Response("PRIVATE_ERROR_RESPONSE",{status:403});
  });
  assert.equal(paths.length,2);
  assert.deepEqual(result,{status:"player-failed",reason:"http-error",http:403});
  assert.doesNotMatch(await renderCardTypes(result).text(),/PRIVATE_ERROR_RESPONSE/);
});

test("401 or 429 on members stops after one request",async()=>{
  for(const http of [401,429,464]) {
    let calls=0;
    const result=await probeCardTypes(token,async()=>{
      calls++;
      return new Response("PRIVATE_BODY",{status:http});
    });
    assert.equal(calls,1);
    assert.deepEqual(result,{status:"members-failed",reason:"http-error",http});
  }
});

test("invalid/missing membership lists never trigger member-card access",async()=>{
  const cases=[
    {data:[]},
    {data:null},
    {data:[{id:privateMemberId,card:{name:"other",rosterShare:true}}]},
    {data:[{id:privateMemberId,isSelf:false,card:{name:"other",rosterShare:true}},
      {id:"self",isSelf:true,card:{name:"SELF"}}].map(row=>({
        ...row,card: {...row.card,rosterShare:false}
      }))},
    {data:[{id:"self",isSelf:true,card:{name:"SELF",rosterShare:true}},
      {id:"bad",isSelf:false,card:"invalid"}]}
  ];
  for(const payload of cases) {
    let calls=0;
    const result=await probeCardTypes(token,async()=>{
      calls++;
      return Response.json(payload);
    });
    assert.equal(calls,1);
    assert.ok(["invalid-members","no-shared-member"].includes(result.status));
  }
});

test("missing token and malformed replies stop without reflecting secrets",async()=>{
  let calls=0;
  const missing=await probeCardTypes("",async()=>{calls++;throw Error("must not call")});
  assert.equal(missing.status,"missing-token");assert.equal(calls,0);
  const failed=await probeCardTypes(token,async()=>new Response("<private />",{status:200}));
  assert.equal(failed.status,"members-failed");
  assert.match(await renderCardTypes(failed).text(),/invalid-json/);
});

test("state-bound callback executes exactly two calls and never leaks OAuth/code/data",async()=>{
  const base="__Host-losp_oauth_state="+state+
    "; __Host-losp_oauth_verifier="+verifier;
  const env={SCOPELY_CLIENT_ID:"id",SCOPELY_CLIENT_SECRET:"secret"};
  for(const [suffix,expected] of [
    ["; __Host-losp_oauth_card_types_test="+state,true],
    ["; __Host-losp_oauth_card_types_test="+"z".repeat(43),false]
  ]) {
    const seen=[];
    const response=await handleCallback(new Request(origin+
      "/oauth/callback?state="+state+"&code="+code,{headers:{Cookie:base+suffix}}),
    env,async url=>{
      seen.push(url);
      if(url.includes("/oauth2/token")) return Response.json({access_token:token,token_type:"Bearer"});
      if(url.endsWith("/player/v1/card")) return Response.json({data:{name:"OWN_TEST_NAME"}});
      return responseFor(url);
    });
    assert.equal(response.status,200);
    const body=await response.text();
    if(expected) {
      assert.equal(seen.length,3); // OAuth exchange and two authorized GETs.
      assert.match(body,/Types des champs PlayerCard/);
      assert.equal(response.headers.getSetCookie().length,3);
      assert.doesNotMatch(body,/PRIVATE_|OWN_TEST_NAME|12345|99999/);
    } else {
      assert.equal(seen.length,2);
      assert.match(body,/OWN_TEST_NAME/);
      assert.doesNotMatch(body,/Types des champs PlayerCard/);
    }
  }
});
