import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {
  CAPTAIN_PREFIX, CAPTAIN_MAX_AGE, newCaptainSessionId, captainSessionKey,
  captainConfigReady, getCaptainRecord, putCaptainRecord
} from "../src/captain-vault.js";
import { CaptainRefreshCoordinator } from "../src/captain-refresh-coordinator.js";
import {
  saveCaptainConsent, handleCaptainSession, handleCaptainLogout,
  handleCaptainLanding, handleCaptainRosters, renewCaptainGrants
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
  assert.equal((await renewCaptainGrants(env)).checked,1);
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
