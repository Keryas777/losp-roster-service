import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {failureRoute,characterSegment,indexedEvidence,reviewFailure}
  from "../src/game-differential-evidence.js";
import {handleGameDifferentialFailureAudit,runGameDifferentialFailureAuditTick}
  from "../src/game-differential-failure-audit.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/",PREFIX=ROOT+"recovery/pending/";
const REPORT=ROOT+"failure-audit/v1/progress.json";
const SOURCE=ROOT+"state.json";
const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=HOST+"/admin/api/game-differential-failure-audit";
const RUN="11111111-2222-4333-8444-555555555555";
const NOW=Date.parse("2026-10-31T00:00:00Z");
const sha=x=>createHash("sha256").update(x).digest("hex");
const row=(path,reason,variants=[])=>({version:1,path,reason,
  status:"pending",attempts:1,recoveredParts:variants});
function fixture(rows=[]){
  const map=new Map([[SOURCE,JSON.stringify({runId:RUN,status:"partial",
    failed:2159,checked:12086,recoveryBackfill:{cursor:2577,end:2577}})]]);
  for(let i=0;i<rows.length;i++)map.set(PREFIX+
    i.toString(16).padStart(64,"0")+".json",JSON.stringify(rows[i]));
  let holder=null;
  const bucket={
    get:async key=>map.has(key)?{size:map.get(key).length,
      text:async()=>map.get(key)}:null,
    head:async key=>map.has(key)?{size:map.get(key).length}:null,
    list:async({prefix,limit,cursor})=>{
      assert.equal(prefix,PREFIX);assert.equal(limit,4);
      const keys=[...map.keys()].filter(x=>x.startsWith(prefix)).sort();
      const from=cursor?Number(cursor):0,part=keys.slice(from,from+limit);
      return {objects:part.map(key=>({key})),
        truncated:from+limit<keys.length,
        cursor:from+limit<keys.length?String(from+limit):undefined};
    },
    put:async(key,value)=>{assert.equal(key,REPORT);map.set(key,String(value));}
  };
  const lock={idFromName:x=>x,get:()=>({fetch:async req=>{
    const args=await req.json();
    if(args.action==="acquire"){
      if(holder)return Response.json({status:"busy"});
      holder=args.holder;return Response.json({status:"acquired"});
    }
    if(args.action==="release"&&holder===args.holder){
      holder=null;return Response.json({status:"released"});
    }
    return Response.json({status:"busy"});
  }})};
  function evidence(path,{ageDays=1}={}){
    const h=sha('{"data":{"id":"sample"}}');
    const key=ROOT+"runs/"+RUN+"/objects/"+h+".json";
    const r=ROOT+"runs/"+RUN+"/checks/00000001.json";
    const checkedAt=new Date(NOW-1000).toISOString();
    const storedAt=new Date(NOW-ageDays*86400000).toISOString();
    const pointer={path,sha256:h,objectKey:key,receiptKey:r,storedAt,
      checkedAt,semanticHash:"e".repeat(64)};
    map.set(ROOT+"latest/"+sha(path)+".json",JSON.stringify(pointer));
    map.set(r,JSON.stringify({version:2,...pointer,status:"changed"}));
    map.set(key,'{"data":{"id":"sample"}}');
  }
  return {map,bucket,env:{CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:lock},evidence};
}
const variants=id=>[
  "abilityKits=full",
  "costumes=full",
  "gearTiers=full&pieceInfo=full",
  "gearTiers=full&pieceDirectCost=full",
  "gearTiers=full&pieceFlatCost=full"
].map(query=>"/game/v1/characters/"+id+"?"+
  ["abilityKits","costumes","gearTiers","pieceInfo","pieceDirectCost",
    "pieceFlatCost"].map(k=>k+"="+(new URLSearchParams(query).get(k)||"none"))
    .join("&"));

test("Route forms distinguish 404 item associations from underlying item sheets",()=>{
  assert.equal(failureRoute("/game/v1/items/RS_BLACKPANTHER_7/characters?charInfo=full")
    .type,"item-character-association");
  assert.equal(failureRoute("/game/v1/items/SHARD_THUNDERSTRIKE")
    .type,"item-detail");
  assert.equal(failureRoute("/game/v1/characters/BaronMordo?abilityKits=full")
    .type,"character-expanded");
  assert.equal(failureRoute("/game/v1/episodics/unlockEvent/E1")
    .type,"episodic");
  assert.equal(characterSegment(variants("BaronMordo")[0]),"abilities");
  assert.equal(characterSegment(variants("BaronMordo")[4]),"flat-cost");
});

test("Item association evidence proves parent only from matching R2 receipt+object",async()=>{
  const item="/game/v1/items/SHARD_HAWKEYE",f=fixture();
  assert.equal(await indexedEvidence(f.bucket,item,NOW),"not-indexed");
  f.evidence(item);
  assert.equal(await indexedEvidence(f.bucket,item,NOW),"indexed-object-present");
  const result=await reviewFailure(f.bucket,row(item+
    "/characters?charInfo=full","http-404"),NOW);
  assert.equal(result.type,"item-character-association");
  assert.equal(result.itemEvidence,"indexed-object-present");
  const pointerKey=ROOT+"latest/"+sha(item)+".json";
  const pointer=JSON.parse(f.map.get(pointerKey));
  f.map.delete(pointer.objectKey);
  assert.equal(await indexedEvidence(f.bucket,item,NOW),"missing-blob");
});

test("472 coverage uses only proven R2 variants, not merely recorded alternatives",async()=>{
  const id="BaronMordo",full="/game/v1/characters/"+id+
    "?abilityKits=full&costumes=full&gearTiers=full"+
    "&pieceInfo=full&pieceDirectCost=full&pieceFlatCost=full";
  const v=variants(id),f=fixture();
  for(let i=0;i<4;i++)f.evidence(v[i]);
  let r=await reviewFailure(f.bucket,row(full,"http-472",v),NOW);
  assert.equal(r.variants.recorded,5);
  assert.equal(r.variants.verified,4);
  assert.equal(r.variants.completeFive,false);
  assert.ok(r.variants.completeSegments.includes("direct-cost"));
  f.evidence(v[4]);
  r=await reviewFailure(f.bucket,row(full,"http-472",v),NOW);
  assert.equal(r.variants.verified,5);
  assert.equal(r.variants.completeFive,true);
  assert.ok(r.variants.completeSegments.includes("flat-cost"));
});

test("A second audit preserves completed v1 until a deliberate restart creates v2",async()=>{
  const assoc="/game/v1/items/SHARD_HAWKEYE/characters?charInfo=full";
  const full="/game/v1/characters/BaronMordo?abilityKits=full";
  const v=variants("BaronMordo"),f=fixture([
    row(assoc,"http-404"),row(full,"http-472",v)
  ]);
  f.evidence("/game/v1/items/SHARD_HAWKEYE");
  for(const path of v)f.evidence(path);
  f.map.set(REPORT,JSON.stringify({version:1,status:"snapshot-complete",
    stats:{scanned:2},finishedAt:new Date(NOW).toISOString()}));
  const first=await (await handleGameDifferentialFailureAudit(
    new Request(ENDPOINT),f.env,NOW)).json();
  assert.equal(first.version,1);
  const restart=await handleGameDifferentialFailureAudit(new Request(ENDPOINT,{
    method:"POST",headers:{Origin:HOST,"Content-Type":"application/json"},
    body:JSON.stringify({action:"restart"})}),f.env,NOW);
  assert.equal(restart.status,200);
  assert.equal((await restart.json()).version,2);
  const tick=await runGameDifferentialFailureAuditTick(f.env,NOW+5000);
  assert.equal(tick.status,"snapshot-complete");
  const end=await (await handleGameDifferentialFailureAudit(
    new Request(ENDPOINT),f.env,NOW+5000)).json();
  assert.equal(end.byRoute["item-character-association"],1);
  assert.equal(end.byRoute["character-expanded"],1);
  assert.equal(end.itemAssociations.indexedObjectPresent,1);
  assert.equal(end.largeResponses.total,1);
  assert.equal(end.largeResponses.withVerifiedVariant,1);
  assert.equal(end.largeResponses.allFiveSectionsVerified,1);
  assert.equal(end.largeResponses.unverifiedVariants,0);
});
