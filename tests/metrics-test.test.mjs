import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import {
  compareMetricCards, probeMetricConsistency, renderMetricConsistency
} from "../src/metrics-test.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const state="a".repeat(43), verifier="b".repeat(43), token="PRIVATE_SECRET_TOKEN";
const alliance = { name:"PRIVATE_ALLIANCE", count:2, tcp:3000, avgTcp:1500 };
const members=[
  {id:"PRIVATE_SELF_ID", isSelf:true, card:{
    name:"PRIVATE_CAPTAIN_NAME",tcp:2000,stp:600,warMvp:4,
    charactersCollected:60, level:{completedTier:110},daysInAlliance:88
  }},
  {id:"PRIVATE_OTHER_ID", isSelf:false, card:{
    name:"PRIVATE_OTHER_NAME",tcp:1000,stp:400,warMvp:2,
    charactersCollected:40,level:{completedTier:105},daysInAlliance:35
  }}
];
const own={name:"PRIVATE_CAPTAIN_NAME",tcp:2000,stp:600,warMvp:4,
  charactersCollected:60, level:{completedTier:110},
  latestArena:24, latestBlitz:128, blitzWins:1200};
function fixture(url) {
  if(url.endsWith("/alliance/card")) return Response.json({data:alliance});
  if(url.endsWith("/alliance/members")) return Response.json({data:members});
  if(url.endsWith("/player/v1/card")) return Response.json({data:own});
  throw Error("Unexpected request");
}

test("new metrics login is opt-in and retains all older login scopes",async()=>{
 const env={SCOPELY_CLIENT_ID:"client"};
 const cases=[
   ["/login","openid m3p.f.pr.pro",2],
   ["/login/alliance-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
   ["/login/roster-scope-test","openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros",4],
   ["/login/inventory-test","openid m3p.f.pr.pro m3p.f.pr.inv",3],
   ["/login/profiles-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
   ["/login/coverage-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
   ["/login/card-types-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
   ["/login/metrics-test","openid m3p.f.pr.pro m3p.f.ar.pro",3]
 ];
 for(const [path,scope,count] of cases){
   const res=await worker.fetch(new Request(origin+path),env);
   assert.equal(res.status,302);
   const oauth=new URL(res.headers.get("location"));
   assert.equal(oauth.searchParams.get("scope"),scope);
   assert.equal(res.headers.getSetCookie().length,count);
   if(path==="/login/metrics-test"){
     const mode=res.headers.getSetCookie().find(x=>x.startsWith("__Host-losp_oauth_metrics_test="));
     assert.ok(mode && mode.includes("="+oauth.searchParams.get("state")+";"));
     assert.match(mode,/Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
   }
 }
 assert.equal((await worker.fetch(new Request(origin+"/login/metrics-test",
   {method:"POST"}),env)).status,405);
});

test("three sequential GETs only: aggregate consistency and own-card cross-check",async()=>{
 const urls=[];
 const report=await probeMetricConsistency(token,async(url,opts)=>{
   urls.push(url);
   assert.equal(opts.method,"GET");
   assert.equal(opts.headers.Authorization,"Bearer "+token);
   assert.equal(opts.headers["User-Agent"],"APIClient/1.0 (Server)");
   assert.ok(opts.headers["x-api-key"]);
   assert.equal(opts.redirect,"manual");
   assert.equal(opts.cache,"no-store");
   return fixture(url);
 });
 assert.deepEqual(urls,[
   "https://api.marvelstrikeforce.com/player/v1/alliance/card",
   "https://api.marvelstrikeforce.com/player/v1/alliance/members",
   "https://api.marvelstrikeforce.com/player/v1/card"
 ]);
 assert.equal(report.status,"ok");
 assert.equal(report.memberCount,2);
 assert.deepEqual(report.consistency,{
   memberCount:"identique",totalTcp:"identique",averageTcp:"compatible-arrondi"
 });
 assert.equal(report.comparisons.stp,"identique");
 assert.equal(report.comparisons.level,"identique");
 assert.equal(report.ownValues.daysInAlliance,88);
 assert.equal(report.ownValues.latestArena,24);
 assert.equal(report.ownValues.bestArena,null);
 const page=renderMetricConsistency(report),html=await page.text();
 assert.equal(page.status,200);
 assert.equal(page.headers.getSetCookie().length,3);
 assert.match(page.headers.get("cache-control"),/no-store/);
 assert.match(page.headers.get("content-security-policy"),/script-src 'nonce-/);
 assert.match(page.headers.get("x-frame-options"),/DENY/);
 assert.match(html,/Dernier rang Arène/);
 assert.match(html,/88/);
 assert.match(html,/history.replaceState/);
 assert.doesNotMatch(html,/PRIVATE_SECRET|PRIVATE_ALLIANCE|PRIVATE_OTHER|PRIVATE_SELF|PRIVATE_CAPTAIN/);
});

test("different data remains mismatch rather than fabricated truth",()=>{
 const out=compareMetricCards({...alliance,tcp:3100},members,{...own,warMvp:5});
 assert.equal(out.consistency.totalTcp,"différent");
 assert.equal(out.consistency.averageTcp,"différent");
 assert.equal(out.comparisons.warMvp,"différent");
 assert.equal(out.comparisons.tcp,"identique");
 assert.equal(out.ownValues.warMvp,5);
});

test("average difference within a count is rounding compatible",()=>{
 const sample=compareMetricCards({count:24,tcp:10381253767,avgTcp:432552240},
   Array.from({length:24},(_,i)=>({
     id:"id-"+i,isSelf:i===0,card:{tcp: i===23 ? 10381253767 : 0,
       level:{completedTier:100}}
   })),{name:"self"});
 assert.equal(sample.consistency.averageTcp,"compatible-arrondi");
 // An identical sum is an API arithmetic check, never proof of genuine roster values.
 assert.equal(sample.consistency.totalTcp,"identique");
});

test("missing and invalid numerics produce no incorrect comparisons",()=>{
 const corrupted=members.map((row,i)=>i===1 ? {...row,card:{...row.card,tcp:"1000"}} : row);
 const out=compareMetricCards(alliance,corrupted,{
   name:"self",tcp:-1,stp:100,warMvp:null,charactersCollected:60
 });
 assert.equal(out.consistency.totalTcp,"indisponible");
 assert.equal(out.comparisons.tcp,"type-invalide");
 assert.equal(out.comparisons.warMvp,"absent");
 assert.equal(out.ownValues.tcp,null);
 assert.equal(out.ownValues.bestArena,null);
});

test("first request denied stops without other API calls",async()=>{
 for(const http of [401,403,429,464]){
   let count=0;
   const report=await probeMetricConsistency(token,async()=>{
     count++;return new Response("PRIVATE_RESPONSE",{status:http});
   });
   assert.equal(count,1);
   assert.deepEqual(report,{status:"alliance-failed",reason:"http-error",http});
   assert.doesNotMatch(await renderMetricConsistency(report).text(),/PRIVATE_RESPONSE/);
 }
});

test("second and third request failures stop without retry",async()=>{
 for(const failedAt of [2,3]){
   let count=0;
   const report=await probeMetricConsistency(token,async url=>{
     count++;
     if(count===failedAt)return new Response("PRIVATE_SECRET",{status:429});
     return fixture(url);
   });
   assert.equal(count,failedAt);
   assert.equal(report.status,failedAt===2?"members-failed":"player-failed");
   assert.equal(report.http,429);
 }
});

test("invalid members or missing unique self prevent personal-card lookup",async()=>{
 for(const data of [
   [],
   [{id:"other",card:{name:"x"}}],
   [{id:"one",isSelf:true,card:{}},{id:"two",isSelf:true,card:{}}],
   [{id:"one",isSelf:true,card:{name:"x"}},{id:"two",isSelf:false,card:null}]
 ]){
   const seen=[];
   const out=await probeMetricConsistency(token,async url=>{
     seen.push(url);
     if(url.endsWith("/alliance/members"))return Response.json({data});
     return fixture(url);
   });
   assert.equal(out.status,"invalid-members");
   assert.equal(seen.length,2);
 }
});

test("state cookie gates audit callback and protects code and private values",async()=>{
 const env={SCOPELY_CLIENT_ID:"client",SCOPELY_CLIENT_SECRET:"secret"};
 const base="__Host-losp_oauth_state="+state+"; __Host-losp_oauth_verifier="+verifier;
 for(const [marker,valid] of [
   ["; __Host-losp_oauth_metrics_test="+state,true],
   ["; __Host-losp_oauth_metrics_test="+"z".repeat(43),false]
 ]){
   const seen=[];
   const response=await handleCallback(new Request(origin+
      "/oauth/callback?state="+state+"&code=PRIVATE_CODE",{headers:{Cookie:base+marker}}),
      env,async url=>{
        seen.push(url);
        if(url.includes("/oauth2/token"))return Response.json({access_token:token,token_type:"Bearer"});
        return fixture(url);
      });
   assert.equal(response.status,200);
   const body=await response.text();
   if(valid){
     assert.equal(seen.length,4);
     assert.equal(response.headers.getSetCookie().length,3);
     assert.match(body,/Audit de cohérence des statistiques/);
     assert.doesNotMatch(body,/PRIVATE_CODE|PRIVATE_SECRET|PRIVATE_OTHER|PRIVATE_SELF/);
   }else{
     assert.equal(seen.length,2);
     assert.match(body,/Votre profil Marvel Strike Force/);
   }
 }
});
