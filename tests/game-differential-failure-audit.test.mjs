import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {handleGameDifferentialFailureAudit,runGameDifferentialFailureAuditTick}
  from "../src/game-differential-failure-audit.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const PREFIX=ROOT+"recovery/pending/";
const KEY=ROOT+"failure-audit/v1/progress.json";
const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=HOST+"/admin/api/game-differential-failure-audit";
const RUN="11111111-2222-4333-8444-555555555555";
const now=Date.parse("2026-10-30T10:00:00Z");
function fixture(rows,source={runId:RUN,status:"partial",failed:2159,checked:12086,
  recoveryBackfill:{cursor:12086,end:12086}}){
  const stored=new Map([[ROOT+"state.json",JSON.stringify(source)]]);
  for(let i=0;i<rows.length;i++)
    stored.set(PREFIX+i.toString(16).padStart(64,"0")+".json",
      JSON.stringify(rows[i]));
  const calls=[],leases=new Map();
  let failingKey=null;
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      if(key===failingKey)throw Error("R2 interrupted");
      const value=stored.get(key);
      return value===undefined?null:{
        size:value.length,text:async()=>value};
    },
    put:async(key,content)=>{
      calls.push(["put",key]);
      if(key!==KEY)throw Error("Unrelated R2 writes forbidden");
      stored.set(key,String(content));
    },
    list:async({prefix,limit,cursor})=>{
      calls.push(["list",prefix,limit,cursor]);
      assert.equal(prefix,PREFIX);assert.equal(limit,16);
      const keys=[...stored.keys()].filter(k=>k.startsWith(prefix)).sort();
      const from=cursor?Number(cursor):0;
      const end=Math.min(from+limit,keys.length);
      return {objects:keys.slice(from,end).map(key=>({key})),
        truncated:end<keys.length,cursor:end<keys.length?String(end):undefined};
    }
  };
  const lock={
    idFromName:x=>x,get:key=>({fetch:async request=>{
      const body=await request.json();
      assert.equal(body.fingerprint,key);
      if(body.action==="acquire"){
        if(leases.has(key))return Response.json({status:"busy"});
        leases.set(key,body.holder);
        return Response.json({status:"acquired"});
      }
      if(leases.get(key)!==body.holder)
        return Response.json({status:"busy"});
      leases.delete(key);return Response.json({status:"released"});
    }})
  };
  return {stored,calls,env:{CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:lock},
    failAt:key=>{failingKey=key;}};
}
const row=(id,reason,status="pending",options={})=>({
  version:1,path:"/game/v1/characters/"+id,reason,status,attempts:1,...options
});
const get=f=>handleGameDifferentialFailureAudit(new Request(ENDPOINT),f.env,now);
const post=(f,action="start")=>handleGameDifferentialFailureAudit(new Request(ENDPOINT,{
  method:"POST",headers:{Origin:HOST,"Content-Type":"application/json"},
  body:JSON.stringify({action})}),f.env,now);

test("Cron independently advances a persistent, deduplicated R2 snapshot across reloads",async()=>{
  const rows=Array.from({length:19},(_,i)=>row("Hero"+i,
    i%2?"http-472":"http-404","pending",{
      attempts:i===1?3:1,recoveredParts:i===1?[
        "/game/v1/characters/Hero1?abilityKits=basic"]:[]}));
  rows.push(row("Recovered","network-error","resolved"));
  const f=fixture(rows);
  const initial=(await get(f)).json();
  assert.equal((await initial).status,"not-started");
  assert.equal(f.calls.filter(x=>x[0]==="put").length,0);
  assert.equal((await (await post(f)).json()).status,"running");
  const first=await runGameDifferentialFailureAuditTick(f.env,now+60000);
  assert.equal(first.status,"running");
  assert.equal(first.scanned,16);
  // Simulate a page refresh: a new GET has no local JS state or cursor.
  const resumed=await (await get(f)).json();
  assert.equal(resumed.stats.scanned,16);
  assert.equal(resumed.stats.exhausted,1);
  assert.equal(resumed.cursor,undefined);
  assert.equal(resumed.sourceAtStart.failed,2159);
  assert.equal((await (await post(f)).json()).stats.scanned,16);
  const final=await runGameDifferentialFailureAuditTick(f.env,now+120000);
  assert.equal(final.status,"snapshot-complete");
  const done=await (await get(f)).json();
  assert.equal(done.stats.scanned,20);
  assert.equal(done.stats.valid,20);
  assert.equal(done.stats.pending,19);
  assert.equal(done.stats.resolved,1);
  assert.equal(done.stats.variants,1);
  assert.equal(done.stats.exhausted,1);
  assert.equal(done.byGroup["http-472"],9);
  assert.equal(done.byGroup["http-4xx"],10);
  assert.equal(done.byGroup.network,1);
  assert.equal(done.sourceChanged,false);
  assert.equal((await runGameDifferentialFailureAuditTick(f.env,now+180000)).status,
    "snapshot-complete");
  assert.equal(f.calls.filter(x=>x[0]==="list").length,2);
  assert.equal(f.calls.filter(x=>x[0]==="put"&&x[1]===KEY).length,3);
  assert.equal(f.calls.filter(x=>x[0]==="get"&&x[1].includes("/player")).length,0);
  const restarted=await (await post(f,"restart")).json();
  assert.equal(restarted.status,"running");assert.equal(restarted.stats.scanned,0);
});

test("R2 failure cannot advance checkpoint or fabricate completion",async()=>{
  const f=fixture([row("One","http-472"),row("Two","http-503")]);
  await post(f);
  const keys=[...f.stored.keys()].filter(k=>k.startsWith(PREFIX)).sort();
  f.failAt(keys[1]);
  assert.equal((await runGameDifferentialFailureAuditTick(f.env)).status,"unavailable");
  assert.equal((await (await get(f)).json()).stats.scanned,0);
  f.failAt(null);
  assert.equal((await runGameDifferentialFailureAuditTick(f.env)).status,
    "snapshot-complete");
  assert.equal((await (await get(f)).json()).stats.scanned,2);
});

test("Run changes are disclosed and invalid records counted, not silently omitted",async()=>{
  const f=fixture([row("One","http-472"),{path:"/player/v1/private",
    reason:"http-404",status:"pending"}]);
  await post(f);
  f.stored.set(ROOT+"state.json",JSON.stringify({runId:RUN,status:"partial",
    checked:12087,failed:2160,recoveryBackfill:{cursor:12087,end:12087}}));
  await runGameDifferentialFailureAuditTick(f.env);
  const result=await (await get(f)).json();
  assert.equal(result.status,"snapshot-complete");
  assert.equal(result.sourceChanged,true);
  assert.equal(result.stats.rejected,1);
  assert.equal(result.stats.valid,1);
  assert.equal(JSON.stringify(result).includes("/player"),false);
});

test("POST is Origin/JSON guarded, other methods are rejected, admin Access still required",async()=>{
  const f=fixture([row("One","http-472")]);
  assert.equal((await handleGameDifferentialFailureAudit(new Request(ENDPOINT,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:'{"action":"start"}'}),f.env)).status,403);
  assert.equal((await handleGameDifferentialFailureAudit(new Request(ENDPOINT,{
    method:"DELETE"}),f.env)).status,405);
  assert.equal((await handleGameDifferentialFailureAudit(new Request(ENDPOINT,{
    method:"POST",headers:{Origin:HOST,"Content-Type":"text/plain"},
    body:'{"action":"start"}'}),f.env)).status,403);
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  assert.equal((await handleAdmin(new Request(ENDPOINT),env)).status,403);
  assert.equal(f.calls.filter(x=>x[0]==="put").length,0);
});

test("Admin uses the existing Cron and UI displays a server checkpoint",async()=>{
  const index=await readFile(new URL("../src/index.js",import.meta.url),"utf8");
  const routes=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const ui=await readFile(new URL(
    "../public/admin-game-differential-diagnostic.js",import.meta.url),"utf8");
  assert.match(index,/runGameDifferentialFailureAuditTick\(env\)/);
  assert.match(routes,/admin\/api\/game-differential-failure-audit/);
  assert.match(ui,/void fetchStatus\(\)/);
  assert.match(ui,/setInterval\(/);
  assert.doesNotMatch(ui,/for\(let page=0;page<100;page\+\+\)/);
  assert.doesNotMatch(ui,/\.innerHTML\s*=/);
});
