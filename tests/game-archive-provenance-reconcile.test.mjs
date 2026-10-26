import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {handleGameProvenanceReconcile,runGameProvenanceReconcileTick}
  from "../src/game-archive-provenance-reconcile.js";
import {handleAdmin} from "../src/admin-routes.js";
globalThis.crypto ??= webcrypto;

const run="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const root="game-archive/v1/";
const p=root+"runs/"+run+"/";
const endpoint="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/game-provenance-reconcile";
const now=Date.UTC(2026,9,26,11);
const hash=x=>createHash("sha256").update(x).digest("hex");
const request=(method="GET",body={action:"start"},origin=new URL(endpoint).origin)=>
  new Request(endpoint,{method,
    ...(method==="POST"?{headers:{"Content-Type":"application/json",Origin:origin},
      body:JSON.stringify(body)}:{})});
function fixture(){
  const store=new Map(),uploaded=new Map(),writes=[],calls=[];
  let fail=null,holder=null;
  function set(key,body,time=now-3*86400000){
    const bytes=Buffer.isBuffer(body)?body:Buffer.from(
      typeof body==="string"?body:JSON.stringify(body));
    store.set(key,bytes);uploaded.set(key,new Date(time));
  }
  set(root+"active.json",{version:1,runId:run});
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      const value=store.get(key);
      return value?{size:value.length,text:async()=>value.toString("utf8")}:null;
    },
    head:async key=>{
      calls.push(["head",key]);
      return store.has(key)?{size:store.get(key).length,uploaded:uploaded.get(key)}:null;
    },
    list:async ({prefix,limit,cursor})=>{
      calls.push(["list",prefix]);
      const keys=[...store.keys()].filter(x=>x.startsWith(prefix)).sort();
      const offset=Number(cursor||0),slice=keys.slice(offset,offset+limit);
      return {objects:slice.map(key=>({key,size:store.get(key).length,
        uploaded:uploaded.get(key)})),
        truncated:offset+slice.length<keys.length,
        cursor:offset+slice.length<keys.length?String(offset+slice.length):undefined};
    },
    put:async (key,value)=>{
      writes.push(key);
      if(!key.startsWith(p+"provenance-reconciliation/v1/"))
        throw Error("unexpected write outside reconciliation");
      if(key===fail){fail=null;throw Error("simulated R2 write failure");}
      set(key,value,now);
    }
  };
  const lock={idFromName:name=>name,get:()=>({fetch:async req=>{
    const v=await req.json();
    if(v.action==="acquire"){
      if(holder)return Response.json({status:"busy"},{status:409});
      holder=v.holder;return Response.json({status:"acquired"});
    }
    if(holder===v.holder)holder=null;
    return Response.json({status:"released"});
  }})};
  const env={CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:lock};
  function orphan(body,time){
    const id=hash(body),key=p+"objects/"+id+".json";
    set(key,body,time);return {id,key};
  }
  function snapshot(references=[]){
    set(p+"orphan-audit/v1-progress.json",{
      version:1,runId:run,status:"snapshot-complete",objects:{orphaned:2},
      references
    });
  }
  function official(path,body,{received=now-86400000,observed,missing=false}={}){
    const id=hash(body),h=hash(path),diff=root+"diff/";
    const obj=diff+"runs/11111111-2222-4333-8444-555555555555/objects/"+id+".json";
    const receiptKey=diff+"runs/11111111-2222-4333-8444-555555555555/checks/00000001.json";
    const checkedAt=new Date(received).toISOString();
    const receipt={version:2,path,status:"changed",
      sha256:id,observedSha256:observed||id,objectKey:obj,
      storedAt:checkedAt,checkedAt,semanticHash:"a".repeat(64)};
    const pointer={...receipt,receiptKey};
    if(!missing){set(obj,body,received);set(receiptKey,receipt,received);}
    set(diff+"latest/"+h+".json",pointer,received);
    return {id,obj,receiptKey};
  }
  return {env,store,writes,calls,set,snapshot,orphan,official,failOnce:key=>fail=key};
}
async function get(f){return(await(await handleGameProvenanceReconcile(request(),f.env,now)).json());}
async function runToEnd(f){
  for(let i=0;i<100;i++){
    const state=await runGameProvenanceReconcileTick(f.env,now+i*1000);
    assert.notEqual(state.status,"provenance-tick-unavailable");
    if(state.status==="snapshot-complete")return get(f);
  }
  throw Error("should finish in bounded ticks");
}
test("matches byte-identical later official GET, without restoring historical receipts",async()=>{
  const f=fixture(),body=JSON.stringify({data:{id:"Hero"},meta:{version:1}});
  const one=f.orphan(body);
  const other=f.orphan(JSON.stringify({data:{id:"Other"}}));
  const referenced=f.orphan(JSON.stringify({data:{id:"Known"}}));
  f.snapshot([referenced.id+".json"]);
  f.official("/game/v1/characters/Hero",body);
  assert.equal((await handleGameProvenanceReconcile(request("POST"),f.env,now)).status,200);
  const state=await runToEnd(f);
  assert.equal(state.status,"snapshot-complete");
  assert.equal(state.sources.verified,1);
  assert.equal(state.objects.listed,3);
  assert.equal(state.objects.withReceipt,1);
  assert.equal(state.objects.matched,1);
  assert.equal(state.objects.unresolved,1);
  assert.deepEqual(f.writes.every(x=>x.startsWith(p+"provenance-reconciliation/v1/")),true);
  const linkKey=p+"provenance-reconciliation/v1/matches/"+one.id+".json";
  const linked=JSON.parse(f.store.get(linkKey));
  assert.equal(linked.path,"/game/v1/characters/Hero");
  assert.equal(linked.objectKey,one.key);
  assert.equal(linked.historicalOriginalRequest,"not-proven");
  assert.ok(!f.store.has(p+"provenance-reconciliation/v1/matches/"+other.id+".json"));
  assert.equal((await handleGameProvenanceReconcile(request("POST"),f.env,now)).status,200);
  assert.equal((await runGameProvenanceReconcileTick(f.env,now)).status,"snapshot-complete");
});
test("same blob claimed by distinct official paths remains ambiguous",async()=>{
  const f=fixture(),body=JSON.stringify({data:{id:"shared"}});
  f.orphan(body);f.snapshot();
  // Different proof journals for distinct paths; never invent uniqueness.
  const a=f.official("/game/v1/items/a",body);
  const second=f.official("/game/v1/items/b",body);
  f.set(a.receiptKey,{
    version:2,path:"/game/v1/items/a",sha256:a.id,
    observedSha256:a.id,status:"changed",objectKey:a.obj,
    checkedAt:new Date(now-86400000).toISOString(),
    storedAt:new Date(now-86400000).toISOString()
  });
  // First pointer's journal is now reused in this fixture, so intentionally
  // isolate the second and ensure the two valid journals differ.
  const secondReceipt=second.receiptKey.replace("00000001","00000002");
  f.set(secondReceipt,{
    version:2,path:"/game/v1/items/b",sha256:a.id,
    observedSha256:a.id,status:"changed",objectKey:a.obj,
    checkedAt:new Date(now-86400000).toISOString(),
    storedAt:new Date(now-86400000).toISOString()
  });
  const pointerKey=root+"diff/latest/"+hash("/game/v1/items/b")+".json";
  const pointer=JSON.parse(f.store.get(pointerKey));
  pointer.receiptKey=secondReceipt;f.set(pointerKey,pointer);
  const one=root+"diff/latest/"+hash("/game/v1/items/a")+".json";
  const original=JSON.parse(f.store.get(one));original.receiptKey=a.receiptKey;f.set(one,original);
  await handleGameProvenanceReconcile(request("POST"),f.env,now);
  const out=await runToEnd(f);
  assert.equal(out.objects.matched,0);
  assert.equal(out.objects.ambiguous,1);
});
test("asOf-only changed observed bytes, missing journal and old blob cannot be certified",async()=>{
  const f=fixture();
  const raw=JSON.stringify({data:{id:"x"},meta:{asOf:1}});
  f.orphan(raw);f.snapshot();
  f.official("/game/v1/characters/x",raw,{observed:"b".repeat(64)});
  await handleGameProvenanceReconcile(request("POST"),f.env,now);
  const out=await runToEnd(f);
  assert.equal(out.sources.rejected,1);
  assert.equal(out.objects.matched,0);
});
test("stale original R2 object never gets a supposedly fresh link",async()=>{
  const f=fixture(),body=JSON.stringify({data:{id:"old"}});
  f.orphan(body,now-31*86400000);f.snapshot();
  f.official("/game/v1/characters/old",body);
  await handleGameProvenanceReconcile(request("POST"),f.env,now);
  const out=await runToEnd(f);
  assert.equal(out.objects.expiredOrUnknown,1);
  assert.equal(out.objects.matched,0);
});
test("interrupted match write can safely resume without duplicate counters",async()=>{
  const f=fixture(),body=JSON.stringify({data:{id:"retry"}});
  const ref=f.orphan(body);f.snapshot();
  f.official("/game/v1/characters/retry",body);
  await handleGameProvenanceReconcile(request("POST"),f.env,now);
  await runGameProvenanceReconcileTick(f.env,now);
  f.failOnce(p+"provenance-reconciliation/v1/matches/"+ref.id+".json");
  const first=await runGameProvenanceReconcileTick(f.env,now);
  assert.equal(first.status,"provenance-tick-unavailable");
  const done=await runToEnd(f);
  assert.equal(done.objects.matched,1);
});
test("explicit start requires finished old audit; admin Access and same origin stay required",async()=>{
  const f=fixture();
  assert.equal((await handleGameProvenanceReconcile(request("POST"),f.env,now)).status,409);
  f.snapshot();
  assert.equal((await handleGameProvenanceReconcile(request("POST",{
    action:"start"},"https://evil.example"),f.env,now)).status,403);
  assert.equal((await handleGameProvenanceReconcile(request("POST",{
    action:"reset"}),f.env,now)).status,400);
  assert.equal((await handleGameProvenanceReconcile(new Request(endpoint+"?reset=1"),
    f.env,now)).status,400);
  const before=f.calls.length;
  const guarded=await handleAdmin(request(),{...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"secure.cloudflareaccess.com",CF_ACCESS_AUD:"a".repeat(64),
    MSF_ADMIN_EMAILS:"admin@example.test"},async()=>{throw Error("network forbidden");});
  assert.equal(guarded.status,403);
  assert.equal(f.calls.length,before);
});
test("private admin UX keeps new control under R2 tab and never accesses Scopely",async()=>{
  const code=await readFile(new URL("../public/admin-game-provenance.js",import.meta.url),"utf8");
  const admin=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const nav=await readFile(new URL("../public/admin-navigation.js",import.meta.url),"utf8");
  const worker=await readFile(new URL("../src/index.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(code));
  assert.doesNotMatch(code,/innerHTML|localStorage|sessionStorage|eval\(/);
  assert.match(admin,/\/admin\/api\/game-provenance-reconcile/);
  assert.match(nav,/game-provenance-start/);
  assert.match(worker,/runGameProvenanceReconcileTick/);
});
