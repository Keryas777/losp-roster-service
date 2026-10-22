import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";
import {handleGameOrphanAudit,runGameOrphanAuditTick} from "../src/game-archive-orphan-audit.js";
import {handleAdmin} from "../src/admin-routes.js";
globalThis.crypto ??= webcrypto;
const run="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const prefix=GAME_ARCHIVE_ROOT+"runs/"+run+"/";
const endpoint="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/game-archive-orphan-audit";
const date=Date.UTC(2026,9,21,16,30);
const data=(d)=>JSON.stringify({data:d,meta:{version:10}});
const hash=value=>createHash("sha256").update(value).digest("hex")+".json";
function fixture(){
  const store=new Map(),calls=[],writes=[];
  const encode=v=>typeof v==="string"?Buffer.from(v):Buffer.isBuffer(v)?v:Buffer.from(JSON.stringify(v));
  const put=(key,v)=>store.set(key,encode(v));
  put(GAME_ARCHIVE_ROOT+"active.json",{version:1,runId:run});
  const r2={
    get:async key=>{
      calls.push(["get",key]);
      const value=store.get(key);
      if(!value)return null;
      return {size:value.byteLength,text:async()=>value.toString("utf8"),
        arrayBuffer:async()=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)};
    },
    list:async ({prefix:p,limit,cursor})=>{
      calls.push(["list",p]);
      const keys=[...store.keys()].filter(k=>k.startsWith(p)).sort();
      const offset=cursor?Number(cursor):0;
      const group=keys.slice(offset,offset+limit);
      return {objects:group.map(key=>({key,size:store.get(key).length})),
        truncated:offset+group.length<keys.length,
        cursor:offset+group.length<keys.length?String(offset+group.length):undefined};
    },
    put:async (key,value)=>{
      writes.push(key);
      if(!key.startsWith(prefix+"orphan-audit/"))throw Error("writes outside audit state forbidden");
      put(key,value);
    },
    delete:async()=>{throw Error("delete forbidden");}
  };
  let leaseHolder=null;
  const lock={idFromName:key=>key,get:()=>({
    fetch:async request=>{
      const message=await request.json();
      if(message.action==="acquire"){
        if(leaseHolder)return Response.json({status:"busy"},{status:409});
        leaseHolder=message.holder;
        return Response.json({status:"acquired"});
      }
      if(leaseHolder===message.holder)leaseHolder=null;
      return Response.json({status:"released"});
    }
  })};
  return {env:{CAPTAIN_BUCKET:r2,ROSTER_BATCH_LOCK:lock},store,put,calls,writes};
}
const req=(method="GET",opts={})=>new Request(endpoint,{
  method,headers:method==="POST"?{"Content-Type":"application/json",
    Origin:opts.origin||new URL(endpoint).origin}:{},
  ...(method==="POST"?{body:JSON.stringify(opts.body??{action:"start"})}:{})
});
function obj(f,value,name=hash(value)){
  f.put(prefix+"objects/"+name,value);
  return prefix+"objects/"+name;
}
const receipt=(f,n,path,key)=>f.put(prefix+"receipts/"+String(n).padStart(6,"0")+".json",{
  status:200,path,objectKey:key
});
async function complete(f){
  let answer,steps=0;
  do{
    answer=await runGameOrphanAuditTick(f.env,date+steps*60_000);
    assert.notEqual(answer.status,"orphan-audit-unavailable",JSON.stringify(answer));
    if(++steps>50)throw Error("audit should finish in bounded steps");
  }while(answer.status==="running");
  return (await(await handleGameOrphanAudit(req(),f.env)).json());
}

test("checkpointed inventory verifies orphan hashes and limits source claims",async()=>{
  const f=fixture();
  const known=obj(f,data({id:"Hulk",traits:[],name:"Hulk",portrait:"Hulk",
    unlockStars:2,status:"active"}));
  receipt(f,1,"/game/v1/characters?page=1&perPage=100",known);
  const character=obj(f,data({id:"Hero",traits:[],portrait:"P",unlockStars:2,
    status:"active",name:"Hero"}));
  const event=obj(f,data({id:"Event",startTime:10,endTime:20,
    milestone:{},name:"Event"}));
  const nonJSON=obj(f,"{ invalid json");
  const forged=obj(f,data({id:"Forged"}),"f".repeat(64)+".json");
  const tooLarge=obj(f,"A".repeat(256001));
  f.put(prefix+"queue/00000000.json",[
    {path:"/game/v1/characters/Hero"},{path:"/game/v1/events/Event"}]);
  f.put(prefix+"phase2-seen/00.json",["/game/v1/characters/Hero"]);
  f.put(prefix+"progress.json",{version:1,status:"completed-with-gaps",
    count:7428,completedOffset:8000,cursor:748,tasks:[{path:"/game/v1/characters/Hero"}]});
  const started=await handleGameOrphanAudit(req("POST"),f.env,date);
  assert.equal(started.status,200);
  assert.equal((await started.json()).status,"running");
  const first=await runGameOrphanAuditTick(f.env,date);
  assert.equal(first.phase,"evidence"); // Receipt pass processed
  const before=(await(await handleGameOrphanAudit(req(),f.env)).json());
  assert.equal(before.receipts.valid,1);
  // "Restart" returns existing checkpoint and cannot reset progress.
  const again=(await(await handleGameOrphanAudit(req("POST"),f.env,date)).json());
  assert.equal(again.receipts.listed,1);
  const result=await complete(f);
  assert.equal(result.status,"snapshot-complete");
  assert.equal(result.phase,"complete");
  assert.deepEqual(result.receipts,{listed:1,valid:1,invalid:0,unreadable:0});
  assert.equal(result.objects.listed,6);
  assert.equal(result.objects.withReceipt,1);
  assert.equal(result.objects.orphaned,5);
  assert.equal(result.objects.hashVerified,3); // character, event and invalid JSON
  assert.equal(result.objects.inspected,2);
  assert.equal(result.objects.invalidJSON,1);
  assert.equal(result.objects.hashMismatch,1);
  assert.equal(result.objects.tooLarge,1);
  assert.equal(result.evidence.queueTasks,2);
  assert.equal(result.evidence.seenPaths,1);
  assert.equal(result.evidence.collectorArchived,7428);
  assert.equal(result.evidence.collectorTasks,8748);
  assert.equal(result.referenceCount,1);
  assert.equal(result.likelyFamilies.characters,1);
  assert.equal(result.likelyFamilies.events,1);
  assert.ok(result.variants.every(x=>x.confidence==="structural-hypothesis-only"));
  assert.ok(f.writes.every(k=>k.startsWith(prefix+"orphan-audit/")));
  assert.ok(f.calls.every(([op,k])=>k===GAME_ARCHIVE_ROOT+"active.json"||
    k.startsWith(prefix)), "must never touch roster or OAuth storage");
  assert.doesNotMatch(JSON.stringify(result),/Hero|Hulk|SECRET|Game Event/);
  assert.equal((await runGameOrphanAuditTick(f.env,date)).status,"snapshot-complete");
  assert.ok(known&&character&&event&&nonJSON&&forged&&tooLarge);
});

test("receipts are bounded and invalid references cannot confer provenance",async()=>{
  const f=fixture();
  const o=obj(f,data({id:"X",traits:[],portrait:"X",unlockStars:2}));
  receipt(f,0,"/game/v1/characters/X",o);
  receipt(f,1,"/player/v1/roster",o);
  receipt(f,2,"/game/v1/characters/X","secret-bucket/rosters.json");
  f.put(prefix+"receipts/invalid-json.json","{invalid");
  f.put(prefix+"receipts/oversized.json","X".repeat(5000));
  await handleGameOrphanAudit(req("POST"),f.env,date);
  const out=await complete(f);
  assert.equal(out.receipts.listed,5);
  assert.equal(out.receipts.valid,1);
  assert.equal(out.receipts.invalid,2);
  assert.equal(out.receipts.unreadable,2);
  assert.equal(out.objects.withReceipt,1);
  assert.equal(out.objects.orphaned,0);
});

test("resumes across many paginated object chunks without rereading previous chunks",async()=>{
  const f=fixture();
  for(let i=0;i<91;i++)obj(f,data({id:"ONLY_ID_"+i}));
  await handleGameOrphanAudit(req("POST"),f.env,date);
  // receipt tick, queue tick, seen tick -> objects scan
  for(let i=0;i<3;i++)await runGameOrphanAuditTick(f.env,date+i);
  await runGameOrphanAuditTick(f.env,date+3);
  const mid=await(await handleGameOrphanAudit(req(),f.env)).json();
  assert.equal(mid.objects.listed,40);
  assert.equal(mid.phase,"objects");
  const out=await complete(f);
  assert.equal(out.objects.listed,91);
  assert.equal(out.objects.orphaned,91);
  assert.equal(out.objects.hashVerified,91);
  assert.equal(out.objects.inspected,91);
  assert.equal(out.likelyFamilies.indetermined,91);
  assert.equal(out.status,"snapshot-complete");
  assert.equal(f.calls.filter(([method,key])=>method==="get"&&
    key.startsWith(prefix+"objects/")).length,91);
});

test("same-origin admin POST, parameters and Cloudflare Access are required",async()=>{
  const f=fixture();
  assert.equal((await handleGameOrphanAudit(req("POST",{origin:"https://other.example"}),
    f.env,date)).status,403);
  assert.equal((await handleGameOrphanAudit(req("POST",{body:{action:"reset"}}),
    f.env,date)).status,400);
  assert.equal((await handleGameOrphanAudit(new Request(endpoint+"?force=true"),
    f.env,date)).status,400);
  assert.equal((await handleGameOrphanAudit(new Request(endpoint,{
    method:"DELETE"}),f.env,date)).status,405);
  assert.deepEqual(f.writes,[]);
  const config={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"test.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const before=f.calls.length;
  const guarded=await handleAdmin(req(),config,async()=>{throw Error("No network");});
  assert.equal(guarded.status,403);
  assert.equal(f.calls.length,before,
    "Cloudflare Access must reject before any NEW private R2 access");
});

test("mobile admin script uses safe text and never downloads player/Scopely data",async()=>{
  const code=await readFile(new URL("../public/admin-game-orphan-audit.js",import.meta.url),"utf8");
  const admin=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const index=await readFile(new URL("../src/index.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(code));
  assert.match(code,/textContent/);
  assert.doesNotMatch(code,/innerHTML|localStorage|sessionStorage|indexedDB|eval\(/);
  assert.match(admin,/admin-game-orphan-audit\.js/);
  assert.match(admin,/\/admin\/api\/game-archive-orphan-audit/);
  assert.match(index,/runGameOrphanAuditTick/);
});
