import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import { probeAllianceProfiles, renderAllianceProfiles } from "../src/profiles-test.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const token="PRIVATE_ACCESS_TOKEN", state="a".repeat(43),verifier="b".repeat(43);
const alliance={name:"Zeus <script>PRIVATE_XSS</script>",count:24,tcp:7550000000,
 avgTcp:314000000,warRank:196,raidRank:90,warTrophies:1234,warLeague:{name:"Diamond II"},
 wwTier:42,description:"PRIVATE_DESCRIPTION"};
const members=Array.from({length:24},(_,i)=>({
 id:"member-"+i,card:{name:"Player "+i,rosterShare:true},isSelf:i===0
}));
const player=i=>({name:"Player "+i,tcp:314000000,latestArena:44,bestArena:5,
  charactersAtMaxStarRank:50,wwPoints:999,aid:"PRIVATE_AID"});

test("new login reuses existing alliance permissions, others unchanged",async()=>{
 const env={SCOPELY_CLIENT_ID:"client"};
 const cases=[
  ["/login","openid m3p.f.pr.pro",2],
  ["/login/alliance-test","openid m3p.f.pr.pro m3p.f.ar.pro",3],
  ["/login/roster-scope-test","openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.pr.ros",4],
  ["/login/inventory-test","openid m3p.f.pr.pro m3p.f.pr.inv",3],
  ["/login/profiles-test","openid m3p.f.pr.pro m3p.f.ar.pro",3]
 ];
 for(const [path,scope,nCookies] of cases){
  const response=await worker.fetch(new Request(origin+path),env);
  assert.equal(response.status,302);
  const oauth=new URL(response.headers.get("location"));
  assert.equal(oauth.searchParams.get("scope"),scope);
  assert.equal(response.headers.getSetCookie().length,nCookies);
  if(path==="/login/profiles-test"){
   const cookie=response.headers.getSetCookie().find(s=>s.startsWith("__Host-losp_oauth_profiles_test="));
   assert.ok(cookie);
   assert.match(cookie,/Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
   assert.ok(cookie.includes("="+oauth.searchParams.get("state")+";"));
  }
 }
});

test("24 member cards after independent alliance card; no unapproved data in HTML",async()=>{
 const seen=[];let active=0,peak=0;
 const report=await probeAllianceProfiles(token,async(url,options)=>{
  seen.push(url);
  assert.equal(options.method,"GET");
  assert.equal(options.headers.Authorization,"Bearer "+token);
  assert.equal(options.headers["User-Agent"],"APIClient/1.0 (Server)");
  assert.ok(options.headers["x-api-key"]);
  assert.equal(options.cache,"no-store");
  assert.equal(options.redirect,"manual");
  if(url.endsWith("/alliance/card"))return Response.json({data:alliance});
  if(url.endsWith("/alliance/members"))return Response.json({data:members});
  const m=url.match(/\/card\/member\/member-(\d+)$/);
  assert.ok(m,"Unknown API URL");
  active++;peak=Math.max(peak,active);
  await Promise.resolve();
  active--;
  return Response.json({data:player(Number(m[1]))});
 });
 assert.equal(report.status,"complete");
 assert.equal(report.checked,24);
 assert.equal(report.available,24);
 assert.equal(report.memberCount,24);
 assert.equal(report.fieldCounts.latestArena,24);
 assert.equal(report.fieldCounts.bestArena,24);
 assert.equal(report.fieldCounts.wwPoints,undefined);
 assert.ok(peak<=3);
 assert.equal(seen.length,26);
 assert.match(seen[2],/\/card\/member\/member-1$/);
 const page=renderAllianceProfiles(report);
 assert.equal(page.status,200);
 assert.equal(page.headers.getSetCookie().length,3);
 assert.match(page.headers.get("cache-control"),/no-store/);
 assert.match(page.headers.get("content-security-policy"),/script-src 'nonce-/);
 const html=await page.text();
 assert.match(html,/Classement saison de guerre \(warRank\)/);
 assert.match(html,/196/);
 assert.match(html,/Zeus &lt;script&gt;PRIVATE_XSS&lt;\/script&gt;/);
 assert.doesNotMatch(html,/PRIVATE_DESCRIPTION|PRIVATE_AID|PRIVATE_ACCESS_TOKEN|member-1|wwPoints|wwTier|World Warrior/);
 assert.match(html,/history.replaceState/);
});

test("first other member 403 stops rather than making 24 requests",async()=>{
 const seen=[];
 const report=await probeAllianceProfiles(token,async url=>{
  seen.push(url);
  if(url.endsWith("/alliance/card"))return Response.json({data:alliance});
  if(url.endsWith("/alliance/members"))return Response.json({data:members});
  return new Response("PRIVATE_DENIAL",{status:403});
 });
 assert.equal(seen.length,3);
 assert.equal(report.status,"first-member-refused");
 assert.equal(report.checked,1);
 assert.equal(report.firstStatus,"403");
 const html=await renderAllianceProfiles(report).text();
 assert.match(html,/Accès interdit \(403\)/);
 assert.doesNotMatch(html,/PRIVATE_DENIAL/);
});

test("429 during batch aborts later batches",async()=>{
 let calls=0;
 const report=await probeAllianceProfiles(token,async url=>{
  calls++;
  if(url.endsWith("/alliance/card"))return Response.json({data:alliance});
  if(url.endsWith("/alliance/members"))return Response.json({data:members});
  if(calls===4)return new Response("",{status:429});
  return Response.json({data:player(calls)});
 });
 assert.equal(report.status,"partial");
 assert.equal(report.checked,4);
 assert.equal(calls,6);
 assert.equal(report.errors["429"],1);
});

test("invalid lists and empty IDs never trigger member requests",async()=>{
 for(const mock of [{data:null},{data:{}},{data:[{id:"no-card"}]},
   {data:Array(31).fill({card:{name:"x"}})}]){
  const seen=[];
  const report=await probeAllianceProfiles(token,async url=>{
   seen.push(url);
   return url.endsWith("/alliance/card")?Response.json({data:alliance}):Response.json(mock);
  });
  assert.equal(report.status,"invalid-members");
  assert.equal(seen.length,2);
 }
 const seen=[];
 const report=await probeAllianceProfiles(token,async url=>{
  seen.push(url);
  return url.endsWith("/alliance/card")
   ?Response.json({data:alliance})
   :Response.json({data:[{id:"",card:{name:"No ID"}}]});
 });
 assert.equal(report.status,"no-identifiers");
 assert.equal(seen.length,2);
});

test("alliance card 403 does not prevent profile audit",async()=>{
 const rows=[{id:"other",card:{name:"Miky"}},{id:"self",card:{name:"Keryas"},isSelf:true}];
 const seen=[];
 const report=await probeAllianceProfiles(token,async url=>{
  seen.push(url);
  if(url.endsWith("/alliance/card"))return new Response("",{status:403});
  if(url.endsWith("/alliance/members"))return Response.json({data:rows});
  return Response.json({data:player(1)});
 });
 assert.equal(report.alliance.status,"403");
 assert.equal(report.status,"complete");
 assert.equal(report.checked,2);
 assert.equal(seen.length,4);
});

test("callback only runs opt-in test if cookie matches OAuth state",async()=>{
 const basic="__Host-losp_oauth_state="+state+"; __Host-losp_oauth_verifier="+verifier;
 const env={SCOPELY_CLIENT_ID:"id",SCOPELY_CLIENT_SECRET:"secret"};
 for(const [marker,expected] of [
  ["; __Host-losp_oauth_profiles_test="+state,true],
  ["; __Host-losp_oauth_profiles_test="+"z".repeat(43),false]
 ]){
  const seen=[];
  const response=await handleCallback(new Request(origin+
    "/oauth/callback?state="+state+"&code=PRIVATE_CODE",{headers:{Cookie:basic+marker}}),
    env,async url=>{
     seen.push(url);
     if(url.includes("/oauth2/token"))return Response.json({access_token:token,token_type:"Bearer"});
     if(url.endsWith("/alliance/card"))return Response.json({data:alliance});
     if(url.endsWith("/alliance/members"))return Response.json({data:[{id:"other",card:{name:"Miky"}}]});
     if(url.includes("/card/member/"))return Response.json({data:player(1)});
     if(url.endsWith("/player/v1/card"))return Response.json({data:{name:"Own profile"}});
     throw Error("Unknown API URL");
    });
  assert.equal(response.status,200);
  const html=await response.text();
  if(expected){
    assert.equal(seen.length,4);
    assert.match(html,/Diagnostic des profils de l’alliance/);
    assert.doesNotMatch(html,/PRIVATE_CODE|PRIVATE_ACCESS_TOKEN|PRIVATE_AID/);
  }else{
    assert.equal(seen.length,2);
    assert.match(html,/Own profile/);
  }
 }
});

test("missing token and failed membership call are safe",async()=>{
 const missing=await probeAllianceProfiles("",async()=>{throw Error("should not call");});
 assert.equal(missing.status,"missing-token");
 const report=await probeAllianceProfiles(token,async()=>new Response("PRIVATE_BODY",{status:500}));
 assert.equal(report.status,"members-failed");
 assert.doesNotMatch(await renderAllianceProfiles(report).text(),/PRIVATE_BODY|PRIVATE_ACCESS_TOKEN/);
});
