import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {handleGameDifferentialComparisonAudit,runGameDifferentialComparisonAuditTick}
  from "../src/game-differential-comparison-audit.js";
import {gameSemanticHash} from "../src/game-differential-sync.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=HOST+"/admin/api/game-differential-comparison-audit";
const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const PROGRESS=ROOT+"comparison-audit/v1/progress.json";
const LAST="11111111-2222-4333-8444-555555555555";
const PRIOR="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW=Date.parse("2026-11-03T17:00:00.000Z");
const sha=value=>createHash("sha256").update(value).digest("hex");
const iso=timestamp=>new Date(timestamp).toISOString();
function fixture(){
  const stored=new Map([[ROOT+"state.json",JSON.stringify({
    runId:LAST,status:"partial",changed:9986,unchanged:0,
    checked:12232,failed:2246
  })]]);
  const calls=[],held=new Set();
  let throwOn=null;
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      if(key===throwOn)throw Error("R2 temporary unavailable");
      if(!stored.has(key))return null;
      const content=stored.get(key);
      return {size:new TextEncoder().encode(content).byteLength,
        text:async()=>content};
    },
    put:async(key,value)=>{
      calls.push(["put",key]);
      assert.equal(key,PROGRESS,"do not mutate archives/pointers/receipts");
      stored.set(key,String(value));
    },
    list:async({prefix,limit,cursor})=>{
      calls.push(["list",prefix,limit,cursor]);
      assert.equal(prefix,ROOT+"latest/");
      assert.equal(limit,12);
      const keys=[...stored.keys()].filter(x=>x.startsWith(prefix)).sort();
      const from=cursor?Number(cursor):0,end=Math.min(from+limit,keys.length);
      return {objects:keys.slice(from,end).map(key=>({key})),
        truncated:end<keys.length,cursor:end<keys.length?String(end):undefined};
    }
  };
  const lock={
    idFromName:key=>key,
    get:key=>({fetch:async request=>{
      const body=await request.json();
      assert.equal(body.fingerprint,key);
      if(body.action==="acquire"){
        if(held.has(key))return Response.json({status:"busy"});
        held.add(key);return Response.json({status:"acquired"});
      }
      held.delete(key);return Response.json({status:"released"});
    }})
  };
  return {stored,calls,env:{CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:lock},
    fail:key=>{throwOn=key;}};
}
async function add(f,path,oldDoc,newDoc,{recordedStatus="changed",
  link=true,invalidPrevious=false}={}){
  const currentText=JSON.stringify(newDoc),previousText=JSON.stringify(oldDoc);
  const currentSha=sha(currentText),oldSha=sha(previousText);
  const currentObject=ROOT+"runs/"+LAST+"/objects/"+currentSha+".json";
  const previousObject=ROOT+"runs/"+PRIOR+"/objects/"+oldSha+".json";
  const receipt=ROOT+"runs/"+LAST+"/checks/00000001.json";
  const oldReceipt=ROOT+"runs/"+PRIOR+"/checks/00000001.json";
  // Each URI must have its OWN receipt, even if its contents deduplicate.
  const pathHash=sha(path),index=[...f.stored.keys()].filter(k=>
    k.startsWith(ROOT+"latest/")).length+2;
  const currentKey=ROOT+"runs/"+LAST+"/checks/"+String(index).padStart(8,"0")+".json";
  const previousKey=ROOT+"runs/"+PRIOR+"/checks/"+String(index).padStart(8,"0")+".json";
  f.stored.set(currentObject,currentText);f.stored.set(previousObject,previousText);
  f.stored.set(currentKey,JSON.stringify({path,status:recordedStatus,
    sha256:currentSha,objectKey:currentObject,
    semanticHash:await gameSemanticHash(newDoc),
    sourceReceipt:link?previousKey:null}));
  if(link)f.stored.set(previousKey,JSON.stringify({path,
    sha256:invalidPrevious?"0".repeat(64):oldSha,
    objectKey:previousObject,semanticHash:await gameSemanticHash(oldDoc),
    status:"changed"}));
  f.stored.set(ROOT+"latest/"+pathHash+".json",JSON.stringify({
    version:2,path,runId:LAST,receiptKey:currentKey,
    sha256:currentSha,objectKey:currentObject
  }));
  return {currentKey,previousKey,currentObject,previousObject,receipt,oldReceipt};
}
const get=f=>handleGameDifferentialComparisonAudit(new Request(ENDPOINT),f.env,NOW);
const post=(f,action="start")=>handleGameDifferentialComparisonAudit(
  new Request(ENDPOINT,{method:"POST",headers:{Origin:HOST,
    "Content-Type":"application/json"},
    body:JSON.stringify({action})}),f.env,NOW);
async function runToEnd(f){
  let state;
  for(let i=1;i<250;i++){
    state=await runGameDifferentialComparisonAuditTick(f.env,NOW+i*60000);
    if(state.status==="snapshot-complete")return (await get(f)).json();
    assert.equal(state.status,"running",JSON.stringify(state));
  }
  throw Error("sample did not finish");
}

test("compares two verified versions, including a false change on meta.asOf",async()=>{
  const f=fixture();
  const old={data:{id:"Hero",power:900,name:"SENSITIVE_VALUE_42"},
    meta:{asOf:"2026-10-20T00:00:00Z"}};
  const asof={data:{...old.data},meta:{asOf:"2026-11-03T00:00:00Z"}};
  await add(f,"/game/v1/characters/Hero",old,asof);
  await add(f,"/game/v1/items/ITEM",old,{
    data:{...old.data,power:1000},meta:{asOf:"2026-11-03T00:00:00Z"}});
  await add(f,"/game/v1/events/E1",old,{
    data:{...old.data},meta:{asOf:"2026-11-03T00:00:00Z",
      requestSerial:7}});
  await add(f,"/game/v1/traits?page=1&perPage=100",old,asof,
    {recordedStatus:"unchanged"});
  assert.equal((await (await get(f)).json()).status,"not-started");
  assert.equal(f.calls.filter(x=>x[0]==="put").length,0);
  assert.equal((await (await post(f)).json()).status,"running");
  const first=await runGameDifferentialComparisonAuditTick(f.env,NOW+60000);
  assert.equal(first.status,"running");
  assert.equal(first.sampled,3);
  const completed=await runToEnd(f);
  assert.equal(completed.status,"snapshot-complete");
  assert.equal(completed.sampled,4);
  assert.equal(completed.byClass["false-change"],1);
  assert.equal(completed.byClass["data-change"],1);
  assert.equal(completed.byClass["metadata-other-change"],1);
  assert.equal(completed.byClass["only-asof-or-order"],1);
  const paths=completed.rows.find(x=>x.classification==="data-change").changedFields;
  assert.ok(paths.some(x=>x.includes("power")));
  const report=JSON.stringify(completed);
  assert.ok(!report.includes("SENSITIVE_VALUE_42"),
    "no payload values must leave private R2");
  assert.equal(completed.sourceChanged,false);
  assert.equal(f.calls.filter(x=>x[0]==="put"&&x[1]!==PROGRESS).length,0);
  assert.equal((await runGameDifferentialComparisonAuditTick(f.env)).status,
    "snapshot-complete");
  const again=await (await post(f,"restart")).json();
  assert.equal(again.status,"running");assert.equal(again.sampled,0);
});

test("missing historical linkage, invalid receipt and corrupted bytes are not mislabelled as changes",async()=>{
  const f=fixture();
  const old={data:{a:1},meta:{asOf:"2026-10-20T00:00:00Z"}};
  const newer={data:{a:2},meta:{asOf:"2026-11-03T00:00:00Z"}};
  await add(f,"/game/v1/characters/A",old,newer,{link:false});
  await add(f,"/game/v1/items/B",old,newer,{invalidPrevious:true});
  const c=await add(f,"/game/v1/events/C",old,newer);
  f.stored.set(c.currentObject,JSON.stringify({...newer,data:{a:3}}));
  await post(f);
  const report=await runToEnd(f);
  assert.equal(report.byClass["no-linked-previous-version"],1);
  assert.equal(report.byClass["previous-invalid-storage-reference"],1);
  assert.equal(report.byClass["current-stored-sha-mismatch"],1);
  assert.equal(report.byClass["data-change"]||0,0);
});

test("failed R2 read preserves checkpoint and can resume via Cron",async()=>{
  const f=fixture(),path="/game/v1/characters/Interrupted";
  const proof=await add(f,path,{data:{v:1}},{data:{v:2}});
  await post(f);f.fail(proof.previousKey);
  assert.equal((await runGameDifferentialComparisonAuditTick(f.env)).status,
    "unavailable");
  const before=await (await get(f)).json();
  assert.equal(before.scanned,0);
  assert.equal(before.sampled,0);
  f.fail(null);
  const complete=await runToEnd(f);
  assert.equal(complete.sampled,1);
  assert.equal(complete.status,"snapshot-complete");
});

test("sample remains bounded and reports when source checkpoint changes",async()=>{
  const f=fixture();
  for(let i=0;i<60;i++)
    await add(f,"/game/v1/characters/Hero"+i,
      {data:{i}},{data:{i:i+1}});
  await post(f);
  await runGameDifferentialComparisonAuditTick(f.env);
  f.stored.set(ROOT+"state.json",JSON.stringify({
    runId:LAST,status:"partial",checked:12240,
    changed:9994,unchanged:0,failed:2246}));
  const report=await runToEnd(f);
  assert.ok(report.sampled<=8,
    "balanced sample avoids selecting 24 characters only");
  assert.equal(report.sourceChanged,true);
  assert.ok(report.scanned<=600);
  assert.ok(f.calls.filter(x=>x[0]==="list").length<100);
});

test("POST requires origin+JSON and admin Access, no provider calls",async()=>{
  const f=fixture();
  assert.equal((await handleGameDifferentialComparisonAudit(new Request(ENDPOINT,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:'{"action":"start"}'}),f.env)).status,403);
  assert.equal((await handleGameDifferentialComparisonAudit(new Request(ENDPOINT,{
    method:"DELETE"}),f.env)).status,405);
  assert.equal((await handleGameDifferentialComparisonAudit(new Request(ENDPOINT+"?x=1"),
    f.env)).status,400);
  assert.equal((await handleGameDifferentialComparisonAudit(new Request(ENDPOINT,{
    method:"POST",headers:{Origin:HOST,"Content-Type":"text/plain"},
    body:'{"action":"start"}'}),f.env)).status,403);
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  assert.equal((await handleAdmin(new Request(ENDPOINT),env)).status,403);
  assert.equal(f.calls.filter(x=>x[0]==="put").length,0);
});

test("wiring: existing Cron, protected endpoint, manual-only mobile UI, no innerHTML",async()=>{
  const read=async path=>readFile(new URL(path,import.meta.url),"utf8");
  const [index,routes,ui,nav,source]=await Promise.all([
    read("../src/index.js"),read("../src/admin-routes.js"),
    read("../public/admin-game-differential-comparison.js"),
    read("../public/admin-navigation.js"),read("../src/game-differential-sync.js")
  ]);
  assert.match(index,/runGameDifferentialComparisonAuditTick\(env\)/);
  assert.match(routes,/admin\/api\/game-differential-comparison-audit/);
  assert.match(routes,/admin-game-differential-comparison\.js/);
  assert.match(nav,/archives[\s\S]*game-diff-comparison-start/);
  assert.match(ui,/button\.addEventListener\("click"/);
  assert.match(ui,/if\(!started\|\|busy/);
  assert.doesNotMatch(ui,/\.innerHTML\s*=/);
  assert.match(source,/export const gameSemanticHash=semantic/);
});
