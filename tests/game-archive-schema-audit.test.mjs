import {test} from "node:test";
import assert from "node:assert/strict";
import {inspectNestedGameShape,handleGameArchiveSchemaAudit,
  runGameArchiveSchemaAuditTick} from "../src/game-archive-schema-audit.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const runId="11111111-2222-4333-8444-555555555555";
const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const endpoint=origin+"/admin/api/game-archive-schema-audit";
const prefix=GAME_ARCHIVE_ROOT+"runs/"+runId+"/";
const blob=i=>prefix+"objects/"+i.toString(16).padStart(64,"0")+".json";
function fixture(){
  const store=new Map(),calls=[],keys=[];
  store.set(GAME_ARCHIVE_ROOT+"active.json",{version:1,runId});
  store.set(prefix+"progress.json",{status:"running"});
  const env={CAPTAIN_BUCKET:{
    get:async k=>{
      calls.push(["get",k]);
      if(!store.has(k))return null;
      return {text:async()=>JSON.stringify(store.get(k))};
    },
    head:async k=>{
      calls.push(["head",k]);
      if(!store.has(k))return null;
      return {size:JSON.stringify(store.get(k)).length};
    },
    put:async(k,v)=>{
      calls.push(["put",k]);
      if(!k.startsWith(prefix+"schema-audit/"))
        throw Error("unexpected mutation outside audit prefix");
      store.set(k,JSON.parse(v));
    },
    list:async args=>{
      calls.push(["list",args.prefix]);
      if(args.prefix!==prefix+"receipts/")
        throw Error("unexpected listing of private R2");
      const sorted=[...keys].sort();
      const start=args.cursor?Number(args.cursor):0;
      const batch=sorted.slice(start,start+args.limit);
      return {objects:batch.map(key=>({key})),
        truncated:start+batch.length<sorted.length,
        cursor:start+batch.length<sorted.length?
          String(start+batch.length):undefined};
    }
  }};
  function add(i,family,body,options={}){
    const name=prefix+"receipts/"+String(i).padStart(6,"0")+".json";
    const path="/game/v1/"+family+"/"+i;
    const key=blob(i);
    keys.push(name);
    store.set(name,{path,status:options.status||200,
      objectKey:options.objectKey||key});
    if(!options.missingObject)
      store.set(key,body);
  }
  return {store,calls,keys,env,add};
}
async function start(f){
  return handleGameArchiveSchemaAudit(new Request(endpoint,{method:"POST",
    headers:{"Content-Type":"application/json","Origin":origin},
    body:JSON.stringify({action:"start"})}),f.env);
}
const report=async f=>(await (await handleGameArchiveSchemaAudit(
  new Request(endpoint),f.env)).json());

test("deep structure extraction includes nested abilities and metadata keys, but no source values",()=>{
  const source={data:[{id:"A",basic:{effects:[{damage:{amount:123,
    description:"keep-me-secret"}}]}}],meta:{version:125,
      hashes:{characters:"hash-secret"}}};
  const shape=inspectNestedGameShape(source);
  const fields=new Map(shape.paths.map(x=>[x.path,x.types]));
  assert.deepEqual(fields.get("data[].basic.effects[].damage.amount"),["number"]);
  assert.deepEqual(fields.get("meta.hashes.characters"),["string"]);
  assert.ok(shape.variant.fields.includes("basic"));
  assert.ok(!JSON.stringify(shape).includes("keep-me-secret"));
  assert.ok(!JSON.stringify(shape).includes("hash-secret"));
});

test("one-click audit advances with cron only, survives admin reopening, and never calls Scopely",async()=>{
  const f=fixture();
  for(let i=0;i<74;i++)
    f.add(i,"events",{data:{id:String(i),name:"private-event-value",
      type:"event",...(i%3?{milestone:{target:6}}:{details:{goal:"x"}})},
      meta:{version:"secret-version"}});
  f.add(74,"characters",{data:[{id:"A",basic:{effects:[{type:"buff"}]}}]});
  f.add(75,"raids",{data:{id:"Raid",name:"Raid Name"}});
  f.add(76,"iso8Abilities",{data:{striker:{level:1}}});
  f.add(77,"traits",{data:{trait:"trait-secret"}});
  f.add(78,"characterInstances",{data:[{id:"B",passive:{effects:[{damage:7}]}}]});
  f.add(79,"items",{data:{id:"ITEM",directCost:3}});
  assert.equal((await start(f)).status,200);
  let state=await report(f);
  assert.equal(state.status,"running");
  assert.equal(state.receiptsListed,0);
  // With 200 receipts per tick, this 80-receipt fixture completes in
  // one tick. Do not press "start" again: that intentionally starts a new
  // audit when the previous scan already reached snapshot-complete.
  await runGameArchiveSchemaAuditTick(f.env);
  assert.equal((await report(f)).receiptsListed,80);
  // Eight-step bounded scan reaches the end without needing an open browser.
  for(let i=0;i<10;i++){
    state=await report(f);
    if(state.status==="snapshot-complete")break;
    await runGameArchiveSchemaAuditTick(f.env);
  }
  state=await report(f);
  assert.equal(state.status,"snapshot-complete");
  assert.equal(state.receiptsListed,80);
  assert.equal(state.validReceipts,80);
  assert.equal(state.families.find(x=>x.family==="events").receipts,74);
  assert.ok(state.families.find(x=>x.family==="characters").inspected>0);
  assert.ok(state.families.find(x=>x.family==="raids").inspected>0);
  assert.equal(state.families.find(x=>x.family==="events").inspected,0,
    "rare families take priority on a page containing exactly six rare families");
  assert.equal(f.calls.filter(([op])=>op==="list").length,1);
  assert.ok(f.calls.every(([op,key])=>op!=="put"||
    key.startsWith(prefix+"schema-audit/")));
  assert.ok(!JSON.stringify(state).includes("private-event-value"));
  assert.ok(!JSON.stringify(state).includes("secret-version"));
  // Last scan was during a running collector; coverage must be qualified.
  assert.match(state.note,/collecte encore active/);
  f.store.set(prefix+"progress.json",{status:"completed-with-gaps"});
  const newStart=await start(f);
  assert.equal(newStart.status,200);
  assert.equal((await newStart.json()).receiptsListed,0);
});


test("200-receipt tick resumes from an existing R2 cursor without replaying or resetting",async()=>{
  const f=fixture();
  for(let i=0;i<430;i++)
    f.add(i,i%2?"events":"characters",{data:{id:String(i),name:"value-"+i}});
  await start(f);
  // Simulate an audit saved before the accelerated release.
  const key=prefix+"schema-audit/progress.json";
  const state=f.store.get(key);
  state.cursor="35";
  state.pages=1;
  state.receiptsListed=35;
  state.validReceipts=35;
  f.store.set(key,state);
  const previousCalls=f.calls.length;
  await runGameArchiveSchemaAuditTick(f.env);
  let current=await report(f);
  assert.equal(current.status,"running");
  assert.equal(current.receiptsListed,235);
  assert.equal(current.validReceipts,235);
  assert.equal(current.pages,2);
  assert.equal(f.calls.slice(previousCalls).filter(([op,k])=>
    op==="get"&&k.startsWith(prefix+"receipts/")).length,200);
  assert.equal((await (await start(f)).json()).receiptsListed,235);
  await runGameArchiveSchemaAuditTick(f.env);
  current=await report(f);
  assert.equal(current.status,"snapshot-complete");
  assert.equal(current.receiptsListed,430);
  assert.equal(current.pages,3);
  assert.equal(current.families.reduce((n,x)=>n+x.receipts,0),395);
});

test("parallel receipt retrieval stays within five concurrent R2 reads",async()=>{
  const f=fixture();
  for(let i=0;i<230;i++)f.add(i,"events",{data:{id:String(i)}});
  const original=f.env.CAPTAIN_BUCKET.get;
  let active=0,peak=0;
  f.env.CAPTAIN_BUCKET.get=async key=>{
    if(key.includes("/receipts/")){
      active++;peak=Math.max(peak,active);
      try{
        await new Promise(resolve=>setImmediate(resolve));
        return await original(key);
      }finally{active--;}
    }
    return original(key);
  };
  await start(f);
  await runGameArchiveSchemaAuditTick(f.env);
  const data=await report(f);
  assert.equal(data.receiptsListed,200);
  assert.equal(data.status,"running");
  assert.ok(peak>1,"R2 receipt reads should actually overlap");
  assert.ok(peak<=5,"Cloudflare supports six simultaneous outgoing connections");
});

test("samples are diversified across families even if event receipts dominate",async()=>{
  const f=fixture();
  for(let i=0;i<34;i++)f.add(i,"events",{data:{id:String(i)}});
  f.add(34,"traits",{data:{a:{b:2}}});
  await start(f);
  await runGameArchiveSchemaAuditTick(f.env);
  const state=await report(f);
  assert.equal(state.families.find(f=>f.family==="traits").inspected,1);
  assert.ok(state.families.find(f=>f.family==="events").inspected>=1);
  assert.ok(state.families.find(f=>f.family==="events").inspected<=6);
});

test("oversized and unindexed objects never load; invalid game paths do not expose other private prefixes",async()=>{
  const f=fixture();
  f.add(0,"characters",{data:{long:"z".repeat(1_260_000)}});
  f.add(1,"events",{data:{id:"E"}},{
    objectKey:prefix+"raw/11111111-2222-4333-8444-555555555555.json"});
  f.add(2,"items",{data:{id:"Bad"}},{
    objectKey:"oauth-captains/v1/access-token.json"});
  f.add(3,"traits",{data:{id:"Private"}},{
    objectKey:prefix+"objects/"+("x".repeat(64))+".json"});
  const bad=prefix+"receipts/999999.json";
  f.keys.push(bad);
  f.store.set(bad,{status:200,
    path:"/player/v1/roster?accessToken=secret",objectKey:blob(2)});
  await start(f);
  await runGameArchiveSchemaAuditTick(f.env);
  const data=await report(f);
  assert.equal(data.receiptsListed,5);
  assert.equal(data.validReceipts,4);
  assert.equal(data.families.find(x=>x.family==="characters").tooLarge,1);
  assert.equal(data.families.find(x=>x.family==="events").unindexed,1);
  assert.equal(data.families.find(x=>x.family==="items").invalid,1);
  assert.ok(!JSON.stringify(data).includes("oauth-captains"));
  assert.ok(!JSON.stringify(data).includes("accessToken"));
  assert.ok(!f.calls.some(([op,key])=>op==="get"&&key===blob(0)),
    "large JSON must not load");
  assert.ok(!f.calls.some(([op,key])=>op==="get"&&key==="oauth-captains/v1/access-token.json"));
});

test("the admin endpoint rejects CSRF and bypassed Cloudflare Access",async()=>{
  const f=fixture();
  const absentOrigin=new Request(endpoint,{method:"POST",
    headers:{"Content-Type":"application/json"},body:'{"action":"start"}'});
  assert.equal((await handleGameArchiveSchemaAudit(absentOrigin,f.env)).status,403);
  assert.equal((await handleGameArchiveSchemaAudit(new Request(endpoint+"?cursor=evil"),
    f.env)).status,400);
  const bad={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const result=await handleAdmin(new Request(endpoint),bad);
  assert.equal(result.status,403);
  assert.equal(f.calls.filter(x=>x[0]==="get").length,1);
  assert.equal(f.calls.filter(x=>x[0]==="list").length,0);
});
