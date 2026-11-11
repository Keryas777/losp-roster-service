import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {enqueueDd9Rooms} from "../src/game-differential-sync.js";

const ROOT="game-archive/v1/";
const DIFF=ROOT+"diff/";
const ID="dd_id_insanity_event_card_info_09";
const SOURCE="/game/v1/dds/"+ID;
const now=Date.UTC(2026,10,11,20);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(value)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");

function fixture({failSeenOnce=false,archivedOne=false}={}){
 const store=new Map(),locks=new Map(),lockState=new Map();
 const runId="6f7da6ac-b319-49ab-8b77-4e8f53fa26a7";
 const sourceRun="ced5b23f-504c-428b-9ca8-02171f2a21ef";
 const state={version:1,runId,sourceRun,status:"partial",scanPhase:"done",
   writeIndex:4,readIndex:4,readOffset:0,queued:120,checked:120,
   changed:4,unchanged:110,failed:6,completedAt:"2026-11-10T07:54:09.943Z"};
 const base={version:1,runId:sourceRun,status:"completed-with-gaps",
   phase2:{status:"done"}};
 const bucket={
  get:async key=>store.has(key)?{text:async()=>String(store.get(key)),
    size:String(store.get(key)).length}:null,
  put:async(key,value)=>{
   if(failSeenOnce&&key.includes("/seen-shards/")){
     failSeenOnce=false;throw Error("simulated interruption");
   }
   store.set(key,typeof value==="string"?value:new TextDecoder().decode(value));
  },
  head:async key=>store.has(key)?{key}:null
 };
 const env={GAME_DIFF_ENABLED:"true",CAPTAIN_BUCKET:bucket,
  ROSTER_BATCH_LOCK:{idFromName:id=>id,get:id=>{
    if(!locks.has(id))locks.set(id,new RosterBatchLock({storage:{
     get:async k=>lockState.get(k),put:async(k,v)=>lockState.set(k,v),
     delete:async k=>lockState.delete(k)
    }}));
    return {fetch:req=>locks.get(id).fetch(req)};
  }}};
 const putJson=(key,value)=>store.set(key,JSON.stringify(value));
 putJson(ROOT+"active.json",{version:1,runId:sourceRun});
 putJson(ROOT+"runs/"+sourceRun+"/progress.json",base);
 putJson(DIFF+"state.json",state);
 const sourceObject=DIFF+"runs/old/objects/"+"a".repeat(64)+".json";
 const sourceDoc={data:{name:"DARK DIMENSION IX",
   rays:Array.from({length:23},(_,i)=>"ROOM_"+String(i+1).padStart(2,"0"))},
   meta:{asOf:"2026-11-09"}};
 putJson(sourceObject,sourceDoc);
 return {env,bucket,store,state,sourceObject,sourceDoc,putJson};
}
async function setup(options){
 const f=fixture(options);
 const sourceHash=await hash(SOURCE);
 f.putJson(DIFF+"latest/"+sourceHash+".json",{path:SOURCE,
   sha256:"a".repeat(64),objectKey:f.sourceObject});
 let firstPath=SOURCE+"/ROOM_01?nodeReqs=full&nodeCombat=full&nodeRewards=full";
 if(options?.archivedOne){
   const h=await hash(firstPath),objectKey=DIFF+"runs/old/objects/"+"b".repeat(64)+".json";
   f.putJson(objectKey,{data:{nodeReqs:[],nodeCombat:{},nodeRewards:[]}});
   f.putJson(DIFF+"latest/"+h+".json",{path:firstPath,sha256:"b".repeat(64),objectKey});
 }
 return f;
}

test("queues the 23 official DD9 rays once and preserves the differential checkpoint",async()=>{
 const f=await setup();
 const result=await enqueueDd9Rooms(f.env,now);
 assert.equal(result.status,"queued");
 assert.equal(result.discovered,23);
 assert.equal(result.archived,0);
 assert.equal(result.queued,23);
 const state=JSON.parse(f.store.get(DIFF+"state.json"));
 assert.equal(state.status,"checking");
 assert.equal(state.readIndex,4);
 assert.equal(state.writeIndex,5);
 assert.equal(state.checked,120);
 const tasks=JSON.parse(f.store.get(DIFF+"runs/"+state.runId+"/tasks/0000004.json"));
 assert.equal(tasks.length,23);
 assert.equal(new Set(tasks.map(x=>x.path)).size,23);
 assert.ok(tasks.every(x=>x.path.startsWith(SOURCE+"/ROOM_")&&
   x.path.endsWith("?nodeReqs=full&nodeCombat=full&nodeRewards=full")));
 const again=await enqueueDd9Rooms(f.env,now+1000);
 assert.equal(again.status,"already-queued");
 assert.equal(again.queued,23);
 assert.equal(JSON.parse(f.store.get(DIFF+"state.json")).writeIndex,5);
});

test("skips a complete R2 response and queues only the remaining official rays",async()=>{
 const f=await setup({archivedOne:true});
 const result=await enqueueDd9Rooms(f.env,now);
 assert.equal(result.status,"queued");
 assert.equal(result.archived,1);
 assert.equal(result.queued,22);
 const state=JSON.parse(f.store.get(DIFF+"state.json"));
 const tasks=JSON.parse(f.store.get(DIFF+"runs/"+state.runId+"/tasks/0000004.json"));
 assert.equal(tasks.length,22);
 assert.ok(tasks.every(x=>!x.path.includes("/ROOM_01?")));
});

test("recovers an interrupted enqueue without writing a second task batch",async()=>{
 const f=await setup({failSeenOnce:true});
 const interrupted=await enqueueDd9Rooms(f.env,now);
 assert.equal(interrupted.status,"unavailable");
 assert.equal(JSON.parse(f.store.get(DIFF+"state.json")).writeIndex,5);
 const resumed=await enqueueDd9Rooms(f.env,now+1000);
 assert.equal(resumed.status,"queued");
 assert.equal(resumed.queued,23);
 assert.equal(JSON.parse(f.store.get(DIFF+"state.json")).writeIndex,5);
});
