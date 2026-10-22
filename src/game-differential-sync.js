// Automatic, read-only /game/v1 differential synchronization.
// A completed original archive is the immutable baseline. The existing 1-min
// Cron resumes scans and checks; only changed provider JSON is saved as a new
// version. No unsupported conditional request or private player endpoint.
import {API_KEY} from "./player-card.js";
import {GAME_ROOTS,GAME_ARCHIVE_ROOT,GAME_ARCHIVE_DAILY_LIMIT,
  appToken,readGameBody} from "./game-catalog-archive.js";
import {discoverGamePhase2,phase2RootTasks} from "./game-phase2-discovery.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const STATE=ROOT+"state.json",ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const API="https://api.marvelstrikeforce.com";
const LOCK="e".repeat(64); // Shared with the existing /game collector and daily budget.
const HOUR=3600000,WEEK=7*24*HOUR,TICK=3,DAILY=1500;
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
const seenKey=(run,h)=>ROOT+"runs/"+run+"/seen/"+h+".json";
const latestKey=h=>ROOT+"latest/"+h+".json";
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
    changed:s.changed||0,unchanged:s.unchanged||0,failed:s.failed||0,
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
  const fresh=[],seen=new Set();
  for(const candidate of candidates){
    if(!valid(candidate?.path)||seen.has(candidate.path))continue;
    seen.add(candidate.path);
    const h=await hash(candidate.path);
    if(await b.head(seenKey(s.runId,h)))continue;
    fresh.push({path:candidate.path,
      sha256:SHA.test(candidate.sha256||"")?candidate.sha256:null,
      objectKey:typeof candidate.objectKey==="string"?candidate.objectKey:null});
  }
  // Durable queue before progress and dedup markers: crashes may create
  // harmless duplicate checks, but cannot silently lose an endpoint.
  for(let i=0;i<fresh.length;i+=80){
    const slice=fresh.slice(i,i+80);
    const index=s.writeIndex++;
    await write(b,key(s.runId,index),slice);
    s.queued+=slice.length;
    await write(b,STATE,s);
    for(const v of slice)await write(b,seenKey(s.runId,await hash(v.path)),{v:1});
  }
}
function make(source,now){
  return {version:1,runId:crypto.randomUUID(),sourceRun:source,
    status:"scanning",scanPhase:"base",cursor:null,
    writeIndex:0,readIndex:0,readOffset:0,queued:0,checked:0,
    changed:0,unchanged:0,failed:0,retries:0,pauseUntil:null,
    startedAt:new Date(now).toISOString(),lastCheckedAt:null,
    lastChangedAt:null,completedAt:null,lastOutcome:null};
}
async function scan(b,s){
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
  const prefix=s.scanPhase==="base"?runSource(s.sourceRun):ROOT+"latest/";
  const listed=await b.list({prefix,limit:50,...(s.cursor?{cursor:s.cursor}:{})});
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
          candidates.push({path:v.path,sha256:v.sha256,objectKey:v.objectKey});
      }else if(valid(v?.path)){
        candidates.push({path:v.path,sha256:v.sha256,objectKey:v.objectKey});
      }
    }catch{s.failed++;s.lastOutcome="unreadable-source-receipt";}
  }
  await queue(b,s,candidates);
  if(listed.truncated){s.cursor=listed.cursor;}
  else{s.scanPhase=s.scanPhase==="base"?"latest":"roots";s.cursor=null;}
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
async function checkOne(b,s,task,token,fetchImpl,now){
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
  let objectKey=ref.objectKey||null;
  if(!unchanged){
    objectKey=ROOT+"runs/"+s.runId+"/objects/"+raw+".json";
    if(!await b.head(objectKey))
      await b.put(objectKey,parsed.bytes,opts);
    s.changed++;s.lastChangedAt=capturedAt;
  }else s.unchanged++;
  // The latest pointer is updated only after source bytes are durably saved.
  await write(b,latestKey(h),{version:1,path:task.path,sha256:raw,
    semanticHash:sem,objectKey,checkedAt:capturedAt,
    lastChangedAt:unchanged?last?.lastChangedAt||null:capturedAt,
    changed:!unchanged,runId:s.runId});
  await write(b,receiptKey(s.runId,s.checked),{
    version:1,path:task.path,status:unchanged?"unchanged":"changed",
    checkedAt:capturedAt,sha256:raw,objectKey});
  await discover(b,s,task.path,parsed.data);
  s.checked++;s.lastCheckedAt=capturedAt;
  return {status:unchanged?"unchanged":"changed"};
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
      if(s?.completedAt&&now-Date.parse(s.completedAt)<interval)
        return {status:"up-to-date",nextAt:new Date(Date.parse(s.completedAt)+interval).toISOString(),
          ...visible(s,true)};
      // New weekly run. Previous differential objects and latest pointers
      // are retained unchanged, not deleted or overwritten.
      s=make(active.runId,now);await write(b,STATE,s);
    }
    if(s.sourceRun!==active.runId)return {status:"baseline-switched"};
    if(s.pauseUntil&&Date.parse(s.pauseUntil)>now)
      return {status:"cooldown",nextAt:s.pauseUntil};
    if(s.status==="scanning"){
      await scan(b,s);
      return {status:s.status,queued:s.queued,scanPhase:s.scanPhase};
    }
    if(s.status!=="checking")return {status:"invalid-state"};
    if(s.readIndex>=s.writeIndex){done(s,now);await write(b,STATE,s);
      return {status:s.status,changed:s.changed,unchanged:s.unchanged,failed:s.failed};}
    // Share the existing game budget + game Durable Object lock. Up to
    // three provider GET per Cron, max 1500 differential GET per UTC day.
    let budget=await read(b,budgetKey(now))||{date:date(now),used:0,diffUsed:0};
    if(budget.date!==date(now)||!Number.isSafeInteger(budget.used)||
       budget.used<0||budget.used>GAME_ARCHIVE_DAILY_LIMIT)
      return {status:"invalid-budget"};
    if(budget.diffUsed!==undefined&&(!Number.isSafeInteger(budget.diffUsed)||
       budget.diffUsed<0||budget.diffUsed>DAILY))return {status:"invalid-diff-budget"};
    const token=await appToken(env,fetchImpl,now);
    if(!token){s.pauseUntil=new Date(now+HOUR).toISOString();
      s.lastOutcome="app-oauth-unavailable";await write(b,STATE,s);
      return {status:"app-oauth-unavailable"};}
    let calls=0;
    while(calls<TICK&&s.readIndex<s.writeIndex&&budget.used<GAME_ARCHIVE_DAILY_LIMIT&&
          (budget.diffUsed||0)<DAILY){
      const batch=await read(b,key(s.runId,s.readIndex));
      if(!Array.isArray(batch)||!batch.length||batch.length>80)
        return {status:"invalid-queue"};
      if(s.readOffset>=batch.length){
        s.readIndex++;s.readOffset=0;await write(b,STATE,s);continue;
      }
      const task=batch[s.readOffset];
      if(!valid(task?.path))return {status:"invalid-path"};
      budget.used++;budget.diffUsed=(budget.diffUsed||0)+1;
      calls++;await write(b,budgetKey(now),budget);
      const result=await checkOne(b,s,task,token,fetchImpl,now);
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
        await write(b,receiptKey(s.runId,s.checked),{
          version:1,path:task.path,status:"failed",reason:result.error,
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
    if(s.readIndex>=s.writeIndex){done(s,now);await write(b,STATE,s);}
    return {status:s.status,checked:s.checked,changed:s.changed,
      unchanged:s.unchanged,failed:s.failed,calls};
  }catch{return {status:"unavailable"};}
  finally{if(acquired)try{await lock(env,holder,"release");}catch{}}
}
