import {test} from "node:test";
import assert from "node:assert/strict";
import {handleGameMaterialAudit,runGameMaterialAuditTick}
  from "../src/game-material-audit.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const RUN="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const NOW=Date.parse("2026-10-29T12:00:00.000Z");
const AT=new Date("2026-10-28T13:00:00.000Z");
const OLD=new Date("2026-07-01T12:00:00.000Z");
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=ORIGIN+"/admin/api/game-material-audit";
const ROOT=GAME_ARCHIVE_ROOT+"runs/"+RUN+"/";
const PROGRESS=ROOT+"material-audit/v1/progress.json";
const hash=async raw=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(raw)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
function fixture(){
  const objects=new Map(),calls={get:[],list:[],put:[],deleted:[],scopely:0};
  objects.set(GAME_ARCHIVE_ROOT+"active.json",{
    raw:JSON.stringify({runId:RUN}),uploaded:AT
  });
  let owner=null,blocked=false,throwRead=null;
  const lock={
    get:()=>({fetch:async request=>{
      const b=await request.json();
      if(b.action==="release"){
        if(owner===b.holder)owner=null;
        return Response.json({status:"released"});
      }
      if(blocked||owner)return Response.json({status:"busy"},{status:409});
      owner=b.holder;
      return Response.json({status:"acquired"});
    }}),
    idFromName:name=>name
  };
  const b={
    get:async key=>{
      calls.get.push(key);
      if(key===throwRead)throw Error("temporary R2 failure");
      const o=objects.get(key);
      return o?{size:Buffer.byteLength(o.raw),uploaded:o.uploaded,
        text:async()=>o.raw}:null;
    },
    list:async opts=>{
      calls.list.push(opts);
      const all=[...objects.keys()].filter(k=>k.startsWith(opts.prefix)).sort();
      const start=opts.cursor?Number(opts.cursor):0;
      const entries=all.slice(start,start+opts.limit);
      return {objects:entries.map(key=>({
        key,size:Buffer.byteLength(objects.get(key).raw),
        uploaded:objects.get(key).uploaded
      })),truncated:start+entries.length<all.length,
      cursor:String(start+entries.length)};
    },
    put:async(key,raw)=>{
      calls.put.push(key);
      objects.set(key,{raw,uploaded:AT});
    },
    delete:async key=>{
      calls.deleted.push(key);
      objects.delete(key);
    }
  };
  async function add(doc,{uploaded=AT,sha=null}={}){
    const raw=JSON.stringify(doc),digest=sha||await hash(raw);
    const key=ROOT+"objects/"+digest+".json";
    objects.set(key,{raw,uploaded});
    return {key,sha:digest};
  }
  const env={CAPTAIN_BUCKET:b,ROSTER_BATCH_LOCK:lock};
  return {env,objects,calls,add,block:val=>blocked=val,
    failRead:val=>throwRead=val,progress:()=>JSON.parse(objects.get(PROGRESS).raw)};
}
const get=(f,now=NOW)=>handleGameMaterialAudit(new Request(ENDPOINT),f.env,now);
const post=(f,action="start",now=NOW)=>handleGameMaterialAudit(new Request(ENDPOINT,{
  method:"POST",headers:{Origin:ORIGIN,"Content-Type":"application/json"},
  body:JSON.stringify({action})}),f.env,now);

test("manual start persists and minute ticks finish with all IDs and deduplicated file counts",async()=>{
  const f=fixture();
  const green="ABILITY_MATERIAL_GREEN_ABILITY_MAT";
  const unique=Array.from({length:28},(_,i)=>
    "ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_HERO"+i+"_PASSIVE");
  await f.add({data:{items:[green,...unique]}});
  await f.add({data:{items:[green,"ABILITY_MATERIAL_BLUE_ABILITY_MAT"]}});
  for(let i=0;i<23;i++)await f.add({data:{id:"misc"+i}});
  const started=await (await post(f)).json();
  assert.equal(started.status,"running");
  assert.equal(f.calls.list.length,0,"admin POST never scans sources");
  const again=await (await post(f)).json();
  assert.equal(again.status,"running");
  assert.equal(f.calls.put.filter(x=>x===PROGRESS).length,1);
  assert.equal((await post(f,"restart")).status,409);
  const first=await runGameMaterialAuditTick(f.env,NOW);
  assert.equal(first.status,"running");
  assert.equal(first.listed,20);
  const second=await runGameMaterialAuditTick(f.env,NOW+60000);
  assert.equal(second.status,"snapshot-complete");
  assert.equal(second.listed,25);
  const report=await (await get(f,NOW+60000)).json();
  assert.equal(report.status,"snapshot-complete");
  assert.equal(report.stats.listed,25);
  assert.equal(report.stats.matched,2);
  assert.equal(report.distinctIds,30);
  assert.equal(report.materials.find(x=>x.id===green).fileCount,2);
  assert.equal(report.materials.find(x=>x.id===unique[5]).fileCount,1);
  assert.ok(report.materials.every(x=>!Object.hasOwn(x,"objectKey")));
  assert.equal(f.calls.put.filter(x=>!x.includes("material-audit/v1/")).length,0);
  assert.equal(f.calls.list.every(x=>x.prefix===ROOT+"objects/"),true);
  assert.equal((await runGameMaterialAuditTick(f.env,NOW+120000)).status,"snapshot-complete");
  assert.equal(f.calls.list.length,2);
  assert.equal((await post(f,"restart",NOW+180000)).status,200);
  assert.equal((await get(f,NOW+180000).then(r=>r.json())).stats.listed,0);
});

test("expired and oversized blobs are reported but never read",async()=>{
  const f=fixture();
  const old=await f.add({data:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}},{uploaded:OLD});
  const huge=await f.add({data:{id:"ABILITY_MATERIAL_BLUE_ABILITY_MAT",
    filler:"x".repeat(800000)}});
  await post(f);
  await runGameMaterialAuditTick(f.env,NOW);
  const report=await (await get(f)).json();
  assert.equal(report.status,"snapshot-complete");
  assert.equal(report.stats.tooLarge,1);
  assert.equal(report.stats.expired,1);
  assert.equal(report.stats.matched,0);
  assert.ok(!f.calls.get.includes(old.key));
  assert.ok(!f.calls.get.includes(huge.key));
});

test("invalid SHA and text-only icon references never invent material IDs",async()=>{
  const f=fixture();
  await f.add({data:{id:"ABILITY_MATERIAL_ORANGE_ABILITY_MAT"}},
    {sha:"a".repeat(64)});
  await f.add({data:{icon:"https://example.test/ABILITY_MATERIAL_GREEN.png"}});
  await post(f);
  await runGameMaterialAuditTick(f.env,NOW);
  const report=await (await get(f)).json();
  assert.equal(report.stats.invalid,1);
  assert.equal(report.stats.noMaterialId,1);
  assert.equal(report.distinctIds,0);
});

test("transient R2 read failure never advances cursor or double-counts",async()=>{
  const f=fixture();
  const item=await f.add({data:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}});
  await post(f);
  f.failRead(item.key);
  assert.equal((await runGameMaterialAuditTick(f.env,NOW)).status,"audit-unavailable");
  assert.equal(f.progress().stats.listed,0);
  assert.equal(f.progress().cursor,null);
  f.failRead(null);
  assert.equal((await runGameMaterialAuditTick(f.env,NOW+60000)).status,"snapshot-complete");
  assert.equal((await get(f,NOW+60000).then(r=>r.json())).materials[0].fileCount,1);
});

test("R2 lease prevents a concurrent tick and preserves checkpoint",async()=>{
  const f=fixture();
  await f.add({data:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}});
  await post(f);
  f.block(true);
  assert.equal((await runGameMaterialAuditTick(f.env,NOW)).status,"busy");
  assert.equal(f.progress().stats.listed,0);
  f.block(false);
  assert.equal((await runGameMaterialAuditTick(f.env,NOW)).status,"snapshot-complete");
});

test("expired report hides archived IDs and requires an intentional new start",async()=>{
  const f=fixture();
  await f.add({data:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}});
  await post(f);
  await runGameMaterialAuditTick(f.env,NOW);
  const after=NOW+31*86400000;
  const report=await (await get(f,after)).json();
  assert.equal(report.status,"expired");
  assert.equal(report.materials,undefined);
  assert.equal((await post(f,"start",after)).status,200);
});

test("admin Access and Origin checks prevent unprivileged writes",async()=>{
  const f=fixture();
  const noAuth={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  assert.equal((await handleAdmin(new Request(ENDPOINT),noAuth)).status,403);
  assert.equal(f.calls.get.length,0);
  const bad=await handleGameMaterialAudit(new Request(ENDPOINT,{
    method:"POST",headers:{Origin:"https://another.example","Content-Type":"application/json"},
    body:JSON.stringify({action:"start"})}),f.env,NOW);
  assert.equal(bad.status,403);
  assert.ok(!f.objects.has(PROGRESS));
});

test("admin HTML, script, route and existing Cron are wired",async()=>{
  const {readFile}=await import("node:fs/promises");
  const read=name=>readFile(new URL("../"+name,import.meta.url),"utf8");
  const [admin,client,worker]=await Promise.all([
    read("src/admin-routes.js"),read("public/admin-game-material-audit.js"),read("src/index.js")]);
  assert.ok(admin.includes('id="game-material-start"'));
  assert.ok(admin.includes('id="game-material-copy"'));
  assert.ok(admin.includes('src="/admin-game-material-audit.js"'));
  assert.ok(admin.includes('pathname==="/admin/api/game-material-audit"'));
  assert.ok(worker.includes("runGameMaterialAuditTick(env)"));
  assert.ok(client.includes("navigator.clipboard.writeText"));
  assert.ok(client.includes("URL.createObjectURL"));
  assert.ok(!client.includes("innerHTML"));
});
