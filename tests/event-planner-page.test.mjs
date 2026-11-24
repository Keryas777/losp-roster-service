import {accessJwt,accessFetch,ACCESS_OWNER} from "./event-planner/access-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {handleEventPlannerPage} from "../src/event-planner-page.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const SESSION="s".repeat(43);
function envFor(status="active"){
  let assetCalls=0;
  return {assetCalls:()=>assetCalls,env:{EVENT_PLANNER_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,
    MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:"planner-test.cloudflareaccess.com",CF_ACCESS_AUD:"a".repeat(32),
    MSF_ADMIN_EMAILS:ACCESS_OWNER,CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
    CAPTAIN_BUCKET:{get:async()=>null,put:async()=>{},delete:async()=>{}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status})})},
    ASSETS:{fetch:async request=>{assetCalls++;return new Response("<!doctype html><h1>Planner asset</h1><script type=module src=\"/admin/events-planner/app.js\"></script>",{headers:{"Content-Type":"text/html"}});}}}};
}

test("planner shell requires owner Access and an existing captain session before serving assets",async()=>{
  const f=envFor("active");
  const anonymous=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner"),f.env,accessFetch());
  assert.equal(anonymous.status,403);assert.equal(f.assetCalls(),0);
  const noCaptain=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner",{
    headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT}}),f.env,accessFetch());
  assert.equal(noCaptain.status,200);
  const noCaptainText=await noCaptain.text();assert.match(noCaptainText,/Aucune session Scopely active/);
  assert.match(noCaptainText,/admin\/login\/captain\?returnTo=events-planner/);
  assert.equal(f.assetCalls(),0);
  assert.equal(noCaptain.headers.get("Cache-Control"),"private, no-store, max-age=0");
});

test("connected same-origin session receives the page with private no-store headers",async()=>{
  const f=envFor("active");
  const response=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner",{headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT,Cookie:"__Host-losp_captain_session="+SESSION}}),f.env,accessFetch());
  assert.equal(response.status,200);assert.match(await response.text(),/Planner asset/);
  assert.equal(f.assetCalls(),1);assert.equal(response.headers.get("X-Robots-Tag"),"noindex");
  assert.match(response.headers.get("Content-Security-Policy"),/connect-src 'self' https:\/\/keryas777\.github\.io/);
});

test("planner asset path traversal and unsupported files are denied",async()=>{
  const f=envFor("active"),headers={"Cf-Access-Jwt-Assertion":OWNER_JWT,Cookie:"__Host-losp_captain_session="+SESSION};
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner/../../captain-vault.js",{headers}),f.env,accessFetch())).status,404);
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner/private.json",{headers}),f.env,accessFetch())).status,404);
  assert.equal(f.assetCalls(),0);
});
