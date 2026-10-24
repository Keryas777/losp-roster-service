import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {GAME_ARCHIVE_ROOT,startGameArchive,runGameArchiveTick,
  gameArchiveStatus} from "../src/game-catalog-archive.js";
import {handleGameArchiveGapAudit} from "../src/game-archive-gaps.js";
import {characterRecoveryTasks,splitFailedAbilities,
  isItemCharacterAssociation} from "../src/game-archive-recovery.js";

const now=Date.UTC(2026,9,20,9);
const origin="https://losp-roster-service.deliriousfan7.workers.dev";
function fixture(provide=()=>Response.json({data:{id:"Test"},meta:{}})){
 const store=new Map(),calls=[],lockState=new Map(),locks=new Map();
 const bucket={
   get:async key=>store.has(key)?{text:async()=>store.get(key)}:null,
   put:async(key,v)=>{
     store.set(key,typeof v==="string"?v:new TextDecoder().decode(v));
   }
 };
 const env={CAPTAIN_BUCKET:bucket,GAME_ARCHIVE_AUTO_ENABLED:"true",
   GAME_ARCHIVE_PHASE2_ENABLED:"true",GAME_ARCHIVE_RECOVERY_ENABLED:"true",
   SCOPELY_CLIENT_ID:"client",SCOPELY_CLIENT_SECRET:"secret",
   ROSTER_BATCH_LOCK:{idFromName:id=>id,get:id=>{
     if(!locks.has(id))locks.set(id,new RosterBatchLock({storage:{
       get:async key=>lockState.get(key),
       put:async(key,v)=>lockState.set(key,v),
       delete:async key=>lockState.delete(key)
     }}));
     return {fetch:req=>locks.get(id).fetch(req)};
   }}};
 const fetcher=async(url,options)=>{
   calls.push(url);
   if(url.endsWith("/oauth2/token"))
     return Response.json({access_token:"secret",token_type:"Bearer",expires_in:300});
   assert.equal(options.method,"GET");
   assert.ok(url.startsWith("https://api.marvelstrikeforce.com/game/v1/"));
   return provide(url);
 };
 function state(){
   const active=JSON.parse(store.get(GAME_ARCHIVE_ROOT+"active.json"));
   const key=GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json";
   return {key,runId:active.runId,value:JSON.parse(store.get(key))};
 }
 async function completedWithGaps(gaps){
   await startGameArchive(env,now);
   const {key,value}=state();
   value.cursor=value.tasks.length;
   value.status="completed-with-gaps";
   value.phase2={version:1,status:"done",scanned:0,discovered:0};
   value.gaps=gaps;
   store.set(key,JSON.stringify(value));
   return state().runId;
 }
 return {store,env,calls,fetcher,state,completedWithGaps};
}
const audit=async f=>(await handleGameArchiveGapAudit(
 new Request(origin+"/admin/api/game-archive-gaps"),f.env)).json();
test("character 472 recovery splits only documented detail groups",()=>{
 const source="/game/v1/characters/Hero_A?abilityKits=full&costumes=full";
 const parts=characterRecoveryTasks(source);
 assert.deepEqual(parts.map(p=>p.recoveryPart),[
   "abilities","costumes","gear","direct-cost","flat-cost"
 ]);
 assert.equal(new Set(parts.map(x=>x.path)).size,5);
 assert.ok(parts.every(p=>p.path.startsWith("/game/v1/characters/Hero_A?")));
 assert.ok(parts.every(p=>p.path.includes("abilityKits=")&&
   p.path.includes("costumes=")&&p.path.includes("gearTiers=")));
 assert.ok(parts.some(p=>p.path.includes("abilityKits=full")&&
   p.path.includes("costumes=none")));
 assert.equal(characterRecoveryTasks("/player/v1/characters/Hero_A").length,0);
 assert.equal(characterRecoveryTasks("/game/v1/characters/array/Hero_A").length,0);
 assert.equal(characterRecoveryTasks("/game/v1/characters/../admin").length,0);
 assert.equal(characterRecoveryTasks("/game/v1/characters/Hero%2F1").length,0);
 assert.equal(characterRecoveryTasks("/game/v1/characters/Hero_A").length,6);
 assert.deepEqual(splitFailedAbilities(parts[0]).map(p=>p.recoveryPart),[
   "ability-basic","ability-special","ability-ultimate","ability-passive"
 ]);
 assert.equal(splitFailedAbilities(parts[1]).length,0);
 assert.equal(isItemCharacterAssociation("/game/v1/items/Gear1/characters?charInfo=full"),true);
 assert.equal(isItemCharacterAssociation("/game/v1/items/Gear1"),false);
});
test("historical character 472 resumes in the SAME R2 run without re-fetching original",async()=>{
 const source="/game/v1/characters/HeroA?abilityKits=full&costumes=full";
 const f=fixture();
 const runId=await f.completedWithGaps([
   {path:source,status:472,reason:"provider-472-not-pageable"},
   {path:"/game/v1/items/SHARD_Y/characters?charInfo=full",status:404}
 ]);
 const first=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(first.status,"completed-with-gaps");
 assert.equal(f.state().runId,runId);
 const calls=f.calls.filter(x=>x.includes("/game/v1/"));
 assert.equal(calls.length,5);
 assert.ok(calls.every(x=>!x.endsWith(source)));
 assert.ok(calls.every(x=>x.includes("HeroA")));
 const rec=f.state().value.recovery;
 assert.equal(rec.gapCursor,2);
 assert.equal(rec.scheduled,5);
 assert.equal(rec.records[source].archived.length,5);
 assert.equal(rec.records[source].expected.length,5);
 assert.equal(f.state().value.gaps.length,2);
 const report=await audit(f);
 assert.deepEqual(report.byCategory.find(x=>
   x.value==="association-objet-personnage-indisponible"),
   {value:"association-objet-personnage-indisponible",count:1});
 const entry=report.entries.find(x=>x.path===source);
 assert.equal(entry.recoveryStatus,"all-split-parts-archived");
 assert.equal(entry.archivedParts,5);
 const count=f.calls.length;
 await runGameArchiveTick(f.env,f.fetcher,now+60_000);
 assert.equal(f.calls.length,count,"completed recovery must not run twice");
 assert.equal((await gameArchiveStatus(f.env,now)).gapCount,2);
});
test("a 472 on split abilities explores basic/special/ultimate/passive, never loops",async()=>{
 const source="/game/v1/characters/HeroB?abilityKits=full&gearTiers=full";
 const f=fixture(uri=>uri.includes("abilityKits=full")?
   new Response("too large",{status:472}):
   Response.json({data:{id:"HeroB"},meta:{}}));
 await f.completedWithGaps([{path:source,status:472}]);
 const first=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(first.status,"running");
 const after=f.state().value.recovery.records[source];
 assert.ok(after.expected.length===9);
 assert.ok(after.failed.some(x=>x.includes("abilityKits=full")));
 for(let tick=1;tick<8;tick++){
   const result=await runGameArchiveTick(f.env,f.fetcher,now+tick*60_000);
   if(result.status!=="running")break;
 }
 assert.equal(f.state().value.status,"completed-with-gaps");
 assert.equal(f.state().value.recovery.records[source].archived.length,8);
 assert.equal(f.state().value.recovery.records[source].failed.length,1);
 assert.equal(f.state().value.gaps.length,2);
 assert.ok(f.calls.filter(x=>x.includes("/game/v1/")).length<=9);
 const report=await audit(f);
 const entry=report.entries.find(x=>x.path===source);
 assert.equal(entry.recoveryStatus,"some-split-parts-archived");
});
test("already-running phase two backfills old 472 without stopping normal tasks",async()=>{
 const source="/game/v1/characters/HeroC?abilityKits=full&costumes=full";
 const f=fixture();
 await startGameArchive(f.env,now);
 const current=f.state();
 current.value.cursor=15;
 current.value.gaps=[{path:source,status:472}];
 f.store.set(current.key,JSON.stringify(current.value));
 const res=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.ok(["running","completed-with-gaps"].includes(res.status));
 assert.equal(f.state().runId,current.runId);
 assert.equal(f.state().value.recovery.gapCursor,1);
 assert.ok(f.state().value.tasks.some(t=>t.recoveryOf===source));
 assert.ok(res.processed>0&&res.processed<=12);
});
test("recovery disabled leaves legacy completed run untouched",async()=>{
 const f=fixture();delete f.env.GAME_ARCHIVE_RECOVERY_ENABLED;
 await f.completedWithGaps([{path:"/game/v1/characters/HeroD",status:472}]);
 const result=await runGameArchiveTick(f.env,f.fetcher,now);
 assert.equal(result.status,"completed-with-gaps");
 assert.equal(f.state().value.recovery,undefined);
 assert.equal(f.calls.length,0);
});
