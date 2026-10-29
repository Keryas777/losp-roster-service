// Automatic, read-only /game/v1 differential synchronization.
// A completed original archive is the immutable baseline. The existing 1-min
// Cron resumes scans and checks; only changed provider JSON is saved as a new
// version. No unsupported conditional request or private player endpoint.
import {API_KEY} from "./player-card.js";
import {GAME_ROOTS,GAME_ARCHIVE_ROOT,GAME_ARCHIVE_DAILY_LIMIT,
  appToken,readGameBody} from "./game-catalog-archive.js";
import {discoverGamePhase2,phase2RootTasks} from "./game-phase2-discovery.js";
import {characterRecoveryTasks,splitFailedAbilities} from "./game-archive-recovery.js";
import {noteAwakenedMaterials} from "./awakened-material-catalog.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const STATE=ROOT+"state.json",ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const API="https://api.marvelstrikeforce.com";
const LOCK="e".repeat(64); // Shared with the existing /game collector and daily budget.
const HOUR=3600000,WEEK=7*24*HOUR,TICK=12;
const DAILY=GAME_ARCHIVE_DAILY_LIMIT; // Match current main after PR #86.
const BACKFILL_PER_TICK=8,MAX_RECOVERY_RUNS=3;
// The Scopely terms require a maximum 30-day data TTL. Re-materialize
// otherwise-identical source bytes before day 30, rather than indefinitely
// extending a pointer to an old R2 object. Actual R2 deletion requires a
// separately verified lifecycle policy.
const RENEW_AFTER=21*24*HOUR;
const PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const SHA=/^[0-9a-f]{64}$/;
const UID=/^[0-9a-f-]{36}$/;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const json=(v,status=200)=>Response.json(v,{status,headers:HEADERS});
const opts={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const date=now=>new Date(now).toISOString().slice(0,10);
const budgetKey=now=>GAME_ARCHIVE_ROOT+"budget/"+date(now)+".json";
const key=(run,i)=>ROOT+"runs/"+run+"/tasks/"+String(i).padStart(7,"0")+".json";
const receiptKey=(run,i)=>ROOT+"runs/"+run+"/checks/"+String(i).padStart(8,"0")+".json";
const failureKey=(run,i)=>ROOT+"runs/"+run+"/failures/"+
  String(i).padStart(8,"0")+"-"+crypto.randomUUID()+".json";
const seenKey=(run,shard)=>ROOT+"runs/"+run+"/seen-shards/"+shard+".json";
const latestKey=h=>ROOT+"latest/"+h+".json";
const pendingPrefix=ROOT+"recovery/pending/";
const pendingKey=h=>pendingPrefix+h+".json";
const runSource=id=>GAME_ARCHIVE_ROOT+"runs/"+id+"/receipts/";
const read=async(b,k)=>{
  const x=await b.get(k);
  return x?JSON.parse(await x.text()):null;
};
const write=(b,k,v)=>b.put(k,JSON.stringify(v),opts);
const hash=async x=>{
  const bytes=typeof x==="string"?new TextEncoder().encode(x):x;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
    .map(b=>b.toString(16).padStart(2,"0")).join("");
};
const semantic=async doc=>{
  // Do not mistake a changed meta.asOf timestamp for a game-data change.
  // All other official/unknown response fields remain comparison inputs.
  if(!doc||typeof doc!=="object"||Array.isArray(doc))return null;
  const v={...doc};
  if(v.meta&&typeof v.meta==="object"&&!Array.isArray(v.meta)){
    v.meta={...v.meta};delete v.meta.asOf;
  }
  return hash(JSON.stringify(v));
};
const valid=x=>typeof x==="string"&&PATH.test(x)&&!x.includes("#");
function visible(s,enabled=true){
  if(!s)return {status:"not-started",enabled,intervalHours:168,
    lastCheckedAt:null,lastChangedAt:null,changed:0,unchanged:0,failed:0};
  return {status:s.status,enabled,intervalHours:168,
    startedAt:s.startedAt||null,completedAt:s.completedAt||null,
    lastCheckedAt:s.lastCheckedAt||null,lastChangedAt:s.lastChangedAt||null,
    nextRunAt:s.completedAt?new Date(Date.parse(s.completedAt)+WEEK).toISOString():null,
    changed:s.changed||0,unchanged:s.unchanged||0,refreshed:s.refreshed||0,failed:s.failed||0,
    recoveryBackfill:s.recoveryBackfill?{scanned:s.recoveryBackfill.cursor,
      total:s.recoveryBackfill.end}:null,
    recoveryQueued:s.recoveryQueued||0,recoveryRecorded:s.recoveryRecorded||0,
    checked:s.checked||0,queued:s.queued||0,scanPhase:s.scanPhase||null,
    sourceRun:s.sourceRun||null,pauseUntil:s.pauseUntil||null,
    lastOutcome:s.lastOutcome||null,runId:s.runId||null,
    note:"Responses compared by SHA-256 and semantic body (excluding meta.asOf); "+
      "only changed source JSON gets a new R2 object."};
}
async function lock(env,holder,action){
  const b=env.ROSTER_BATCH_LOCK;
  const r=await b.get(b.idFromName(LOCK)).fetch(new Request(
    "https://game-diff-lock.internal/",{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,holder,fingerprint:LOCK})}));
  return r.ok&&(await r.json()).status===
    (action==="acquire"?"acquired":"released");
}
async function queue(b,s,candidates){
  // One compact seen-set per SHA nibble, not two R2 requests PER endpoint.
  // Max 16 reads + 16 writes regardless of candidate count. This keeps
  // Cloudflare subrequests bounded for hundreds of discovered IDs.
  const groups=new Map(),fresh=[];
  for(const candidate of candidates){
    if(!valid(candidate?.path))continue;
    const h=await hash(candidate.path),shard=h[0];
    if(!groups.has(shard)){
      const v=await read(b,seenKey(s.runId,shard));
      if(v!==null&&(!Array.isArray(v)||!v.every(x=>SHA.test(x))))
        throw Error("invalid-seen-shard");
      groups.set(shard,{seen:new Set(v||[]),added:false});
    }
    const group=groups.get(shard);
    if(group.seen.has(h))continue;
    group.seen.add(h);group.added=true;
    fresh.push({path:candidate.path,
      sha256:SHA.test(candidate.sha256||"")?candidate.sha256:null,
      objectKey:typeof candidate.objectKey==="string"?candidate.objectKey:null,
      storedAt:typeof candidate.storedAt==="string"?candidate.storedAt:null,
      ...(valid(candidate.recoveryOf)?{recoveryOf:candidate.recoveryOf}:{}),
      ...(typeof candidate.recoveryPart==="string"?
        {recoveryPart:candidate.recoveryPart}:{})});
  }
  // Write tasks and updated checkpoint BEFORE the seen markers. An
  // interrupted tick can repeat an endpoint, never silently omit one.
  for(let i=0;i<fresh.length;i+=80){
    const slice=fresh.slice(i,i+80);
    const index=s.writeIndex++;
    await write(b,key(s.runId,index),slice);
    s.queued+=slice.length;
    await write(b,STATE,s);
  }
  for(const [shard,group] of groups){
    if(group.added)await write(b,seenKey(s.runId,shard),[...group.seen]);
  }
}
function make(source,now){
  return {version:1,runId:crypto.randomUUID(),sourceRun:source,
    status:"scanning",scanPhase:"base",cursor:null,
    writeIndex:0,readIndex:0,readOffset:0,queued:0,checked:0,
    changed:0,unchanged:0,refreshed:0,failed:0,retries:0,pauseUntil:null,
    recoveryQueued:0,recoveryRecorded:0,
    startedAt:new Date(now).toISOString(),lastCheckedAt:null,
    lastChangedAt:null,completedAt:null,lastOutcome:null};
}
async function scan(b,s,now){
  if(s.scanPhase==="roots"){
    const roots=GAME_ROOTS.map(r=>({path:r.path+
      (r.pageable?"?page=1&perPage=100":"")}));
    const phase=phase2RootTasks().map(t=>({
      path:t.path+(t.mode==="list"?"?page=1&perPage=100":"")
    }));
    await queue(b,s,[...roots,...phase]);
    s.scanPhase="done";s.status="checking";s.cursor=null;
    s.lastOutcome="baseline-indexed";
    await write(b,STATE,s);
    return "checking";
  }
  const prefix=s.scanPhase==="base"?runSource(s.sourceRun):
    s.scanPhase==="pending"?pendingPrefix:ROOT+"latest/";
  const listed=await b.list({prefix,limit:32,...(s.cursor?{cursor:s.cursor}:{})});
  if(!Array.isArray(listed.objects)||
     listed.truncated===true&&(!listed.cursor||listed.cursor===s.cursor))
    throw Error("invalid-r2-list");
  const candidates=[];
  for(const item of listed.objects){
    if(!item.key.startsWith(prefix))throw Error("unexpected-r2-key");
    try{
      const v=await read(b,item.key);
      if(s.scanPhase==="base"){
        if(v?.status===200&&valid(v.path))
          candidates.push({path:v.path,sha256:v.sha256,objectKey:v.objectKey,
            storedAt:v.capturedAt||null});
      }else if(s.scanPhase==="pending"){
        if(v?.status==="pending"&&valid(v.path)&&
          Number.isSafeInteger(v.attempts)&&v.attempts<MAX_RECOVERY_RUNS&&
          Date.parse(v.nextAt||"")<=now&&v.lastRun!==s.runId){
          candidates.push({path:v.path,
            ...(valid(v.recoveryOf)?{recoveryOf:v.recoveryOf}:{}),
            ...(typeof v.recoveryPart==="string"?{recoveryPart:v.recoveryPart}:{})});
        }
      }else if(valid(v?.path)){
        candidates.push({path:v.path,sha256:v.sha256,objectKey:v.objectKey,
          storedAt:v.storedAt||null});
      }
    }catch{s.failed++;s.lastOutcome="unreadable-source-receipt";}
  }
  await queue(b,s,candidates);
  if(listed.truncated){s.cursor=listed.cursor;}
  else{s.scanPhase=s.scanPhase==="base"?"latest":
    s.scanPhase==="latest"?"pending":"roots";s.cursor=null;}
  await write(b,STATE,s);
  return "scanning";
}
async function priorSemantic(bucket,reference){
  if(SHA.test(reference?.semanticHash||""))return reference.semanticHash;
  const old=reference?.objectKey;
  if(typeof old!=="string"||!(old.startsWith(GAME_ARCHIVE_ROOT+"runs/")||
      old.startsWith(ROOT+"runs/")))return null;
  const obj=await bucket.get(old);
  if(!obj||Number.isFinite(obj.size)&&obj.size>8_000_000)return null;
  try{return semantic(JSON.parse(await obj.text()));}
  catch{return null;}
}
async function discover(bucket,s,path,payload){
  const candidates=[];
  const root=GAME_ROOTS.find(x=>path.split("?")[0]===x.path);
  const data=payload?.data;
  if(root?.detail&&Array.isArray(data)){
    for(const x of data){
      const id=typeof x==="string"?x:x?.id;
      if((typeof id==="string"||typeof id==="number")&&
         /^[A-Za-z0-9:_-]{1,200}$/.test(String(id)))
        candidates.push({path:root.detail.replace("{id}",encodeURIComponent(String(id)))});
    }
  }
  // A newly grown paginated root must not stop at the old last page.
  const episodicList=/^\/game\/v1\/episodics\/[^/?]+$/.test(path.split("?")[0]);
  if((root?.pageable||episodicList)&&Array.isArray(data)&&payload.meta){
    const url=new URL("https://api.example"+path);
    const page=Number(url.searchParams.get("page"));
    const per=Number(url.searchParams.get("perPage"));
    const total=payload.meta.perTotal;
    if(Number.isSafeInteger(total)&&total>=0&&
       Number.isSafeInteger(page)&&page>=1&&
       Number.isSafeInteger(per)&&per>0&&per<=100){
      const pages=Math.ceil(total/per);
      if(pages<=2500){
        for(let i=page+1;i<=pages;i++){
          const next=new URL(url);
          next.searchParams.set("page",String(i));
          candidates.push({path:next.pathname+next.search});
        }
      }else{s.failed++;s.lastOutcome="page-bound-exceeded";}
    }
  }
  // Existing conservative discovery: only official linked IDs/paths.
  try{candidates.push(...discoverGamePhase2(path,payload));}
  catch{s.failed++;s.lastOutcome="linked-discovery-failed";}
  await queue(bucket,s,candidates);
}
// Reuse the finite 472 escape hatches of the original collector. An HTTP 472
// is a data-size/refusal signal, NOT a rate limit: do not pause 15 minutes
// and retry the same oversized representation.
function alternatives(task){
  const path=task.path,base=path.split("?")[0];
  const root=GAME_ROOTS.find(x=>x.path===base);
  const result=[];
  if(task.recoveryPart==="abilities")
    result.push(...splitFailedAbilities(task));
  else result.push(...characterRecoveryTasks(path));
  if(root?.objectKeys&&root.detail)
    result.push(...root.objectKeys.map(id=>({
      path:root.detail.replace("{id}",encodeURIComponent(id)),
      recoveryOf:path,recoveryPart:"finite-detail"
    })));
  // Match the original collector's reduction/reset on pageable endpoints.
  const episodic=/^\/game\/v1\/episodics\/[^/?]+$/.test(base);
  if((root?.pageable||episodic)&&path.includes("?")){
    const url=new URL("https://api.invalid"+path);
    const per=Number(url.searchParams.get("perPage"));
    if(Number.isSafeInteger(per)&&per>1&&per<=100&&
      /^\d+$/.test(url.searchParams.get("page")||"")){
      url.searchParams.set("page","1");
      url.searchParams.set("perPage",String(Math.max(1,Math.floor(per/2))));
      result.push({path:url.pathname+url.search,
        recoveryOf:path,recoveryPart:"smaller-page"});
    }
  }
  return result.filter(x=>valid(x.path)).slice(0,16);
}
async function recordPending(b,s,task,reason,now){
  if(!valid(task.path))return;
  const h=await hash(task.path),key=pendingKey(h);
  const previous=await read(b,key);
  if(previous?.status==="resolved")return;
  const anotherRun=previous?.lastRun!==s.runId;
  const attempts=(previous?.attempts||0)+(anotherRun?1:0);
  await write(b,key,{version:1,path:task.path,status:"pending",
    reason,attempts,lastRun:s.runId,
    firstSeenAt:previous?.firstSeenAt||new Date(now).toISOString(),
    lastSeenAt:new Date(now).toISOString(),
    nextAt:new Date(now+WEEK).toISOString(),
    ...(valid(task.recoveryOf)?{recoveryOf:task.recoveryOf}:{}),
    ...(typeof task.recoveryPart==="string"?
      {recoveryPart:task.recoveryPart}:{})});
  if(!previous)s.recoveryRecorded=(s.recoveryRecorded||0)+1;
}
async function resolvePending(b,s,task,now){
  const h=await hash(task.path),k=pendingKey(h),pending=await read(b,k);
  if(pending?.status==="pending")
    await write(b,k,{...pending,status:"resolved",
      resolvedAt:new Date(now).toISOString(),resolvedRun:s.runId});
  // A successful *part* is not proof the original 472 URL succeeded.
  if(valid(task.recoveryOf)){
    const pk=pendingKey(await hash(task.recoveryOf)),parent=await read(b,pk);
    if(parent?.status==="pending"){
      const parts=new Set(parent.recoveredParts||[]);
      parts.add(task.path);
      await write(b,pk,{...parent,recoveredParts:[...parts].slice(0,16),
        lastPartialAt:new Date(now).toISOString()});
    }
  }
}
async function scheduleAlternatives(b,s,task){
  const proposed=alternatives(task);
  if(!proposed.length)return;
  const before=s.queued;
  await queue(b,s,proposed);
  s.recoveryQueued=(s.recoveryQueued||0)+(s.queued-before);
}
// A running legacy campaign already has failed checks under /checks/
// before this feature exists. Inspect their immutable receipts incrementally,
// with no additional Scopely requests, and schedule only documented fallbacks.
async function backfillFailures(b,s,now){
  if(!s.recoveryBackfill){
    s.recoveryBackfill={cursor:0,end:s.checked};
    await write(b,STATE,s);
  }
  const p=s.recoveryBackfill;
  let n=0;
  while(p.cursor<p.end&&n<BACKFILL_PER_TICK){
    const entry=await read(b,receiptKey(s.runId,p.cursor));
    if(entry?.status==="failed"&&valid(entry.path)){
      const task={path:entry.path},reason=entry.reason||"historical-failure";
      await recordPending(b,s,task,reason,now);
      if(reason==="http-472")await scheduleAlternatives(b,s,task);
    }
    p.cursor++;n++;
  }
  if(n)await write(b,STATE,s);
}

// A SHA-addressed pointer must describe the ACTUAL bytes kept in R2.
// A previous V1 pointer could contain the newest observed SHA despite still
// targeting older bytes (meta.asOf-only changes). Such pointers are refreshed.
function validObjectKey(key,storedSha){
  if(typeof key!=="string"||!SHA.test(storedSha||""))return false;
  if(!(key.startsWith(GAME_ARCHIVE_ROOT+"runs/")||
       key.startsWith(ROOT+"runs/")))return false;
  return key.endsWith("/objects/"+storedSha+".json")&&
    !key.includes("/../")&&!key.includes("//");
}
function validStamp(value,now){
  if(typeof value!=="string")return null;
  const stamp=Date.parse(value);
  return Number.isFinite(stamp)&&stamp<=now+5*60000&&stamp>=0?stamp:null;
}
async function usableReference(bucket,ref,now){
  if(!validObjectKey(ref?.objectKey,ref?.sha256))return null;
  const head=await bucket.head(ref.objectKey);
  if(!head)return null;
  // Prefer the date when these exact stored bytes were archived, not the
  // last check time. A missing date is treated as unknown, never "fresh".
  const storedAt=ref.storedAt||ref.capturedAt||
    (head.uploaded instanceof Date?head.uploaded.toISOString():
      typeof head.uploaded==="string"?head.uploaded:null);
  const time=validStamp(storedAt,now);
  if(time===null||now-time>=RENEW_AFTER)return null;
  return {sha256:ref.sha256,objectKey:ref.objectKey,storedAt};
}
function pointerFromReceipt(receipt,run,source){
  return {version:2,path:receipt.path,sha256:receipt.sha256,
    observedSha256:receipt.observedSha256||receipt.sha256,
    semanticHash:receipt.semanticHash,objectKey:receipt.objectKey,
    storedAt:receipt.storedAt,checkedAt:receipt.checkedAt,
    lastChangedAt:receipt.lastChangedAt||null,
    changed:receipt.status==="changed",refreshed:receipt.refreshed===true,
    receiptKey:receiptKey(run,source),runId:run};
}
// Finish a partially committed task WITHOUT an additional Scopely GET.
// A receipt is the recovery journal: it is durably saved before latest/.
// All side effects after it (latest, linked discovery, counters/checkpoint)
// may be safely replayed when a Worker is interrupted.
async function finishCommitted(b,s,task,receipt,now){
  if(receipt?.path!==task.path||
     !["changed","unchanged"].includes(receipt.status)||
     !SHA.test(receipt.semanticHash||"")||
     !validObjectKey(receipt.objectKey,receipt.sha256)||
     validStamp(receipt.storedAt,now)===null)
    return {error:"invalid-committed-receipt",retry:false};
  if(!await b.head(receipt.objectKey))
    return {error:"committed-object-missing",retry:false};
  const source=await b.get(receipt.objectKey);
  if(!source||Number.isFinite(source.size)&&source.size>8_000_000)
    return {error:"committed-object-unreadable",retry:false};
  let doc,rawSource;
  try{rawSource=await source.text();doc=JSON.parse(rawSource);}
  catch{return {error:"committed-object-invalid-json",retry:false};}
  if(!doc||typeof doc!=="object"||Array.isArray(doc)||!Object.hasOwn(doc,"data"))
    return {error:"committed-object-invalid-shape",retry:false};
  // Recompute/repair latest pointer only after the referenced object and
  // receipt exist. No false-complete state can be published before this.
  const pathHash=await hash(task.path);
  const pointer=pointerFromReceipt(receipt,s.runId,s.checked);
  const current=await read(b,latestKey(pathHash));
  if(!current||current.receiptKey!==pointer.receiptKey||
     current.sha256!==pointer.sha256||current.objectKey!==pointer.objectKey)
    await write(b,latestKey(pathHash),pointer);
  await discover(b,s,task.path,doc);
  // Derive icons from the same verified response; failure must never
  // block or repeat an otherwise successful official differential GET.
  if(/ability_material_/i.test(rawSource)){
    try{await noteAwakenedMaterials(b,doc,receipt,now);}
    catch{console.warn("game-awakened-catalog-update-failed");}
  }
  if(receipt.status==="changed"){
    s.changed++;s.lastChangedAt=receipt.lastChangedAt||receipt.checkedAt;
  }else s.unchanged++;
  if(receipt.refreshed===true)s.refreshed=(s.refreshed||0)+1;
  await resolvePending(b,s,task,now);
  s.checked++;s.lastCheckedAt=receipt.checkedAt;
  return {status:receipt.status,replayed:true};
}
async function checkOne(b,s,task,token,fetchImpl,now,committed=null){
  if(committed)return finishCommitted(b,s,task,committed,now);
  const h=await hash(task.path),last=await read(b,latestKey(h));
  const ref=last&&last.path===task.path?last:task;
  let response;
  try{
    response=await fetchImpl(API+task.path,{method:"GET",cache:"no-store",
      redirect:"manual",signal:AbortSignal.timeout(15000),headers:{
        "x-api-key":API_KEY,Authorization:"Bearer "+token,
        "User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"
      }});
  }catch{return {error:"network-error"};}
  if(response.status===429)return {error:"rate-limited",retry:true};
  if(response.status===472)return {error:"http-472",retry:false};
  if(!response.ok)return {error:"http-"+response.status,
    retry:![403,404,422,464,474].includes(response.status)};
  let parsed;
  try{parsed=await readGameBody(response,b,s.runId,
    ROOT+"runs/"+s.runId);}
  catch{return {error:"parse-or-r2-error",retry:true};}
  if(parsed.status==="archived-unindexed")
    return {error:"unindexed-large-json",objectKey:parsed.objectKey,retry:false};
  if(parsed.status!=="ok")return {error:parsed.status,retry:true};
  const raw=await hash(parsed.bytes);
  const sem=await semantic(parsed.data);
  const oldSem=await priorSemantic(b,ref);
  const unchanged=(oldSem&&sem===oldSem)||(!oldSem&&raw===ref.sha256);
  const capturedAt=new Date(now).toISOString();
  const usable=unchanged?await usableReference(b,ref,now):null;
  const refreshed=Boolean(unchanged&&!usable);
  let objectKey=usable?.objectKey||null;
  let storedSha=usable?.sha256||null;
  let storedAt=usable?.storedAt||null;
  if(!objectKey){
    storedSha=raw;storedAt=capturedAt;
    objectKey=ROOT+"runs/"+s.runId+"/objects/"+raw+".json";
    if(!await b.head(objectKey))
      await b.put(objectKey,parsed.bytes,opts);
    // HEAD is the storage barrier before any success receipt/pointer.
    if(!await b.head(objectKey))
      return {error:"stored-object-not-visible",retry:true};
  }
  // The receipt is a per-task write-ahead journal. Its deterministic key
  // is replayed, NEVER overwritten. A retry resumes finishCommitted.
  const receipt={version:2,path:task.path,
    status:unchanged?"unchanged":"changed",
    checkedAt:capturedAt,sha256:storedSha,observedSha256:raw,
    semanticHash:sem,objectKey,storedAt,refreshed,
    lastChangedAt:unchanged?last?.lastChangedAt||null:capturedAt,
    sourceRun:s.sourceRun,sourceReceipt:ref.receiptKey||null};
  const journal=receiptKey(s.runId,s.checked);
  if(await b.head(journal))
    return {error:"receipt-raced-before-commit",retry:true};
  await write(b,journal,receipt);
  return finishCommitted(b,s,task,receipt,now);
}
function done(s,now){
  s.status=s.failed?"partial":"completed";s.completedAt=new Date(now).toISOString();
  s.scanPhase="done";s.lastOutcome=s.status;
}
export async function gameDifferentialStatus(env){
  if(!env?.CAPTAIN_BUCKET?.get)return {status:"storage-unavailable"};
  try{return visible(await read(env.CAPTAIN_BUCKET,STATE),
    env.GAME_DIFF_ENABLED==="true");}
  catch{return {status:"unavailable"};}
}
export async function runGameDifferentialTick(env,fetchImpl=fetch,now=Date.now()){
  if(env?.GAME_DIFF_ENABLED!=="true")return {status:"disabled"};
  if(!env?.CAPTAIN_BUCKET?.get||!env.CAPTAIN_BUCKET?.put||
     !env.CAPTAIN_BUCKET?.head||!env.CAPTAIN_BUCKET?.list||
     !env.ROSTER_BATCH_LOCK?.get)return {status:"storage-unavailable"};
  const holder=crypto.randomUUID();
  let acquired=false;
  try{
    acquired=await lock(env,holder,"acquire");
    if(!acquired)return {status:"busy"};
    const b=env.CAPTAIN_BUCKET,active=await read(b,ACTIVE);
    if(!UID.test(active?.runId||""))return {status:"awaiting-initial-archive"};
    const base=await read(b,GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json");
    if(!["completed","completed-with-gaps"].includes(base?.status))
      return {status:"awaiting-initial-completion"};
    if(base.phase2&&base.phase2.status!=="done")
      return {status:"awaiting-phase2"};
    let s=await read(b,STATE);
    const interval=WEEK;
    if(!s||["completed","partial"].includes(s.status)){
      if(s?.completedAt&&s.sourceRun===active.runId&&
         now-Date.parse(s.completedAt)<interval)
        return {status:"up-to-date",nextAt:new Date(Date.parse(s.completedAt)+interval).toISOString(),
          ...visible(s,true)};
      // New weekly run. Previous differential objects and latest pointers
      // are retained unchanged, not deleted or overwritten.
      s=make(active.runId,now);await write(b,STATE,s);
    }
    if(s.sourceRun!==active.runId){
      // Another admin started a full archive between weekly checks. Keep
      // the old checkpoint for inspection and resume from the new baseline.
      await write(b,ROOT+"runs/"+s.runId+"/superseded.json",{
        ...visible(s,true),supersededAt:new Date(now).toISOString()});
      s=make(active.runId,now);await write(b,STATE,s);
    }
    if(s.pauseUntil&&Date.parse(s.pauseUntil)>now)
      return {status:"cooldown",nextAt:s.pauseUntil};
    if(s.status==="scanning"){
      await scan(b,s,now);
      return {status:s.status,queued:s.queued,scanPhase:s.scanPhase};
    }
    if(s.status!=="checking")return {status:"invalid-state"};
    // Backfill even if the old campaign's normal queue was already drained.
    // Never restart/re-scan the collection or reset its read checkpoint.
    await backfillFailures(b,s,now);
    if(s.readIndex>=s.writeIndex&&
       s.recoveryBackfill.cursor>=s.recoveryBackfill.end){
      done(s,now);await write(b,STATE,s);
      return {status:s.status,changed:s.changed,unchanged:s.unchanged,failed:s.failed};
    }
    // Shared global /game cap and Durable Object lock, no separate 1500/day throttle.
    let budget=await read(b,budgetKey(now))||{date:date(now),used:0,diffUsed:0};
    if(budget.date!==date(now)||!Number.isSafeInteger(budget.used)||
       budget.used<0||budget.used>GAME_ARCHIVE_DAILY_LIMIT)
      return {status:"invalid-budget"};
    if(budget.diffUsed!==undefined&&(!Number.isSafeInteger(budget.diffUsed)||
       budget.diffUsed<0||budget.diffUsed>DAILY))return {status:"invalid-diff-budget"};
    let token=null,calls=0,processed=0;
    // Replays do not consume a provider GET or its budget. The existing
    // journal is inspected before reserving a request.
    while(processed<TICK&&s.readIndex<s.writeIndex){
      const batch=await read(b,key(s.runId,s.readIndex));
      if(!Array.isArray(batch)||!batch.length||batch.length>80)
        return {status:"invalid-queue"};
      if(s.readOffset>=batch.length){
        s.readIndex++;s.readOffset=0;await write(b,STATE,s);continue;
      }
      const task=batch[s.readOffset];
      if(!valid(task?.path))return {status:"invalid-path"};
      const journal=await read(b,receiptKey(s.runId,s.checked));
      if(journal&&journal.path!==task.path)
        return {status:"receipt-task-mismatch"};
      if(!journal){
        if(budget.used>=GAME_ARCHIVE_DAILY_LIMIT|| (budget.diffUsed||0)>=DAILY)
          break;
        if(!token){
          token=await appToken(env,fetchImpl,now);
          if(!token){s.pauseUntil=new Date(now+HOUR).toISOString();
            s.lastOutcome="app-oauth-unavailable";await write(b,STATE,s);
            return {status:"app-oauth-unavailable"};}
        }
        budget.used++;budget.diffUsed=(budget.diffUsed||0)+1;
        calls++;await write(b,budgetKey(now),budget);
      }
      processed++;
      const result=await checkOne(b,s,task,token,fetchImpl,now,journal);
      if(result.error){
        s.lastOutcome=result.error;
        s.retries++;
        if(result.error==="rate-limited"||result.retry&&s.retries<3){
          s.pauseUntil=new Date(now+(result.error==="rate-limited"?HOUR:
            15*60000)).toISOString();
          await write(b,STATE,s);
          return {status:"cooldown",lastOutcome:result.error,calls};
        }
        s.failed++;
        await recordPending(b,s,task,result.error,now);
        if(result.error==="http-472")await scheduleAlternatives(b,s,task);
        // Failed checks are recorded separately. Never replace a successfully
        // committed journal merely because its finalization later failed.
        await write(b,failureKey(s.runId,s.checked),{
          version:2,path:task.path,status:"failed",reason:result.error,
          checkedAt:new Date(now).toISOString(),
          ...(result.objectKey?{objectKey:result.objectKey}:{})});
        s.checked++;
      }
      s.retries=0;s.pauseUntil=null;
      s.readOffset++;await write(b,STATE,s);
    }
    if(s.readIndex<s.writeIndex&&s.readOffset>=
       (await read(b,key(s.runId,s.readIndex)))?.length){
      s.readIndex++;s.readOffset=0;await write(b,STATE,s);
    }
    if(s.readIndex>=s.writeIndex&&
       s.recoveryBackfill.cursor>=s.recoveryBackfill.end){
      done(s,now);await write(b,STATE,s);}
    return {status:s.status,checked:s.checked,changed:s.changed,
      unchanged:s.unchanged,failed:s.failed,calls};
  }catch{return {status:"unavailable"};}
  finally{if(acquired)try{await lock(env,holder,"release");}catch{}}
}
