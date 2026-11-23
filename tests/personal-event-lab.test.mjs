import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import worker from "../src/index.js";
import {handlePersonalEventLab} from "../src/personal-event-lab.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const DOMAIN="lab-test.cloudflareaccess.com";
const AUD="a".repeat(32);
const b64=value=>Buffer.from(typeof value==="string"?value:JSON.stringify(value)).toString("base64url");
let pair,jwk;
async function accessJwt(email="owner@example.test"){
  if(!pair){
    pair=await webcrypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
    jwk=await webcrypto.subtle.exportKey("jwk",pair.publicKey);
    jwk.kid="lab-test-key";jwk.alg="RS256";jwk.use="sig";
  }
  const h=b64({alg:"RS256",kid:jwk.kid,typ:"JWT"});
  const p=b64({iss:"https://"+DOMAIN,aud:[AUD],email,
    iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+300});
  const signed=await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,
    new TextEncoder().encode(h+"."+p));
  return h+"."+p+"."+Buffer.from(signed).toString("base64url");
}
const envFor=(scope="m3p.f.pr.act m3p.f.pr.ros m3p.f.pr.inv offline")=>({
  PERSONAL_EVENT_LAB_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:"owner@example.test",
  MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:DOMAIN,CF_ACCESS_AUD:AUD,
  MSF_ADMIN_EMAILS:"owner@example.test,other-admin@example.test",
  CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"c".repeat(64),
  CAPTAIN_BUCKET:{put:async()=>{},get:async()=>null,delete:async()=>{}},
  CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({
    status:"active",accessToken:"fake-token",scope})})}
});
const request=async(path,{method="GET",body,cookie="__Host-losp_captain_session="+"x".repeat(43),email="owner@example.test"}={})=>new Request(ORIGIN+path,{method,
  headers:{"Cf-Access-Jwt-Assertion":await accessJwt(email),"Cookie":cookie,
    ...(body?{"Content-Type":"application/json","Origin":ORIGIN}: {})},
  ...(body?{body:JSON.stringify(body)}:{})});
function mockFetch(upstream){return async(input,init)=>{
  const url=String(input);
  if(url===`https://${DOMAIN}/cdn-cgi/access/certs`)return Response.json({keys:[jwk]});
  return upstream(url,init);
};}

test("the lab is disabled by default, and requires both Access admin and the exact owner identity",async()=>{
  const noConfig=await handlePersonalEventLab(new Request(ORIGIN+"/admin/personal-event-lab"),{},async()=>{throw Error("no fetch");});
  assert.equal(noConfig.status,404);
  const env=envFor();
  const denied=await handlePersonalEventLab(await request("/admin/personal-event-lab",{email:"other-admin@example.test"}),env,
    mockFetch(async()=>{throw Error("must not call provider");}));
  assert.equal(denied.status,403);
  const notAdmin=await handlePersonalEventLab(new Request(ORIGIN+"/admin/personal-event-lab"),env,
    mockFetch(async()=>{throw Error("must not call provider");}));
  assert.equal(notAdmin.status,403);
});

test("same Worker serves a private no-store lab and reuses the existing Scopely session",async()=>{
  const env=envFor();
  const page=await handlePersonalEventLab(await request("/admin/personal-event-lab"),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(page.status,200);
  assert.match(page.headers.get("Cache-Control"),/no-store/);
  const html=await page.text();
  assert.equal((html.match(/id="progress-analysis"/g)||[]).length,1,"one analysis panel in the DOM");
  assert.equal((html.match(/progress-analysis\.js/g)||[]).length,1,"one analysis module script");
  const analysis=await handlePersonalEventLab(await request("/admin/personal-event-lab/progress-analysis.js"),env,
    mockFetch(async()=>{throw Error("analysis must not fetch Scopely");}));
  assert.equal(analysis.status,200);
  const moduleText=await analysis.text();
  assert.match(moduleText,/personal-event-selection/);
  assert.match(moduleText,/__personalEventLabLatest/);
  assert.match(moduleText,/Progression non fournie par Scopely/);
  assert.match(html,/connexion Scopely existante/i);
  let calls=0;
  const response=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/query",{method:"POST",
    body:{resource:"events",allPages:false,params:{lang:"fr",eventInfo:"full",objRewards:"full",perPage:"100"}}}),env,
    mockFetch(async(url,init)=>{
      calls++;assert.equal(init.cache,"no-store");
      assert.equal(new URL(url).searchParams.get("objRewards"),"full");
      return Response.json({meta:{page:1,perPage:100,perTotal:1},data:[{id:"sample",milestone:{}}]});
    }));
  assert.equal(response.status,200);
  assert.match(response.headers.get("Cache-Control"),/no-store/);
  const data=await response.json();
  assert.equal(calls,1);assert.equal(data.requestCount,1);
  assert.equal(data.data.data[0].id,"sample");
  assert.doesNotMatch(JSON.stringify(data),/fake-token/);
});

test("scope insufficiency is explicit and blocks Scopely calls; status lists existing grant scopes",async()=>{
  const env=envFor("m3p.f.pr.act offline");
  const invalid=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/query",{method:"POST",
    body:{resource:"detail",eventId:"e1",params:{page:"2"}}}),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(invalid.status,400);
  const roster=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/query",{method:"POST",
    body:{resource:"roster",params:{lang:"fr"}}}),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(roster.status,403);assert.equal((await roster.json()).requiredScope,"m3p.f.pr.ros");
  const status=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/status"),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.deepEqual(await status.json(),{status:"scope-insufficient",scopes:["m3p.f.pr.act","offline"],
    missingScopes:["m3p.f.pr.ros","m3p.f.pr.inv"]});
});

test("the same Worker route adds no OAuth or session flow and preserves existing session routes",async()=>{
  const env=envFor();
  const routed=await worker.fetch(await request("/admin/personal-event-lab"),env);
  assert.equal(routed.status,200);
  const inventedLogin=await worker.fetch(new Request(ORIGIN+"/login/events-lab"),env);
  assert.equal(inventedLogin.status,404);
  const home=await worker.fetch(new Request(ORIGIN+"/health"),env);
  assert.equal(home.status,200);
});

test("the lab follows pagination and reads both inventory families in parallel",async()=>{
  const env=envFor();const seen=[];
  const list=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/query",{method:"POST",
    body:{resource:"events",params:{lang:"fr",page:"1",perPage:"2"},allPages:true}}),env,
    mockFetch(async url=>{
      const page=Number(new URL(url).searchParams.get("page"));seen.push("events:"+page);
      return Response.json({meta:{page,perPage:2,perTotal:3},data:page===1?[{id:"one"},{id:"two"}]:[{id:"three"}]});
    }));
  const listBody=await list.json();assert.equal(listBody.requestCount,2);assert.equal(listBody.data.data.length,3);
  assert.deepEqual(seen,["events:1","events:2"]);
  const inv=await handlePersonalEventLab(await request("/admin/personal-event-lab/api/query",{method:"POST",
    body:{resource:"inventory",params:{lang:"none"}}}),env,mockFetch(async url=>{
      const type=new URL(url).searchParams.get("itemType");seen.push("inventory:"+type);
      return Response.json({meta:{asOf:"sample"},data:[{item:type,quantity:4}]});
    }));
  const invBody=await inv.json();assert.equal(invBody.requestCount,2);
  assert.deepEqual(Object.keys(invBody.data.itemTypes).sort(),["CONSUMABLE","ISOITEM"]);
  assert.equal(seen.filter(x=>x.startsWith("inventory:")).length,2);
});
