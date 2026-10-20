import {test} from "node:test";
import assert from "node:assert/strict";
import {inspectNestedGameShape,classifyGameRoute,
  handleGameArchiveSchemaAudit,runGameArchiveSchemaAuditTick}
  from "../src/game-archive-schema-audit.js";
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
  function add(i,path,body,options={}){
    const name=prefix+"receipts/"+String(i).padStart(6,"0")+".json";
    const key=blob(i);
    keys.push(name);
    store.set(name,{path,status:options.status||200,
      objectKey:options.objectKey||key});
    if(!options.missingObject)store.set(key,body);
  }
  return {store,calls,keys,env,add};
}
async function start(f){
  return handleGameArchiveSchemaAudit(new Request(endpoint,{method:"POST",
    headers:{"Content-Type":"application/json","Origin":origin},
    body:'{"action":"start"}'}),f.env);
}
const report=async f=>(await (await handleGameArchiveSchemaAudit(
  new Request(endpoint),f.env)).json());
async function finish(f,max=80){
  for(let i=0;i<max;i++){
    const state=await report(f);
    if(state.status==="snapshot-complete")return state;
    const outcome=await runGameArchiveSchemaAuditTick(f.env);
    assert.notEqual(outcome.status,"audit-unavailable");
  }
  throw Error("audit never reached snapshot-complete");
}
test("numeric ISO-8 level keys are normalized; ability ranks are typed, never leaked",()=>{
  const doc={data:{striker:{levels:{
    1:{description:"private-one",nextUpgrade:"two"},
    2:{description:"private-two",nextUpgrade:"three"},
    3:{description:"private-three"}
  }},character:{basic:7,special:7,ultimate:8,passive:6}},
    meta:{version:14,hashes:{events:"no-raw-hashes"}}};
  const shape=inspectNestedGameShape(doc);
  const paths=new Map(shape.paths.map(x=>[x.path,x.types]));
  assert.deepEqual(paths.get("data.striker.levels.{n}.description"),["string"]);
  assert.ok(!paths.has("data.striker.levels.1.description"));
  assert.deepEqual(paths.get("data.character.basic"),["number"]);
  assert.deepEqual(paths.get("meta.hashes.events"),["string"]);
  assert.equal([...paths.keys()].filter(s=>s.endsWith(".description")).length,1);
  assert.ok(!JSON.stringify(shape).includes("private-one"));
  assert.ok(!JSON.stringify(shape).includes("no-raw-hashes"));
  assert.ok(!JSON.stringify(shape).includes('"basic":7'));
});
test("classifies real game routes rather than mixing lists, detail and relationships",()=>{
  const cases=[
    ["/game/v1/events?page=1&perPage=100","events","collection"],
    ["/game/v1/events/123456","events/{id}","detail"],
    ["/game/v1/items/GEAR_BLUE","items/{id}","detail"],
    ["/game/v1/items/GEAR_BLUE/characters?charInfo=full",
      "items/{id}/characters","nested"],
    ["/game/v1/episodics/unlockEvent/ELEKTRA_UNLOCK",
      "episodics/unlockEvent/{id}","detail"],
    ["/game/v1/episodics/otherEvent?page=1",
      "episodics/otherEvent","collection"],
    ["/game/v1/analysis/teamOrder?page=1",
      "analysis/teamOrder","collection"]
  ];
  for(const [path,route,kind] of cases){
    assert.equal(classifyGameRoute(path)?.route,route);
    assert.equal(classifyGameRoute(path)?.kind,kind);
  }
  assert.equal(classifyGameRoute("/player/v1/roster"),null);
});
test("realistic 632-receipt distribution: ALL 16 families get fair attempts, including events and characters",async()=>{
  const f=fixture();
  let i=0;
  for(let n=0;n<397;n++)f.add(i++,"/game/v1/items/"+n,{
    data:{id:"ITEM"+n,name:"Name",tier:n%3,noDeco:n%2===0}});
  for(let n=0;n<141;n++)f.add(i++,"/game/v1/events/"+n,{
    data:{id:"EV"+n,name:"Sensitive name",type:"milestone",
      ...(n%2?{milestone:{target:7}}:{details:"text"})}});
  for(let n=0;n<65;n++)f.add(i++,
    "/game/v1/episodics/unlockEvent/ID"+n,{
      data:{id:"ID"+n,name:"Event",chapters:{1:{numTiers:2}}}});
  for(let n=0;n<10;n++)f.add(i++,"/game/v1/characterInstances/CHAR"+n,
    {data:{id:"CHAR"+n,basic:7,special:8,ultimate:8,passive:6}});
  for(let n=0;n<6;n++)f.add(i++,"/game/v1/characters/CHAR"+n,
    {data:{id:"CHAR"+n,name:"PRIVATE_NAME"}});
  for(const root of ["characterInstanceCaps","traits"])for(let n=0;n<2;n++)
    f.add(i++,"/game/v1/"+root+"/"+n,{data:{id:"ID"+n}});
  const nine=["analysis/teamOrder","dds","decorations","iso8Abilities",
    "pickYourPoisons","raidGroups","raids","scopes","survivalTowers"];
  for(const root of nine)f.add(i++,"/game/v1/"+root+"?page=1",{
    data:root==="raids"?[{id:"raid001"}]:{id:"ID",description:"secret"}});
  assert.equal(i,632);
  // Legacy report from the earlier 24-sample scan must survive intact.
  const legacyKey=prefix+"schema-audit/progress.json";
  f.store.set(legacyKey,{version:1,receiptsListed:632,status:"snapshot-complete"});
  await start(f);
  let state=await report(f);
  assert.equal(state.version,2);
  assert.equal(state.phase,"indexing");
  for(let tick=0;tick<4;tick++)await runGameArchiveSchemaAuditTick(f.env);
  state=await report(f);
  assert.equal(state.receiptsListed,632);
  assert.equal(state.validReceipts,632);
  assert.equal(state.phase,"sampling");
  assert.ok(state.families.every(x=>x.inspected===0),
    "pass 1 must not spend JSON reads on early item receipts");
  state=await finish(f);
  assert.equal(state.status,"snapshot-complete");
  assert.equal(state.families.length,16);
  assert.equal(state.failedReceipts,0);
  for(const family of state.families){
    assert.ok(family.inspected>=1,
      family.family+" was starved despite having an accessible indexed JSON");
    assert.ok(family.routes.every(route=>route.inspected>=1),
      family.family+" has an uninspected route");
  }
  assert.equal(state.families.find(x=>x.family==="items").receipts,397);
  assert.equal(state.families.find(x=>x.family==="events").receipts,141);
  assert.ok(state.families.find(x=>x.family==="events").inspected>0);
  assert.ok(state.families.find(x=>x.family==="characters").inspected>0);
  assert.equal(f.store.get(legacyKey).version,1);
  assert.equal(f.store.get(legacyKey).receiptsListed,632);
  assert.equal(f.calls.filter(([op])=>op==="list").length,4);
  assert.ok(f.calls.every(([op,key])=>op!=="put"||
    key.startsWith(prefix+"schema-audit/")));
  assert.ok(!JSON.stringify(state).includes("Sensitive name"));
  assert.ok(!JSON.stringify(state).includes("PRIVATE_NAME"));
  assert.ok(!JSON.stringify(state).includes('"basic":7'));
  assert.match(state.note,/collecte encore active/);
  f.store.set(prefix+"progress.json",{status:"completed-with-gaps"});
  const restarted=await (await start(f)).json();
  assert.equal(restarted.phase,"indexing");
  assert.equal(restarted.receiptsListed,0);
});
test("route mix is sampled independently within same family; collection vs detail vs relation",async()=>{
  const f=fixture();
  for(let i=0;i<44;i++)
    f.add(i,"/game/v1/items/GEAR"+i,{data:{id:"GEAR"+i,name:"Obj"}});
  f.add(44,"/game/v1/items?page=1",{data:[{id:"GEAR001"}]});
  f.add(45,"/game/v1/items/GEAR001/characters?page=1",
    {data:[{character:{id:"A"},equips:[]} ]});
  await start(f);
  const state=await finish(f);
  const group=state.families.find(x=>x.family==="items");
  assert.equal(group.routes.length,3);
  assert.deepEqual(group.routes.map(x=>x.pattern).sort(),
    ["items","items/{id}","items/{id}/characters"]);
  for(const route of group.routes)assert.ok(route.inspected>=1);
  assert.ok(group.variants.some(v=>v.kind==="array"));
  assert.ok(group.variants.some(v=>v.kind==="object"));
});
test("200 receipts per tick, with five or fewer simultaneous R2 GETs; no provider access",async()=>{
  const f=fixture();
  for(let i=0;i<230;i++)
    f.add(i,"/game/v1/events/"+i,{data:{id:String(i)}});
  const original=f.env.CAPTAIN_BUCKET.get;
  let active=0,peak=0;
  f.env.CAPTAIN_BUCKET.get=async key=>{
    if(key.includes("/receipts/")){
      active++;peak=Math.max(peak,active);
      try{await new Promise(resolve=>setImmediate(resolve));return await original(key);}
      finally{active--;}
    }
    return original(key);
  };
  await start(f);
  await runGameArchiveSchemaAuditTick(f.env);
  const state=await report(f);
  assert.equal(state.receiptsListed,200);
  assert.equal(state.phase,"indexing");
  assert.equal(state.families[0].inspected,0);
  assert.ok(peak>1);
  assert.ok(peak<=5);
  assert.equal(f.calls.filter(([op,key])=>op==="get"&&
    key.includes("/objects/")).length,0);
});
test("limits oversized and unindexed objects without reading sensitive buckets",async()=>{
  const f=fixture();
  f.add(0,"/game/v1/characters/BIG",{data:{big:"z".repeat(1_260_000)}});
  f.add(1,"/game/v1/events/E",{data:{id:"A"}},{
    objectKey:prefix+"raw/11111111-2222-4333-8444-555555555555.json"});
  f.add(2,"/game/v1/items/BAD",{data:{id:"B"}},{
    objectKey:"oauth-captains/v1/token.json"});
  f.add(3,"/game/v1/traits/X",{data:{id:"X"}},{
    objectKey:prefix+"objects/"+("x".repeat(64))+".json"});
  f.add(4,"/player/v1/roster?accessToken=SECRET",{data:{id:"X"}});
  await start(f);
  const state=await finish(f);
  assert.equal(state.receiptsListed,5);
  assert.equal(state.validReceipts,4);
  assert.equal(state.families.find(f=>f.family==="characters").tooLarge,1);
  assert.equal(state.families.find(f=>f.family==="events").unindexed,1);
  assert.equal(state.families.find(f=>f.family==="items").invalid,1);
  assert.ok(!JSON.stringify(state).includes("oauth-captains"));
  assert.ok(!JSON.stringify(state).includes("accessToken"));
  assert.ok(!f.calls.some(([op,k])=>op==="get"&&k===blob(0)));
  assert.ok(!f.calls.some(([op,k])=>op==="get"&&k==="oauth-captains/v1/token.json"));
});
test("admin route blocks CSRF and Cloudflare Access bypass",async()=>{
  const f=fixture();
  const noOrigin=new Request(endpoint,{method:"POST",
    headers:{"Content-Type":"application/json"},body:'{"action":"start"}'});
  assert.equal((await handleGameArchiveSchemaAudit(noOrigin,f.env)).status,403);
  assert.equal((await handleGameArchiveSchemaAudit(new Request(endpoint+"?unexpected=1"),
    f.env)).status,400);
  const bad={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const response=await handleAdmin(new Request(endpoint),bad);
  assert.equal(response.status,403);
  assert.equal(f.calls.filter(x=>x[0]==="list").length,0);
});
