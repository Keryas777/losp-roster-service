import {test} from "node:test";
import assert from "node:assert/strict";
import {noteAwakenedMaterials,publicAwakenedMaterials}
  from "../src/awakened-material-catalog.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const NOW=Date.parse("2026-10-29T12:00:00Z");
const RUN="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const URL="https://losp-roster-service.deliriousfan7.workers.dev/api/public/awakened-materials";
const ROOT=GAME_ARCHIVE_ROOT+"runs/"+RUN+"/";
const ID="ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_ARCHANGEL_ULTIMATE";
const ICON="https://assets.marvelstrikeforce.com/imgs/ICON_ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_ARCHANGEL_ULTIMATE_548ea478.png";
const sha="f".repeat(64);
function fixture(){
  const objects=new Map(),calls={get:[],put:[]};
  const bucket={
    get:async k=>{
      calls.get.push(k);
      if(!objects.has(k))return null;
      const raw=objects.get(k);
      return {size:Buffer.byteLength(raw),text:async()=>raw};
    },
    put:async(k,raw)=>{calls.put.push(k);objects.set(k,raw);}
  };
  const env={CAPTAIN_BUCKET:bucket};
  const set=(key,obj)=>objects.set(key,JSON.stringify(obj));
  const req=()=>new Request(URL);
  const read=async(now=NOW)=>await (await publicAwakenedMaterials(req(),env,now)).json();
  return {bucket,env,objects,calls,set,read,req};
}
function audit(f,{date=new Date(NOW-3600000).toISOString(),expiry=NOW+20*86400000}={}){
  f.set(GAME_ARCHIVE_ROOT+"active.json",{runId:RUN});
  f.set(ROOT+"material-audit/v1/progress.json",{
    version:2,status:"snapshot-complete",finishedAt:date,
    expiresAt:new Date(expiry).toISOString(),
    items:{[ID]:{metadata:[{name:"Archangel's Ultimate Awakened Ability Material",
      icon:ICON,description:"Use to upgrade",
      sampleSha256:sha,sampleUploadedAt:date,fileCount:2}]}}
  });
}
test("R2 audit seeds public icons without exposing private audit or R2 metadata",async()=>{
  const f=fixture();audit(f);
  const r=await publicAwakenedMaterials(f.req(),f.env,NOW);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.count,1);
  assert.deepEqual(data.materials[0],{
    id:ID,characterId:"ARCHANGEL",abilityType:"ULTIMATE",
    name:"Archangel's Ultimate Awakened Ability Material",
    description:"Use to upgrade",iconUrl:ICON
  });
  assert.equal(r.headers.get("access-control-allow-origin"),"*");
  assert.ok(!JSON.stringify(data).includes("sampleSha256"));
  assert.ok(!JSON.stringify(data).includes("progress.json"));
  assert.equal(f.calls.put.length,0);
});
test("verified differential updates existing icons, adds future characters and is idempotent",async()=>{
  const f=fixture();audit(f);
  const nextId="ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_NEWCHARACTER_SPECIAL";
  const nextIcon="https://assets.marvelstrikeforce.com/imgs/NEWCHARACTER_SPECIAL_90a3.png";
  const receipt={status:"changed",storedAt:new Date(NOW-1000).toISOString(),sha256:sha};
  const doc={data:{rewards:{allOf:[
    {item:{id:ID,name:"Archangel UPDATED",icon:ICON}},
    {item:{id:nextId,name:"New special",icon:nextIcon}},
    {item:{id:"ABILITY_MATERIAL_ORANGE_ABILITY_MAT",icon:ICON}}
  ]}}};
  assert.deepEqual(await noteAwakenedMaterials(f.bucket,doc,receipt,NOW),
    {status:"updated",count:2});
  await noteAwakenedMaterials(f.bucket,doc,receipt,NOW);
  const data=await f.read();
  assert.equal(data.count,2);
  assert.equal(data.materials.find(m=>m.id===ID).name,"Archangel UPDATED");
  assert.equal(data.materials.find(m=>m.id===nextId).abilityType,"SPECIAL");
  assert.equal(data.materials.find(m=>m.id===nextId).characterId,"NEWCHARACTER");
  assert.ok(!JSON.stringify(data).includes("ABILITY_MATERIAL_ORANGE"));
  assert.equal(f.calls.put.length,2);
});
test("reject malicious URLs, no-icon references, and expired sources",async()=>{
  const f=fixture();
  const expired=new Date(NOW-31*86400000).toISOString();
  audit(f,{date:expired});
  const fake={data:{items:[{id:ID,name:"MALICIOUS",
    icon:"https://tracker.invalid/image.png"},{id:ID}]}};
  assert.equal((await noteAwakenedMaterials(f.bucket,fake,{
    storedAt:new Date(NOW).toISOString(),sha256:sha},NOW)).status,
    "no-awakened-materials");
  const r=await publicAwakenedMaterials(f.req(),f.env,NOW);
  assert.equal(r.status,503);
  assert.deepEqual((await r.json()).materials,[]);
  assert.equal(f.calls.put.length,0);
});
test("expiry removes historical output even with an old completed audit",async()=>{
  const f=fixture();audit(f,{expiry:NOW-1});
  assert.equal((await publicAwakenedMaterials(f.req(),f.env,NOW)).status,503);
  const first={data:{item:{id:ID,icon:ICON,name:"latest"}}};
  await noteAwakenedMaterials(f.bucket,first,{
    storedAt:new Date(NOW-29*86400000).toISOString(),sha256:sha},NOW);
  assert.equal((await f.read()).count,1);
  assert.equal((await publicAwakenedMaterials(f.req(),f.env,NOW+2*86400000)).status,503);
});
test("no mutation or private access on unsupported request",async()=>{
  const f=fixture();audit(f);
  const r=await publicAwakenedMaterials(new Request(URL,{method:"POST"}),f.env,NOW);
  assert.equal(r.status,405);
  assert.equal(f.calls.get.length,0);
  assert.equal(f.calls.put.length,0);
});
