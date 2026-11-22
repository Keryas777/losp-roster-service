import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {handlePersonalEventLab} from "../src/personal-event-lab.js";

const ORIGIN="https://losp-personal-event-lab.deliriousfan7.workers.dev";
const DOMAIN="lab-test.cloudflareaccess.com";
const AUD="a".repeat(32);
const b64=value=>Buffer.from(typeof value==="string"?value:JSON.stringify(value)).toString("base64url");
let pair,jwk,jwt;
async function accessToken(){
  if(jwt)return jwt;
  pair=await webcrypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  jwk=await webcrypto.subtle.exportKey("jwk",pair.publicKey);
  jwk.kid="lab-test-key";jwk.alg="RS256";jwk.use="sig";
  const h=b64({alg:"RS256",kid:jwk.kid,typ:"JWT"});
  const p=b64({iss:"https://"+DOMAIN,aud:[AUD],email:"owner@example.test",
    iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+300});
  const signed=await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,
    new TextEncoder().encode(h+"."+p));
  jwt=h+"."+p+"."+Buffer.from(signed).toString("base64url");
  return jwt;
}
const envFor=(scope="m3p.f.pr.act m3p.f.pr.ros m3p.f.pr.inv offline")=>({
  PERSONAL_EVENT_LAB_MODE:"true",MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:DOMAIN,
  CF_ACCESS_AUD:AUD,MSF_ADMIN_EMAILS:"owner@example.test",LOSP_APP_ORIGIN:ORIGIN,
  CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"c".repeat(64),
  CAPTAIN_BUCKET:{put:async()=>{},get:async()=>null,delete:async()=>{}},
  CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status:"active",accessToken:"fake-token",scope})})}
});
const request=(path,{method="GET",body,cookie="__Host-losp_captain_session="+"x".repeat(43)}={})=>new Request(ORIGIN+path,{method,
  headers:{"Cf-Access-Jwt-Assertion":jwt,"Cookie":cookie,...(body?{"Content-Type":"application/json","Origin":ORIGIN}: {})},
  ...(body?{body:JSON.stringify(body)}:{})});
function mockFetch(upstream){return async(input,init)=>{
  const url=String(input);
  if(url===`https://${DOMAIN}/cdn-cgi/access/certs`)
    return Response.json({keys:[jwk]});
  return upstream(url,init);
};}

test("the lab is disabled by default and rejects requests without verified Access identity",async()=>{
  const disabled=await handlePersonalEventLab(new Request(ORIGIN+"/captain/lab"),{},async()=>{throw Error("no fetch");});
  assert.equal(disabled.status,404);
  const env=envFor();
  const denied=await handlePersonalEventLab(new Request(ORIGIN+"/captain/lab"),env,async()=>{throw Error("no fetch");});
  assert.equal(denied.status,403);
});

test("the private UI and personalized Scopely response are no-store",async()=>{
  await accessToken();
  const env=envFor();
  const page=await handlePersonalEventLab(request("/captain/lab"),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(page.status,200);
  assert.match(page.headers.get("Cache-Control"),/no-store/);
  assert.match(await page.text(),/Laboratoire privé/);
  let calls=0;
  const response=await handlePersonalEventLab(request("/captain/lab/api/query",{method:"POST",
    body:{resource:"events",allPages:false,params:{lang:"fr",eventInfo:"full",objRewards:"full",perPage:"100"}}}),env,
    mockFetch(async(url,init)=>{
      calls++;
      assert.equal(init.cache,"no-store");
      assert.equal(new URL(url).searchParams.get("objRewards"),"full");
      return Response.json({meta:{page:1,perPage:100,perTotal:1},data:[{id:"sample",milestone:{}}]});
    }));
  assert.equal(response.status,200);
  assert.match(response.headers.get("Cache-Control"),/no-store/);
  const data=await response.json();
  assert.equal(calls,1);
  assert.equal(data.requestCount,1);
  assert.equal(data.data.data[0].id,"sample");
  assert.equal(data.calls[0].endpoint,"/player/v1/events");
});

test("the lab validates detail parameters and requires the matching scope",async()=>{
  const token=await accessToken();
  const env=envFor("m3p.f.pr.act offline");
  const invalid=await handlePersonalEventLab(request("/captain/lab/api/query",{method:"POST",
    body:{resource:"detail",eventId:"e1",params:{page:"2"}}}),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(invalid.status,400);
  const scope=await handlePersonalEventLab(request("/captain/lab/api/query",{method:"POST",
    body:{resource:"roster",params:{lang:"fr"}}}),env,mockFetch(async()=>{throw Error("unexpected");}));
  assert.equal(scope.status,403);
  assert.equal((await scope.json()).requiredScope,"m3p.f.pr.ros");
  assert.ok(token);
});

test("the lab follows list pagination and reads both inventory families in parallel",async()=>{
  await accessToken();
  const env=envFor();
  const seen=[];
  const list=await handlePersonalEventLab(request("/captain/lab/api/query",{method:"POST",
    body:{resource:"events",params:{lang:"fr",page:"1",perPage:"2"},allPages:true}}),env,
    mockFetch(async url=>{
      const page=Number(new URL(url).searchParams.get("page"));seen.push("events:"+page);
      return Response.json({meta:{page,perPage:2,perTotal:3},data:page===1?[{id:"one"},{id:"two"}]:[{id:"three"}]});
    }));
  const listBody=await list.json();
  assert.equal(listBody.requestCount,2);
  assert.equal(listBody.data.data.length,3);
  assert.deepEqual(seen,["events:1","events:2"]);

  const inv=await handlePersonalEventLab(request("/captain/lab/api/query",{method:"POST",
    body:{resource:"inventory",params:{lang:"none"}}}),env,
    mockFetch(async url=>{
      const type=new URL(url).searchParams.get("itemType");seen.push("inventory:"+type);
      return Response.json({meta:{asOf:"sample"},data:[{item:type,quantity:4}]});
    }));
  const invBody=await inv.json();
  assert.equal(invBody.requestCount,2);
  assert.deepEqual(Object.keys(invBody.data.itemTypes).sort(),["CONSUMABLE","ISOITEM"]);
  assert.equal(seen.filter(x=>x.startsWith("inventory:")).length,2);
});
