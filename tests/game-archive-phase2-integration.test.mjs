import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {GAME_ARCHIVE_ROOT,startGameArchive,runGameArchiveTick,gameArchiveStatus} from "../src/game-catalog-archive.js";

const now=Date.UTC(2026,9,19,12);
function setup(reply=null){
 const store=new Map(),calls=[],locks=new Map(),lockState=new Map();
 const bucket={
   get:async key=>store.has(key)?{text:async()=>store.get(key)}:null,
   put:async(key,v)=>{store.set(key,typeof v==="string"?v:new TextDecoder().decode(v));},
   list:async({prefix,limit,cursor})=>{
     const all=[...store.keys()].filter(k=>k.startsWith(prefix)).sort();
     const start=cursor?Number(cursor):0,keys=all.slice(start,start+limit);
     return {objects:keys.map(key=>({key})),truncated:start+keys.length<all.length,
       cursor:String(start+keys.length)};
   }
 };
 const env={CAPTAIN_BUCKET:bucket,GAME_ARCHIVE_AUTO_ENABLED:"true",
   GAME_ARCHIVE_PHASE2_ENABLED:"true",SCOPELY_CLIENT_ID:"test",SCOPELY_CLIENT_SECRET:"test",
   ROSTER_BATCH_LOCK:{idFromName:id=>id,get:id=>{
     if(!locks.has(id))locks.set(id,new RosterBatchLock({
       storage:{get:async k=>lockState.get(k),
         put:async(k,v)=>lockState.set(k,v),
         delete:async k=>lockState.delete(k)}
     }));
     return {fetch:req=>locks.get(id).fetch(req)};
   }}};
 const fetcher=async(uri,options)=>{
   calls.push(uri);
   if(uri.endsWith("/oauth2/token"))
     return Response.json({access_token:"app-token",token_type:"Bearer",expires_in:300});
   assert.equal(options.method,"GET");
   assert.ok(uri.startsWith("https://api.marvelstrikeforce.com/game/v1/"));
   const mocked=reply?.(uri);
   return mocked||Response.json({data:[],meta:{perTotal:0}});
 };
 const progress=()=>{
   const active=JSON.parse(store.get(GAME_ARCHIVE_ROOT+"active.json"));
   const key=GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json";
   return {runId:active.runId,key,state:JSON.parse(store.get(key))};
 };
 return {store,env,bucket,fetcher,calls,progress};
}
test("phase 2 replays existing R2 receipts, reuses run ID, discovers only documented GETs",async()=>{
 const f=setup();
 await startGameArchive(f.env,now);
 const {runId,key,state}=f.progress();
 const base=GAME_ARCHIVE_ROOT+"runs/"+runId+"/";
 const obj=base+"objects/existing.json";
 f.store.set(obj,JSON.stringify({data:{
    rooms:[{combatId:"Combat42"}],
    rewards:{allOf:[{item:{id:"Orb7",isOrb:true}},{item:{id:"Gear12"}}]},
    type:"raid"},meta:{asOf:"2026-10-19"}
 }));
 f.store.set(base+"receipts/000001-00001-s0.json",JSON.stringify({
   version:1,path:"/game/v1/raids/Raid7",status:200,objectKey:obj
 }));
 state.status="completed";state.cursor=state.tasks.length;
 f.store.set(key,JSON.stringify(state));
 const first=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(first.status,"running");
 assert.equal(f.progress().runId,runId);
 assert.ok(f.progress().state.phase2.discovered>=9);
 assert.equal(f.calls.length,0,"R2 replay must not make outbound GETs");
 const stored=JSON.stringify([...f.store.entries()].filter(([k])=>k.includes("phase2-seen")));
 assert.ok(stored.includes("/game/v1/nodeCombats/Combat42"));
 assert.ok(stored.includes("/game/v1/orbRewards/Orb7"));
 assert.ok(stored.includes("/game/v1/items/Gear12"));
 for(let i=1;i<20;i++){
   const report=await runGameArchiveTick(f.env,f.fetcher,now+60_000*i);
   if(report.status==="completed")break;
 }
 const status=await gameArchiveStatus(f.env,now+21*60_000);
 assert.equal(status.status,"completed");
 assert.equal(status.phase2.status,"done");
 assert.equal(f.progress().runId,runId);
 const paths=f.calls.filter(c=>c.includes("/game/v1/"));
 assert.ok(paths.some(p=>p.includes("/episodics/campaign")));
 assert.ok(paths.some(p=>p.includes("/nodeCombats/Combat42")));
 assert.ok(paths.some(p=>p.includes("/orbRewards/Orb7")));
 const count=f.calls.length;
 await runGameArchiveTick(f.env,f.fetcher,now+22*60_000);
 assert.equal(f.calls.length,count,"no automatic restart after finished phase 2");
});
test("phase 2 is not entered if flag is absent, preserving previous behavior",async()=>{
 const f=setup();delete f.env.GAME_ARCHIVE_PHASE2_ENABLED;
 await startGameArchive(f.env,now);
 const {key,state}=f.progress();
 state.status="completed";state.cursor=17;
 f.store.set(key,JSON.stringify(state));
 const res=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(res.status,"completed");
 assert.equal(f.calls.length,0);
});

test("unpageable 472 and absent item-character mapping leave gaps but do not stall",async()=>{
 const f=setup(uri=>{
   if(uri.includes("/items/Gear9/characters"))return new Response("missing",{status:404});
   if(uri.includes("/nodeCombats/TooBig"))return new Response("too large",{status:472});
   return null;
 });
 await startGameArchive(f.env,now);
 const {key,state}=f.progress();
 state.tasks=[
   {path:"/game/v1/items/Gear9/characters?charInfo=full",
    root:"phase2",mode:"list",page:1,perPage:100},
   {path:"/game/v1/nodeCombats/TooBig",root:"phase2",mode:"detail"}
 ];
 state.cursor=0;f.store.set(key,JSON.stringify(state));
 const result=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(result.status,"completed-with-gaps");
 assert.equal(result.completedTasks,2);
 assert.equal(f.progress().state.gaps.length,2);
});
