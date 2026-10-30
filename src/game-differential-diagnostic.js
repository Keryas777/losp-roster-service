// Read-only, bounded diagnostic for differential /game failures in PRIVATE R2.
// Each HTTP request reads at most 40 recovery records, plus the diff checkpoint.
// No provider GET, no R2 writes, no full legacy archive scan or Cron work.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const STATE=ROOT+"state.json",PREFIX=ROOT+"recovery/pending/";
const PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const RUN=/^[0-9a-f-]{36}$/i;
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const reply=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const isPath=x=>typeof x==="string"&&PATH.test(x)&&!x.includes("#");
const reason=x=>typeof x==="string"&&/^[a-z0-9-]{1,90}$/.test(x)?
  x:"unspecified";
const safeTime=x=>typeof x==="string"&&Number.isFinite(Date.parse(x))?
  x:null;
const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const read=async(bucket,key)=>{
  const object=await bucket.get(key);
  return object?JSON.parse(await object.text()):null;
};
function kind(value){
  if(value==="http-472")return "http-472";
  if(value==="rate-limited"||value==="http-429")return "http-429";
  if(/^http-(401|403|404|422|464|474)$/.test(value))return "http-4xx";
  if(/^http-5\d\d$/.test(value))return "http-5xx";
  if(value==="network-error")return "network";
  if(value.startsWith("invalid-")||value==="unindexed-large-json"||
     value==="parse-or-r2-error"||value.startsWith("committed-"))
    return "validation-or-storage";
  return "other";
}
export function cleanFailure(entry){
  if(!isPath(entry?.path))return null;
  if(!["pending","resolved"].includes(entry.status))return null;
  const recovered=Array.isArray(entry.recoveredParts)?
    [...new Set(entry.recoveredParts.filter(isPath))].slice(0,16):[];
  return {path:entry.path,reason:reason(entry.reason),
    group:kind(reason(entry.reason)),
    status:entry.status,
    attempts:count(entry.attempts),
    exhausted:entry.status==="pending"&&
      count(entry.attempts)!==null&&entry.attempts>=3,
    recoveredVariants:recovered.length,
    recoveryOf:isPath(entry.recoveryOf)?entry.recoveryOf:null,
    lastRun:RUN.test(entry.lastRun||"")?entry.lastRun:null,
    lastSeenAt:safeTime(entry.lastSeenAt),
    resolvedAt:safeTime(entry.resolvedAt),
    nextAt:safeTime(entry.nextAt)};
}
export async function handleGameDifferentialFailureDiagnostic(request,env){
  if(request.method!=="GET")return reply({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.list)
    return reply({error:"storage-unavailable"},503);
  const url=new URL(request.url);
  const cursor=url.searchParams.get("cursor");
  // R2 cursors are opaque, URL encoded; reject unbounded user input.
  if(cursor!==null&&(cursor.length>2048||!/^[A-Za-z0-9_+\/=:-]+$/.test(cursor)))
    return reply({error:"invalid-cursor"},400);
  try{
    const state=await read(bucket,STATE);
    if(!state)return reply({status:"not-started",entries:[],nextCursor:null,
      totalInPage:0,checkpoint:null,readAt:new Date().toISOString()});
    if(!RUN.test(state.runId||""))
      return reply({error:"invalid-differential-checkpoint"},503);
    const listed=await bucket.list({prefix:PREFIX,limit:40,
      ...(cursor?{cursor}:{})});
    if(!Array.isArray(listed?.objects)||listed.objects.length>40||
       listed.truncated===true&&(!listed.cursor||listed.cursor===cursor))
      return reply({error:"invalid-r2-list"},503);
    const entries=[];
    let rejected=0;
    // Bounded serial reads (no more than 42 internal R2 operations).
    for(const object of listed.objects){
      if(!object.key.startsWith(PREFIX)||
         !/^[0-9a-f]{64}\.json$/.test(object.key.slice(PREFIX.length)))
        return reply({error:"invalid-recovery-key"},503);
      const item=await read(bucket,object.key);
      const normalized=cleanFailure(item);
      if(normalized)entries.push(normalized);
      else rejected++;
    }
    return reply({
      status:"ok",readAt:new Date().toISOString(),
      checkpoint:{
        runId:state.runId,status:state.status||"unknown",
        failed:count(state.failed),checked:count(state.checked),
        backfillScanned:count(state.recoveryBackfill?.cursor),
        backfillTotal:count(state.recoveryBackfill?.end),
        // Other failures can arise from discovery/receipts, outside pending.
        recoveryRecorded:count(state.recoveryRecorded)
      },
      entries,totalInPage:listed.objects.length,rejected,
      nextCursor:listed.truncated===true?listed.cursor:null,
      note:"Une ligne = une URL dans le registre de reprise, non une tentative. Les variantes ne prouvent pas la reconstruction complète de l'URL d'origine. Les compteurs du checkpoint ont un périmètre différent."
    });
  }catch{
    return reply({error:"diagnostic-r2-unavailable"},503);
  }
}
