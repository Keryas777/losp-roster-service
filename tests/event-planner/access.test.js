import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {handleEventPlannerPage} from "../../src/event-planner-page.js";
import {handleEventPlannerApi} from "../../src/event-planner-api.js";
import {handleAdmin} from "../../src/admin-routes.js";
import worker from "../../src/index.js";
import {accessJwt,accessFetch,ACCESS_OWNER,ACCESS_OTHER_ADMIN,ACCESS_DOMAIN,ACCESS_AUD} from "./access-fixtures.mjs";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const SESSION="s".repeat(43);
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const OTHER_JWT=await accessJwt(ACCESS_OTHER_ADMIN);
const mockFetch=accessFetch();
function setup(){
  const calls={sessions:0,cache:0,assets:0,scopely:0};
  const env={EVENT_PLANNER_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,
    MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:ACCESS_DOMAIN,CF_ACCESS_AUD:ACCESS_AUD,
    MSF_ADMIN_EMAILS:ACCESS_OWNER+","+ACCESS_OTHER_ADMIN,SCOPELY_CLIENT_ID:"client",
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
    CAPTAIN_BUCKET:{get:async()=>null,put:async()=>{},delete:async()=>{}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>{
      calls.sessions++;return Response.json({status:"active",accessToken:"private-test-token",
        scope:"openid m3p.f.pr.act m3p.f.pr.ros m3p.f.pr.inv offline"});
    }})},
    PERSONAL_EVENT_CACHE:{idFromName:key=>key,get:()=>({fetch:async()=>{calls.cache++;calls.scopely++;return Response.json({status:"connected"});}})},
    ASSETS:{fetch:async()=>{calls.assets++;return new Response("<!doctype html><h1>Planner</h1>",{
      headers:{"Content-Type":"text/html"}});}}};
  return {env,calls};
}
function request(path,{jwt,session=false,origin}={}){
  return new Request(ORIGIN+path,{headers:{
    ...(jwt?{"Cf-Access-Jwt-Assertion":jwt}:{}),
    ...(session?{Cookie:"__Host-losp_captain_session="+SESSION}:{}),
    ...(origin?{Origin:origin}:{})
  }});
}
async function withAccessFetch(run){
  const previous=globalThis.fetch;globalThis.fetch=mockFetch;
  try{return await run();}finally{globalThis.fetch=previous;}
}

test("owner sees the admin entry and can open the planner shell",async()=>{
  const f=setup();
  const admin=await withAccessFetch(()=>worker.fetch(request("/admin",{jwt:OWNER_JWT}),f.env));
  assert.equal(admin.status,200);assert.match(await admin.text(),/Planifier avec mon roster/);
  const shell=await withAccessFetch(()=>worker.fetch(request("/admin/events-planner",{jwt:OWNER_JWT}),f.env));
  assert.equal(shell.status,200);
  const shellText=await shell.text();
  assert.match(shellText,/Aucun compte MSF n’est connecté/);assert.doesNotMatch(shellText,/Scopely|OAuth|jeton/i);
  assert.match(shellText,/\/admin\/login\/captain\?returnTo=events-planner/);
  assert.equal(f.calls.sessions,0);assert.equal(f.calls.assets,0);assert.equal(f.calls.scopely,0);
});

test("a LoSP member with an active Scopely cookie is denied before session or API access",async()=>{
  const f=setup();
  const page=await worker.fetch(request("/admin/events-planner",{session:true}),f.env);
  const api=await worker.fetch(request("/admin/api/event-planner?resource=status",{session:true}),f.env);
  const progress=await worker.fetch(request("/captain/api/events",{session:true}),f.env);
  const progressAlias=await worker.fetch(request("/captain/events",{session:true}),f.env);
  assert.equal(page.status,403);assert.equal(api.status,403);
  assert.equal(progress.status,403);assert.equal(progressAlias.status,403);
  assert.deepEqual(f.calls,{sessions:0,cache:0,assets:0,scopely:0});
});

test("a LoSP member without a Scopely session is denied",async()=>{
  const f=setup();
  const page=await handleEventPlannerPage(request("/admin/events-planner"),f.env,mockFetch);
  const api=await handleEventPlannerApi(request("/admin/api/event-planner?resource=events"),f.env,mockFetch);
  assert.equal(page.status,403);assert.equal(api.status,403);
  assert.deepEqual(f.calls,{sessions:0,cache:0,assets:0,scopely:0});
});

test("a visitor or guest cannot access routes or initiate planner Scopely consent",async()=>{
  const f=setup();
  for(const path of ["/admin/events-planner","/admin/api/event-planner?resource=status",
    "/admin/login/captain?returnTo=events-planner","/login/captain?returnTo=events-planner"]){
    const response=await worker.fetch(request(path),f.env);
    assert.ok(response.status===403||response.status===404,path+" should deny visitor");
    assert.equal(response.headers.get("location"),null,path+" must not start Scopely OAuth");
  }
  const directAssets=await worker.fetch(request("/event-planner/index.html"),f.env);
  assert.equal(directAssets.status,404);
  const oldPage=await worker.fetch(request("/captain/events-planner"),f.env);
  assert.equal(oldPage.status,404);
  assert.deepEqual(f.calls,{sessions:0,cache:0,assets:0,scopely:0});
});

test("another configured admin has no planner button and cannot enter",async()=>{
  const f=setup();
  const admin=await handleAdmin(request("/admin",{jwt:OTHER_JWT}),f.env,mockFetch);
  assert.equal(admin.status,200);assert.doesNotMatch(await admin.text(),/Planifier avec mon roster/);
  const page=await handleEventPlannerPage(request("/admin/events-planner",{jwt:OTHER_JWT,session:true}),f.env,mockFetch);
  const api=await handleEventPlannerApi(request("/admin/api/event-planner?resource=status",{jwt:OTHER_JWT,session:true}),f.env,mockFetch);
  assert.equal(page.status,403);assert.equal(api.status,403);
  assert.deepEqual(f.calls,{sessions:0,cache:0,assets:0,scopely:0});
});

test("public planner assets run through the Worker access gate",async()=>{
  const config=JSON.parse(await readFile(new URL("../../wrangler.jsonc",import.meta.url),"utf8"));
  assert.ok(config.assets.run_worker_first.includes("/event-planner"));
  assert.ok(config.assets.run_worker_first.includes("/event-planner/*"));
});

test("feature-off fails closed and supports the Worker recovery switch",async()=>{
  const f=setup();f.env.EVENT_PLANNER_ENABLED="false";
  const admin=await withAccessFetch(()=>worker.fetch(request("/admin",{jwt:OWNER_JWT}),f.env));
  const page=await withAccessFetch(()=>worker.fetch(request("/admin/events-planner",{jwt:OWNER_JWT}),f.env));
  const api=await withAccessFetch(()=>worker.fetch(request("/admin/api/event-planner?resource=status",{jwt:OWNER_JWT}),f.env));
  const progress=await withAccessFetch(()=>worker.fetch(request("/captain/api/events",{jwt:OWNER_JWT,session:true}),f.env));
  assert.equal(admin.status,200);assert.doesNotMatch(await admin.text(),/Planifier avec mon roster/);
  assert.equal(page.status,404);assert.equal(api.status,404);assert.equal(progress.status,404);
  assert.deepEqual(f.calls,{sessions:0,cache:0,assets:0,scopely:0});
});
