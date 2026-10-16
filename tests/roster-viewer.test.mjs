import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLiveRosterViewer } from "../src/roster-viewer.js";
import { collectAllianceRosterSample } from "../src/roster-collector.js";
import { handleCallback } from "../src/oauth-callback.js";
import worker from "../src/index.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const token="PRIVATE_ACCESS_TOKEN";
const state="a".repeat(43), verifier="b".repeat(43);
const cookies="__Host-losp_oauth_state="+state+
  "; __Host-losp_oauth_verifier="+verifier+
  "; __Host-losp_oauth_roster_viewer="+state;
const character=(id,name,portrait)=>({
  id,info:{name,portrait},level:110,gearTier:21,activeYellow:7,activeRed:9,power:4123456,
  iso8:{class:"striker"}
});

test("main page offers a real roster viewer link",async()=>{
 const r=await worker.fetch(new Request(origin+"/login/rosters"),{SCOPELY_CLIENT_ID:"client"});
 assert.equal(r.status,302);
 const dest=new URL(r.headers.get("location"));
 assert.equal(dest.searchParams.get("scope"),"openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros");
 assert.equal(dest.searchParams.get("code_challenge_method"),"S256");
 assert.equal(r.headers.getSetCookie().length,3);
 assert.ok(r.headers.getSetCookie().some(c=>c.startsWith("__Host-losp_oauth_roster_viewer=")));
 const other=await worker.fetch(new Request(origin+"/login/alliance-scope-test"),{SCOPELY_CLIENT_ID:"client"});
 assert.equal(new URL(other.headers.get("location")).searchParams.get("scope"),dest.searchParams.get("scope"));
});

test("authorized viewer shows real character fields, safe CDN portraits, filter and mobile UI",async()=>{
 const report={status:"complete",memberCount:24,sharedCount:23,completedCount:2,characterCount:2,
   rosters:[{memberId:"PRIVATE_MEMBER_1",name:"Ally One",chars:[
    character("hero-1","Captain Marvel","https://assets.marvelstrikeforce.com/imgs/hero.png")
   ]},{memberId:"PRIVATE_MEMBER_2",name:"Ally <script>bad()</script>",chars:[
    character("hero-2","<img src=x onerror=bad()>","https://evil.example/PRIVATE_IMAGE.png")
   ]}]};
 const r=renderLiveRosterViewer(report);
 assert.equal(r.status,200);
 assert.match(r.headers.get("cache-control"),/no-store/);
 assert.match(r.headers.get("content-security-policy"),/script-src 'nonce-/);
 assert.match(r.headers.get("content-security-policy"),/img-src https:\/\/assets\.marvelstrikeforce\.com/);
 assert.equal(r.headers.getSetCookie().length,3);
 const html=await r.text();
 assert.match(html,/Captain Marvel/);
 assert.match(html,/4\s?123\s?456|4[\u202f\u00a0 ]123[\u202f\u00a0 ]456/);
 assert.match(html,/Niv\. 110/);
 assert.match(html,/2 diamant\(s\)/);
 assert.match(html,/class="characters"/);
 assert.match(html,/data-target="member-1"/);
 assert.match(html,/type="search"/);
 assert.match(html,/history.replaceState/);
 assert.match(html,/https:\/\/assets\.marvelstrikeforce\.com\/imgs\/hero\.png/);
 assert.doesNotMatch(html,/<img src=x onerror=bad\(\)>|evil\.example|PRIVATE_MEMBER|PRIVATE_IMAGE|PRIVATE_ACCESS_TOKEN/);
 assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
test("viewer stops gracefully on no granted scope, no raw data",async()=>{
 const r=renderLiveRosterViewer({status:"scope-not-granted"});
 assert.match(await r.text(),/scope-not-granted/);
 assert.match(r.headers.get("cache-control"),/no-store/);
});
test("collector adds metadata only when specifically requested",async()=>{
 const calls=[];
 const r=await collectAllianceRosterSample(token,async(url,init)=>{
   calls.push(url);
   assert.equal(init.headers.Authorization,"Bearer "+token);
   if(url.endsWith("/alliance/members")){
     return Response.json({data:[
      {id:"self",isSelf:true,card:{rosterShare:true}},
      {id:"other",isSelf:false,card:{name:"Ally",rosterShare:true}}
     ]});
   }
   if(url.includes("/roster/member/")) return Response.json({data:[
     character("hero-1","Captain Marvel","https://assets.marvelstrikeforce.com/imgs/hero.png")
   ],meta:{page:1,perPage:100,perTotal:1}});
   throw Error("unexpected "+url);
 },{maxMembers:1,charInfo:true});
 assert.equal(r.status,"complete");
 assert.match(calls[1],/statsFormat=csv&lang=fr&charInfo=full/);
 assert.equal(r.rosters[0].chars[0].info.name,"Captain Marvel");
});
test("OAuth viewer callback uses real shared roster only with scoped consent",async()=>{
 const env={SCOPELY_CLIENT_ID:"client",SCOPELY_CLIENT_SECRET:"secret"};
 for(const permitted of [true,false]){
  const calls=[];
  const res=await handleCallback(new Request(origin+"/oauth/callback?state="+state+"&code=PRIVATE_CODE",{
    headers:{Cookie:cookies}}),env,async url=>{
    calls.push(url);
    if(url.includes("/oauth2/token"))return Response.json({access_token:token,token_type:"Bearer",
       scope:permitted?"openid m3p.f.ar.pro m3p.f.ar.ros":"openid m3p.f.ar.pro"});
    if(url.endsWith("/alliance/members"))return Response.json({data:[
       {id:"self",isSelf:true,card:{rosterShare:true}},
       {id:"ally",isSelf:false,card:{name:"Ally",rosterShare:true}}]});
    if(url.includes("/roster/member/"))return Response.json({data:[
      character("hero-1","Captain Marvel","https://assets.marvelstrikeforce.com/imgs/hero.png")
    ],meta:{page:1,perPage:100,perTotal:1}});
    throw Error("Unexpected URL: "+url);
  });
  assert.equal(res.status,200);
  assert.equal(calls.length,permitted?3:1);
  const html=await res.text();
  assert.match(html,permitted?/Captain Marvel/:/scope-not-granted/);
  assert.doesNotMatch(html,/PRIVATE_CODE|PRIVATE_ACCESS_TOKEN|Bearer/);
 }
});
