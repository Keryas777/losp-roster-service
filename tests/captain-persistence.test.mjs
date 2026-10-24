import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { handleCallback } from "../src/oauth-callback.js";
import {
  CAPTAIN_PREFIX, CAPTAIN_MAX_AGE, newCaptainSessionId, captainSessionKey,
  captainConfigReady, getCaptainRecord, putCaptainRecord
} from "../src/captain-vault.js";
import { CaptainRefreshCoordinator } from "../src/captain-refresh-coordinator.js";
import {readConnectedPersonalRoster} from "../src/connected-personal-rosters.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {createHash} from "node:crypto";
import {CONNECTED_ALLIANCE_PREFIX,listConnectedAlliances,handleConnectedAlliances} from "../src/connected-alliance-index.js";
import {
  saveCaptainConsent, handleCaptainSession, handleCaptainLogout,
  handleCaptainLanding, handleCaptainRosters, handleCaptainCoverage, renewCaptainGrants
} from "../src/captain-session-routes.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const secret="ac".repeat(32);
const scopes="openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros offline";
const token=(access,refresh)=>({access_token:access,refresh_token:refresh,
  expires_in:3600,scope:scopes,token_type:"Bearer"});
class Bucket {
  constructor(){this.map=new Map();}
  async get(key){const text=this.map.get(key);return text===undefined?null:{text:async()=>text};}
  async put(key,data){this.map.set(key,data);}
  async delete(key){this.map.delete(key);}
  async list({prefix}){return {objects:[...this.map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
const fakeResponse=data=>Response.json(data);
function setup(fetchImpl=async()=>{throw Error("No network expected");}){
  const bucket=new Bucket(), objects=new Map();
  const env={
    SCOPELY_CLIENT_ID:"test-client",SCOPELY_CLIENT_SECRET:"test-secret",
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_BUCKET:bucket,
    CAPTAIN_ENCRYPTION_KEY_HEX:secret
  };
  env.CAPTAIN_REFRESH_COORDINATOR={
    idFromName:key=>key,
    get:key=>{
      if(!objects.has(key))objects.set(key,new CaptainRefreshCoordinator({},env));
      return {fetch:req=>objects.get(key).fetch(req,fetchImpl)};
    }
  };
  return {env,bucket,objects};
}
async function store(env,id,auth=token("PRIVATE_ACCESS_A","PRIVATE_REFRESH_A"),expiresIn=3600){
  const key=await captainSessionKey(id);
  const obj=env.CAPTAIN_REFRESH_COORDINATOR.get(key);
  const res=await obj.fetch(new Request("https://internal/",{
    method:"POST",body:JSON.stringify({action:"store",key,record:{
      accessToken:auth.access_token,refreshToken:auth.refresh_token,
      expiresIn,scope:auth.scope
    }})
  }));
  return {res,key};
}
const req=(path,sessionId,extra={})=>new Request(origin+path,{
  headers:{Cookie:"__Host-losp_captain_session="+sessionId,...extra}
});

test("captain keys are opaque, vault is encrypted, wrong secrets cannot delete grants",async()=>{
  const bucket=new Bucket(),id=newCaptainSessionId(),key=await captainSessionKey(id);
  assert.match(id,/^[A-Za-z0-9_-]{43}$/);
  assert.match(key,/^oauth-captains\/v1\/[a-f0-9]{64}$/);
  assert.doesNotMatch(key,new RegExp(id));
  const now=Date.now();
  const record={version:2,createdAt:now,expiresAt:now+CAPTAIN_MAX_AGE,
    accessExpiresAt:now+3600000,accessToken:"PRIVATE_ACCESS",
    refreshToken:"PRIVATE_REFRESH",scope:scopes};
  await putCaptainRecord(bucket,secret,key,record);
  const cipher=bucket.map.get(key);
  assert.doesNotMatch(cipher,/PRIVATE_ACCESS|PRIVATE_REFRESH/);
  assert.deepEqual(await getCaptainRecord(bucket,secret,key),record);
  assert.equal(await getCaptainRecord(bucket,"bc".repeat(32),key),null);
  assert.ok(bucket.map.has(key));
  assert.equal(await getCaptainRecord(bucket,secret,key,now+CAPTAIN_MAX_AGE+1),null);
  assert.ok(bucket.map.has(key));
});

test("feature disabled, invalid secret and missing R2 block persistence",async()=>{
  const {env}=setup();
  assert.equal(captainConfigReady(env),true);
  const disabled={...env,CAPTAIN_SESSIONS_ENABLED:"false"};
  assert.equal(captainConfigReady(disabled),false);
  const noR2={...env,CAPTAIN_BUCKET:undefined};
  assert.equal(captainConfigReady(noR2),false);
  const invalid={...env,CAPTAIN_ENCRYPTION_KEY_HEX:"not-hex"};
  assert.equal(captainConfigReady(invalid),false);
  const res=await worker.fetch(new Request(origin+"/login/captain"),noR2);
  assert.equal(res.status,503);
  assert.equal(res.headers.get("location"),null);
  const ephemeral=await worker.fetch(new Request(origin+"/login/captain"),disabled);
  assert.equal(ephemeral.status,302);
});

test("captain consent sets only HttpOnly cookie after successful encrypted storage",async()=>{
  const {env,bucket}=setup();
  const res=await saveCaptainConsent(new Response("ok"),token("PRIVATE_ACCESS","PRIVATE_REFRESH"),env,
    new Request(origin+"/oauth/callback"));
  assert.equal(res.status,200);
  const cookies=res.headers.getSetCookie();
  assert.equal(cookies.length,1);
  assert.match(cookies[0],/Max-Age=15552000; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(JSON.stringify([...res.headers]),/PRIVATE_ACCESS|PRIVATE_REFRESH/);
  assert.equal(bucket.map.size,1);
  assert.doesNotMatch([...bucket.map.values()][0],/PRIVATE_ACCESS|PRIVATE_REFRESH/);
  const id=cookies[0].match(/__Host-losp_captain_session=([^;]+)/)[1];
  const state=await handleCaptainSession(req("/session",id),env);
  assert.deepEqual(await state.json(),{status:"connected"});
  assert.equal((await worker.fetch(req("/login/captain",id),env)).status,302);
  assert.equal((await worker.fetch(req("/login/captain",id),env)).headers.get("location"),origin+"/captain");
  const landing=await handleCaptainLanding(req("/captain",id),env);
  assert.match(await landing.text(),/Autorisation Scopely maintenue automatiquement/);
  assert.doesNotMatch(JSON.stringify([...landing.headers]),/PRIVATE_REFRESH/);
});

test("external captain login archives SELF roster only; never requests another member",async()=>{
  const calls=[];
  const {env,bucket}=setup();
  const granted={...token("ACCESS_OUTSIDE","REFRESH_OUTSIDE"),
    scope:scopes+" m3p.f.pr.ros"};
  const result=await saveCaptainConsent(new Response("ok"),granted,env,
    new Request(origin+"/oauth/callback"),async url=>{
      const pathname=new URL(url).pathname;
      calls.push(pathname);
      if(pathname.endsWith("/alliance/card"))return Response.json({
        data:{id:"outside:v1",name:"Alliance externe"}
      });
      if(pathname.endsWith("/alliance/members"))return Response.json({data:[
        {id:"mine",isSelf:true,card:{name:"Mon compte",rosterShare:false}},
        {id:"ally",isSelf:false,card:{name:"Autre joueur",rosterShare:true}}
      ]});
      if(pathname==="/player/v1/roster")return Response.json({data:[
        {id:"char1",power:123,info:{name:"One"}}
      ],meta:{perTotal:1,asOf:"now"}});
      throw Error("No shared member or other family should be fetched");
    });
  const cookie=result.headers.getSetCookie().join(" ");
  const id=cookie.match(/__Host-losp_captain_session=([^;]+)/)[1];
  const key=await captainSessionKey(id);
  const saved=await readConnectedPersonalRoster(env,key);
  assert.equal(saved.allianceName,"Alliance externe");
  assert.equal(saved.characters.length,1);
  assert.ok(calls.includes("/player/v1/roster"));
  assert.ok(!calls.some(p=>p.includes("/roster/member/")||p.includes("/inventory")||p.includes("/squads")));
  const externalSource=[...bucket.map.entries()]
    .filter(([k])=>k.startsWith("roster-batches/v1/connected-personal-rosters/")&&
      k.endsWith("/source.json")).map(([,value])=>value).join("");
  assert.ok(externalSource.includes("char1"),"Only authorized own roster source archived");
  assert.ok(!externalSource.includes('"ally"')&&!externalSource.includes('"membersBefore"'));
  assert.ok(!JSON.stringify([...result.headers]).includes("ACCESS_OUTSIDE"));
});

test("approved LoSP alliance keeps full scheduler, not duplicate personal OAuth capture",async()=>{
  const {env,bucket}=setup();
  const fp=createHash("sha256").update("zeus").digest("hex");
  bucket.map.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:fp,name:"Zeus"}]
  }));
  const endpoints=[];
  await saveCaptainConsent(new Response("ok"),{
    ...token("ACCESS_Z","REFRESH_Z"),scope:scopes+" m3p.f.pr.ros"
  },env,new Request(origin+"/oauth/callback"),async url=>{
    endpoints.push(new URL(url).pathname);
    return Response.json({data:{id:"zeus:v1",name:"Zeus"}});
  });
  assert.deepEqual(endpoints,[
    "/player/v1/alliance/card","/player/v1/alliance/card"
  ]);
  assert.ok(![...bucket.map.keys()].some(k=>
    k.startsWith("roster-batches/v1/connected-personal-rosters/")));
});

test("refresh token rotates once under concurrent browser and scheduled requests",async()=>{
  let calls=0,release,started;
  const pending=new Promise(resolve=>{started=resolve;});
  const {env,bucket}=setup(async(url,options)=>{
    calls++;
    assert.ok(url.endsWith("/oauth2/token"));
    assert.equal(new URLSearchParams(options.body).get("refresh_token"),"PRIVATE_REFRESH_A");
    started();
    await new Promise(resolve=>{release=resolve;});
    return fakeResponse(token("PRIVATE_ACCESS_B","PRIVATE_REFRESH_B"));
  });
  const id=newCaptainSessionId();
  const {key}=await store(env,id);
  const old=await getCaptainRecord(bucket,secret,key);
  assert.equal(old.observedRotations,0);
  assert.equal(old.lastRotatedAt,null);
  await putCaptainRecord(bucket,secret,key,{...old,accessExpiresAt:Date.now()-1000});
  const status1=handleCaptainSession(req("/session",id),env);
  // Deterministically wait until the provider call starts (crypto is async).
  await pending;
  assert.equal(calls,1);
  const status2=handleCaptainSession(req("/session",id),env);
  assert.equal(calls,1);
  release();
  const [a,b]=await Promise.all([status1,status2]);
  assert.deepEqual(await a.json(),{status:"connected"});
  assert.deepEqual(await b.json(),{status:"connected"});
  assert.equal(calls,1);
  const updated=await getCaptainRecord(bucket,secret,key);
  assert.equal(updated.refreshToken,"PRIVATE_REFRESH_B");
  assert.equal(updated.accessToken,"PRIVATE_ACCESS_B");
  assert.equal(updated.observedRotations,1);
  assert.ok(Number.isSafeInteger(updated.lastRotatedAt));
  assert.ok(updated.lastRotatedAt>=old.createdAt);
  assert.doesNotMatch(bucket.map.get(key),/PRIVATE_ACCESS_B|PRIVATE_REFRESH_B/);
});

test("invalid_grant deletes grant, transient failures preserve encrypted grant",async()=>{
  for(const [apiBody,status,expected,deleted] of [
    [{error:"invalid_grant"},400,"disconnected",true],
    [{error:"temporarily_unavailable"},503,"temporarily-unavailable",false]
  ]){
    const {env,bucket}=setup(async()=>Response.json(apiBody,{status}));
    const id=newCaptainSessionId(),{key}=await store(env,id);
    const record=await getCaptainRecord(bucket,secret,key);
    await putCaptainRecord(bucket,secret,key,{...record,accessExpiresAt:Date.now()-1000});
    const res=await handleCaptainSession(req("/session",id),env);
    assert.deepEqual(await res.json(),{status:expected});
    assert.equal(bucket.map.has(key),!deleted);
  }
});

test("logout requires same origin and revokes local storage even if provider unreachable",async()=>{
  const {env,bucket}=setup(async()=>{throw Error("provider offline");});
  const id=newCaptainSessionId(),{key}=await store(env,id);
  const invalid=await handleCaptainLogout(new Request(origin+"/logout",{
    method:"POST",headers:{Cookie:"__Host-losp_captain_session="+id,
      Origin:"https://attacker.example"}
  }),env);
  assert.equal(invalid.status,403);
  assert.equal(bucket.map.size,1);
  const valid=await handleCaptainLogout(new Request(origin+"/logout",{
    method:"POST",headers:{Cookie:"__Host-losp_captain_session="+id,
      Origin:origin,Accept:"text/html"}
  }),env);
  assert.equal(valid.status,303);
  assert.equal(valid.headers.get("location"),origin+"/captain");
  assert.match(valid.headers.getSetCookie()[0],/Max-Age=0/);
  assert.equal(bucket.map.size,0);
  assert.deepEqual(await (await handleCaptainSession(req("/session",id),env)).json(),{
    status:"disconnected"
  });
});

test("cron touches only private refresh endpoint and no game/roster data",async()=>{
  let calls=0;
  const {env,bucket}=setup(async(url)=>{
    calls++;
    assert.ok(url.endsWith("/oauth2/token"));
    return fakeResponse(token("PRIVATE_NEW","PRIVATE_NEW_REFRESH"));
  });
  const id=newCaptainSessionId(),{key}=await store(env,id);
  const record=await getCaptainRecord(bucket,secret,key);
  await putCaptainRecord(bucket,secret,key,{...record,accessExpiresAt:Date.now()-2000});
  const report=await renewCaptainGrants(env);
  assert.equal(report.checked,1);
  assert.equal(report.rotated,1);
  assert.equal(report.failed,0);
  assert.equal(calls,1);
  assert.equal((await getCaptainRecord(bucket,secret,key)).refreshToken,"PRIVATE_NEW_REFRESH");
});

test("malformed cookie, missing binding and no persistence do not leak access",async()=>{
  const {env}=setup();
  const bad=await handleCaptainSession(new Request(origin+"/session",{
    headers:{Cookie:"__Host-losp_captain_session=BAD"}
  }),env);
  assert.deepEqual(await bad.json(),{status:"disconnected"});
  const missing=await handleCaptainSession(req("/session","a".repeat(43)),{...env,CAPTAIN_BUCKET:null});
  assert.equal(missing.status,503);
  const invalid=await handleCaptainRosters(req("/captain/rosters","a".repeat(43)),env);
  assert.equal(invalid.status,303);
  assert.equal(invalid.headers.get("location"),origin+"/captain");
});

test("captain OAuth callback persists only after validated offline token grant",async()=>{
  const {env,bucket}=setup();
  const marker="a".repeat(43),verifier="b".repeat(43);
  const cb=new Request(origin+"/oauth/callback?state="+marker+"&code=PRIVATE_CODE",{
    headers:{Cookie:[
      "__Host-losp_oauth_state="+marker,
      "__Host-losp_oauth_verifier="+verifier,
      "__Host-losp_oauth_captain="+marker
    ].join("; ")}
  });
  const scopesFull="openid m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act m3p.f.pr.buy m3p.f.ar.pro m3p.f.ar.ros offline";
  let calls=[];
  const success=await handleCallback(cb,env,async url=>{
    calls.push(url);
    if(url.endsWith("/oauth2/token"))return fakeResponse({...token("PRIVATE_ACCESS","PRIVATE_REFRESH"),scope:scopesFull});
    if(url.endsWith("/alliance/members"))return fakeResponse({data:[]});
    if(url.endsWith("/alliance/card"))return fakeResponse({
      data:{id:"had-es:v1",name:"Hadès"}
    });
    throw Error("Unexpected URL");
  });
  assert.equal(success.status,200);
  assert.equal(bucket.map.size,2);
  const headers=success.headers.getSetCookie();
  assert.ok(headers.some(row=>row.startsWith("__Host-losp_captain_session=")));
  const html=await success.text();
  assert.match(html,/connexion du capitaine est conservée/);
  assert.match(html,/Votre roster personnel est le seul roster archivé/);
  assert.doesNotMatch(html+JSON.stringify([...success.headers]),/PRIVATE_(ACCESS|REFRESH)/);
  assert.deepEqual(calls,[
    "https://hydra-public.prod.m3.scopelypv.com/oauth2/token",
    "https://api.marvelstrikeforce.com/player/v1/alliance/card",
    "https://api.marvelstrikeforce.com/player/v1/alliance/card",
    "https://api.marvelstrikeforce.com/player/v1/alliance/card",
    "https://api.marvelstrikeforce.com/player/v1/alliance/members"
  ]);
  assert.ok(!calls.some(u=>u.includes("/roster/member/")));
});

test("new OAuth connections automatically register distinct alliances in private Admin R2",async()=>{
  const {env,bucket}=setup();
  const source=async name=>async url=>{
    assert.ok(url.endsWith("/player/v1/alliance/card"));
    return Response.json({data:{id:name+":v2",name}});
  };
  await saveCaptainConsent(new Response("ok"),token("ACCESS_Z","REFRESH_Z"),
    env,new Request(origin+"/oauth/callback"),await source("Zeus"));
  await saveCaptainConsent(new Response("ok"),token("ACCESS_H","REFRESH_H"),
    env,new Request(origin+"/oauth/callback"),await source("Hadès"));
  assert.equal([...bucket.map.keys()].filter(k=>k.startsWith(CONNECTED_ALLIANCE_PREFIX)).length,2);
  const listed=await listConnectedAlliances(env,async()=>{
    throw Error("Indexed alliances must not call Scopely again");
  });
  assert.equal(listed.status,"ok");
  assert.equal(listed.connectedSessions,2);
  assert.deepEqual(listed.alliances.map(a=>a.name),["Hadès","Zeus"]);
  assert.ok(listed.alliances.every(a=>a.approved===false));
  assert.doesNotMatch(JSON.stringify(listed),/ACCESS_|REFRESH_|oauth-captains/);
});
test("older connected Hadès account appears without new OAuth via one-time index backfill",async()=>{
  const {env,bucket}=setup();
  const id=newCaptainSessionId();
  await store(env,id,token("HADES_ACCESS","HADES_REFRESH"));
  let cardReads=0;
  const api=async url=>{
    cardReads++;
    assert.ok(url.endsWith("/player/v1/alliance/card"));
    return Response.json({data:{id:"alliance-hades:version-17",name:"Hadès"}});
  };
  const first=await handleConnectedAlliances(new Request(origin+
    "/admin/api/connected-alliances"),env,api);
  assert.equal(first.status,200);
  const data=await first.json();
  assert.deepEqual(data.alliances.map(a=>a.name),["Hadès"]);
  assert.equal(data.connectedSessions,1);
  assert.equal(cardReads,1);
  assert.equal([...bucket.map.keys()].filter(k=>k.startsWith(CONNECTED_ALLIANCE_PREFIX)).length,1);
  const second=await listConnectedAlliances(env,async()=>{
    throw Error("A registered session must not re-fetch its alliance");
  });
  assert.equal(second.alliances.length,1);
  assert.equal(cardReads,1);
});
test("logout removes visible alliance session without modifying other approved alliances",async()=>{
  const {env}=setup();
  const login=await saveCaptainConsent(new Response("ok"),token("A","R"),env,
    new Request(origin+"/oauth/callback"),
    async()=>Response.json({data:{id:"hades:v1",name:"Hadès"}}));
  const id=login.headers.getSetCookie()[0].match(/__Host-losp_captain_session=([^;]+)/)[1];
  const before=await listConnectedAlliances(env);
  assert.equal(before.alliances[0].name,"Hadès");
  const logout=await handleCaptainLogout(new Request(origin+"/logout",{
    method:"POST",headers:{Cookie:"__Host-losp_captain_session="+id,
      Origin:origin}
  }),env);
  assert.equal(logout.status,200);
  const after=await listConnectedAlliances(env);
  assert.equal(after.alliances.length,0);
  assert.equal(after.connectedSessions,0);
});
test("no granted offline scope means no durable cookie or R2 grant",async()=>{
  const {env,bucket}=setup();
  const state="c".repeat(43),verifier="d".repeat(43);
  const res=await handleCallback(new Request(origin+"/oauth/callback?state="+state+"&code=PRIVATE_CODE",{
    headers:{Cookie:[
      "__Host-losp_oauth_state="+state,
      "__Host-losp_oauth_verifier="+verifier,
      "__Host-losp_oauth_captain="+state
    ].join("; ")}
  }),env,async url=>{
    if(url.endsWith("/oauth2/token"))return fakeResponse({
      ...token("PRIVATE_ACCESS","PRIVATE_REFRESH"),
      scope:"openid m3p.f.pr.pro m3p.f.ar.pro m3p.f.ar.ros"
    });
    if(url.endsWith("/alliance/members"))return fakeResponse({data:[]});
    throw Error("Unexpected API access");
  });
  assert.equal(res.status,200);
  assert.equal(bucket.map.size,0);
  assert.ok(!res.headers.getSetCookie().some(row=>row.startsWith("__Host-losp_captain_session=")));
  assert.match(await res.text(),/connexion durable impossible/i);
});

test("temporary provider outage must not redirect a returning captain into email login",async()=>{
  const {env,bucket}=setup(async()=>Response.json({error:"temporarily_unavailable"},{status:503}));
  const id=newCaptainSessionId(),{key}=await store(env,id);
  const record=await getCaptainRecord(bucket,secret,key);
  await putCaptainRecord(bucket,secret,key,{...record,accessExpiresAt:Date.now()-1000});
  const login=await worker.fetch(req("/login/captain",id),env);
  assert.equal(login.status,503);
  assert.equal(login.headers.get("location"),null);
  assert.equal(bucket.map.has(key),true);
  const landing=await handleCaptainLanding(req("/captain",id),env);
  const body=await landing.text();
  assert.match(body,/Votre autorisation n.a pas été supprimée/);
  assert.doesNotMatch(body,/href="\/login\/captain"/);
});

test("verified browser visits renew the 180-day cookie, never the access token cookie",async()=>{
  const {env}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  const expected=/__Host-losp_captain_session=[A-Za-z0-9_-]{43}; Max-Age=15552000; Path=[/]; Secure; HttpOnly; SameSite=Lax/;
  const status=await handleCaptainSession(req("/session",id),env);
  assert.match(status.headers.getSetCookie().join(" "),expected);
  assert.deepEqual(await status.json(),{status:"connected"});
  const landing=await handleCaptainLanding(req("/captain",id),env);
  assert.match(landing.headers.getSetCookie().join(" "),expected);
  assert.match(await landing.text(),/maintenue automatiquement/);
  const returning=await worker.fetch(req("/login/captain",id),env);
  assert.equal(returning.status,302);
  assert.equal(returning.headers.get("location"),origin+"/captain");
  assert.match(returning.headers.getSetCookie().join(" "),expected);
  assert.equal(returning.headers.get("cache-control"),"no-store");
});

test("revoked and absent sessions never extend their browser cookies",async()=>{
  const {env,bucket}=setup();
  const id=newCaptainSessionId(),{key}=await store(env,id);
  await bucket.delete(key);
  const session=await handleCaptainSession(req("/session",id),env);
  assert.deepEqual(await session.json(),{status:"disconnected"});
  assert.equal(session.headers.getSetCookie().length,0);
  const landing=await handleCaptainLanding(req("/captain",id),env);
  assert.equal(landing.headers.getSetCookie().length,0);
});

test("temporary refresh errors never extend a browser cookie nor erase its grant",async()=>{
  const {env,bucket}=setup(async()=>Response.json({error:"temporarily_unavailable"},{status:503}));
  const id=newCaptainSessionId(),{key}=await store(env,id);
  const record=await getCaptainRecord(bucket,secret,key);
  await putCaptainRecord(bucket,secret,key,{...record,accessExpiresAt:Date.now()-1000});
  const result=await handleCaptainSession(req("/session",id),env);
  assert.deepEqual(await result.json(),{status:"temporarily-unavailable"});
  assert.equal(result.headers.getSetCookie().length,0);
  const landing=await handleCaptainLanding(req("/captain",id),env);
  assert.equal(landing.headers.getSetCookie().length,0);
  assert.equal(bucket.map.has(key),true);
});

test("current alliance is resolved again after every move; never read a previous alliance roster",async()=>{
  const {env}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  let members=[
    {id:"self-old",isSelf:true,card:{name:"Captain",rosterShare:true}},
    {id:"old-member",isSelf:false,card:{name:"Former ally",rosterShare:true}}
  ];
  const calls=[];
  const gameFetch=async url=>{
    calls.push(url);
    if(url.endsWith("/alliance/members"))return Response.json({data:members});
    if(url.includes("/roster/member/")){
      const member=decodeURIComponent(url.split("/roster/member/")[1].split("?")[0]);
      return Response.json({data:[{id:"hero-"+member,info:{name:member},power:9000}],
        meta:{page:1,perPage:100,perTotal:1}});
    }
    throw Error("Unexpected game endpoint");
  };
  let response=await handleCaptainRosters(req("/captain/rosters",id),env,gameFetch);
  assert.equal(response.status,200);
  assert.match(response.headers.getSetCookie().join(" "),/Max-Age=15552000/);
  const oldHtml=await response.text();
  assert.match(oldHtml,/Former ally/);
  assert.ok(calls.some(x=>x.includes("/roster/member/old-member")));
  calls.length=0;
  members=[
    {id:"self-new",isSelf:true,card:{name:"Captain",rosterShare:true}},
    {id:"new-member",isSelf:false,card:{name:"New ally",rosterShare:true}}
  ];
  response=await handleCaptainRosters(req("/captain/rosters",id),env,gameFetch);
  assert.equal(response.status,200);
  const newHtml=await response.text();
  assert.match(newHtml,/New ally/);
  assert.doesNotMatch(newHtml,/Former ally|old-member/);
  assert.deepEqual(calls.filter(x=>x.includes("/roster/member/")).map(x=>x.split("/roster/member/")[1].split("?")[0]),["new-member"]);
  assert.match(response.headers.get("cache-control"),/no-store/);
});

test("persistent roster access denies unknown or ambiguous CURRENT alliance membership",async()=>{
  const {env}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  for(const members of [
    [{id:"colleague",isSelf:false,card:{name:"Colleague",rosterShare:true}}],
    [{id:"a",isSelf:true,card:{}},{id:"b",isSelf:true,card:{}}]
  ]){
    let rosterCalls=0;
    const res=await handleCaptainRosters(req("/captain/rosters",id),env,async url=>{
      if(url.endsWith("/alliance/members"))return Response.json({data:members});
      rosterCalls++;
      throw Error("Private roster must not be read");
    });
    assert.equal(res.status,403);
    assert.deepEqual(await res.json(),{status:"current-alliance-unverified"});
    assert.equal(res.headers.getSetCookie().length,0);
    assert.equal(rosterCalls,0);
  }
});

test("no browser cookie after a long absence cannot be recovered merely from an R2 grant",async()=>{
  const {env,bucket}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  assert.equal(bucket.map.size,1);
  const res=await handleCaptainSession(new Request(origin+"/session"),env);
  assert.deepEqual(await res.json(),{status:"disconnected"});
  assert.equal(res.headers.getSetCookie().length,0);
});

test("captain coverage page reads CURRENT alliance only and never exposes OAuth or player IDs",async()=>{
  const {env}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  const requests=[];
  const res=await handleCaptainCoverage(req("/captain/coverage",id),env,async(url,options)=>{
    requests.push(url);
    assert.ok(options.headers.Authorization.startsWith("Bearer PRIVATE_ACCESS"));
    if(url.endsWith("/alliance/card"))return Response.json({
      data:{id:"aid:v1",name:"<LoSP & Zeus>",warRank:189}
    });
    if(url.endsWith("/alliance/members"))return Response.json({data:[
      {id:"secret-self",isSelf:true,card:{name:"Captain",rosterShare:true}},
      {id:"secret-1",isSelf:false,card:{name:"Private player",rosterShare:false}},
      {id:"secret-2",isSelf:false,card:{name:"Private player 2",rosterShare:true}}
    ]});
    throw Error("Only card and members endpoints are allowed");
  });
  assert.equal(res.status,200);
  assert.match(res.headers.get("cache-control"),/no-store/);
  assert.match(res.headers.getSetCookie().join(" "),/Max-Age=15552000/);
  const html=await res.text();
  assert.match(html,/&lt;LoSP &amp; Zeus&gt;/);
  assert.match(html,/Rosters partagés : <strong>2<\/strong>/);
  assert.match(html,/Partage non activé : <strong>1<\/strong>/);
  assert.doesNotMatch(html,/secret-self|secret-1|secret-2|PRIVATE_ACCESS|Private player/);
  assert.deepEqual(requests,[
    "https://api.marvelstrikeforce.com/player/v1/alliance/card",
    "https://api.marvelstrikeforce.com/player/v1/alliance/members"
  ]);
});

test("captain coverage denies ambiguous membership without setting a new cookie",async()=>{
  const {env}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  const res=await handleCaptainCoverage(req("/captain/coverage",id),env,async url=>{
    if(url.endsWith("/alliance/card"))return Response.json({data:{id:"aid:v2",name:"Zeus"}});
    if(url.endsWith("/alliance/members"))return Response.json({data:[
      {id:"member",isSelf:false,card:{rosterShare:true}}
    ]});
    throw Error("unexpected");
  });
  assert.equal(res.status,503);
  assert.deepEqual(await res.json(),{status:"alliance-unavailable"});
  assert.equal(res.headers.getSetCookie().length,0);
});

test("captain coverage without session redirects, without attempting a game API call",async()=>{
  const {env}=setup();
  let touched=false;
  const res=await handleCaptainCoverage(new Request(origin+"/captain/coverage"),env,
    async()=>{touched=true;throw Error("should not call API");});
  assert.equal(res.status,303);
  assert.equal(res.headers.get("location"),origin+"/captain");
  assert.equal(touched,false);
});

test("hourly cron writes only one private aggregate summary without tokens or identities",async()=>{
  const {env,bucket}=setup();
  const id=newCaptainSessionId();
  await store(env,id);
  await worker.scheduled({cron:"15 * * * *"},env);
  const raw=bucket.map.get("oauth-monitoring/v1/last-refresh-check.json");
  assert.equal(typeof raw,"string");
  const report=JSON.parse(raw);
  assert.equal(report.version,1);
  assert.equal(report.status,"ok");
  assert.equal(report.checked,1);
  assert.equal(report.rotated,0);
  assert.equal(report.failed,0);
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
  assert.doesNotMatch(raw,/PRIVATE_ACCESS|PRIVATE_REFRESH|oauth-captains|session|member|player/i);
  assert.ok([...bucket.map.keys()].some(k=>k.startsWith(CAPTAIN_PREFIX)));
});
