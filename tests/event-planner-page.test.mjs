import test from "node:test";
import assert from "node:assert/strict";
import {handleEventPlannerPage} from "../src/event-planner-page.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const SESSION="s".repeat(43);
function envFor(status="active"){
  let assetCalls=0;
  return {assetCalls:()=>assetCalls,env:{CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
    CAPTAIN_BUCKET:{get:async()=>null,put:async()=>{},delete:async()=>{}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status})})},
    ASSETS:{fetch:async request=>{assetCalls++;return new Response("<!doctype html><h1>Planner asset</h1><script type=module src=\"/captain/events-planner/app.js\"></script>",{headers:{"Content-Type":"text/html"}});}}}};
}

test("planner shell requires the current captain session before serving private assets",async()=>{
  const f=envFor("active");
  const anonymous=await handleEventPlannerPage(new Request(ORIGIN+"/captain/events-planner"),f.env);
  assert.equal(anonymous.status,200);assert.match(await anonymous.text(),/Aucune session Scopely active/);
  assert.equal(f.assetCalls(),0);
  assert.equal(anonymous.headers.get("Cache-Control"),"private, no-store, max-age=0");
});

test("connected same-origin session receives the page with private no-store headers",async()=>{
  const f=envFor("active");
  const response=await handleEventPlannerPage(new Request(ORIGIN+"/captain/events-planner",{headers:{Cookie:"__Host-losp_captain_session="+SESSION}}),f.env);
  assert.equal(response.status,200);assert.match(await response.text(),/Planner asset/);
  assert.equal(f.assetCalls(),1);assert.equal(response.headers.get("X-Robots-Tag"),"noindex");
  assert.match(response.headers.get("Content-Security-Policy"),/connect-src 'self' https:\/\/keryas777\.github\.io/);
});

test("planner asset path traversal and unsupported files are denied",async()=>{
  const f=envFor("active"),headers={Cookie:"__Host-losp_captain_session="+SESSION};
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/captain/events-planner/../../captain-vault.js",{headers}),f.env)).status,404);
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/captain/events-planner/private.json",{headers}),f.env)).status,404);
  assert.equal(f.assetCalls(),0);
});
