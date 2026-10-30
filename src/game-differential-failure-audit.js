// Durable, manually started R2-only diagnostic of /game differential failures.
// Existing 1-minute Cron advances a small page. Refreshing/closing /admin
// never cancels the audit. Only this audit checkpoint is written.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
import {cleanFailure} from "./game-differential-diagnostic.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const SOURCE=ROOT+"state.json",PREFIX=ROOT+"recovery/pending/";
const CHECKPOINT=ROOT+"failure-audit/v1/progress.json";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const LOCK="8".repeat(64); // Separate DO from all provider and audit locks.
const PAGE=16,MAX_RECORD_BYTES=32_000,MAX_STATE_BYTES=64_000;
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const answer=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const stamp=now=>new Date(now).toISOString();
const positive=x=>Number.isSafeInteger(x)&&x>=0?x:null;
async function read(bucket,key,max=MAX_STATE_BYTES){
  const file=await bucket.get(key);
  if(!file)return null;
  if(Number.isFinite(file.size)&&file.size>max)throw Error("oversized-r2-record");
  const body=await file.text();
  if(body.length>max)throw Error("oversized-r2-record");
  return JSON.parse(body);
}
const write=(b,s)=>b.put(CHECKPOINT,JSON.stringify(s),{
  httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
async function lease(env,holder,action){
  const binding=env.ROSTER_BATCH_LOCK;
  const response=await binding.get(binding.idFromName(LOCK)).fetch(
    new Request("https://diff-failure-audit.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint:LOCK,holder,action})}));
  return response.ok&&(await response.json()).status===
    (action==="acquire"?"acquired":"released");
}
function sourceView(s){
  return {runId:typeof s?.runId==="string"?s.runId:null,
    status:typeof s?.status==="string"?s.status:null,
    failed:positive(s?.failed),checked:positive(s?.checked),
    backfillScanned:positive(s?.recoveryBackfill?.cursor),
    backfillTotal:positive(s?.recoveryBackfill?.end)};
}
function initial(source,now){
  return {version:1,status:"running",cursor:null,
    startedAt:stamp(now),updatedAt:stamp(now),finishedAt:null,
    sourceAtStart:sourceView(source),sourceAtEnd:null,sourceChanged:false,
    stats:{scanned:0,valid:0,rejected:0,pending:0,exhausted:0,
      resolved:0,variants:0,pages:0},byGroup:{},byReason:{}};
}
function publicReport(report){
  if(!report)return {status:"not-started",
    note:"Démarrage manuel ; le Cron existant poursuit ensuite le diagnostic."};
  const {cursor,...view}=report;
  return {...view,note:report.status==="running"?
    "Lecture R2 en cours, indépendante du navigateur. Les comptes sont provisoires.":
    "Registre R2 parcouru. Une entrée représente une URL, pas un événement d'échec."};
}
function record(s,item){
  s.stats.scanned++;
  const row=cleanFailure(item);
  if(!row){s.stats.rejected++;return;}
  s.stats.valid++;
  if(row.status==="pending")s.stats.pending++;
  else s.stats.resolved++;
  if(row.exhausted)s.stats.exhausted++;
  if(row.recoveredVariants>0)s.stats.variants++;
  s.byGroup[row.group]=(s.byGroup[row.group]||0)+1;
  s.byReason[row.reason]=(s.byReason[row.reason]||0)+1;
}
export async function handleGameDifferentialFailureAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))return answer({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return answer({error:"unsupported-query"},400);
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.put||!b?.list)return answer({error:"storage-unavailable"},503);
  try{
    const existing=await read(b,CHECKPOINT);
    if(request.method==="GET")return answer(publicReport(existing));
    if(!env?.ROSTER_BATCH_LOCK?.get||!env.ROSTER_BATCH_LOCK.idFromName)
      return answer({error:"lock-unavailable"},503);
    const url=new URL(request.url);
    if(url.origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
       !/^application\/json\b/i.test(request.headers.get("Content-Type")||""))
      return answer({error:"forbidden"},403);
    const raw=await request.text();
    if(raw.length>80)return answer({error:"invalid-action"},400);
    let action;
    try{action=JSON.parse(raw)?.action;}catch{return answer({error:"invalid-action"},400);}
    if(!["start","restart"].includes(action))return answer({error:"invalid-action"},400);
    if(action==="start"&&existing)return answer(publicReport(existing));
    if(action==="restart"&&existing?.status==="running")
      return answer({error:"audit-running"},409);
    const holder=crypto.randomUUID();
    if(!await lease(env,holder,"acquire"))return answer({error:"audit-busy"},409);
    try{
      const previous=await read(b,CHECKPOINT);
      if(action==="start"&&previous)return answer(publicReport(previous));
      if(action==="restart"&&previous?.status==="running")
        return answer({error:"audit-running"},409);
      const source=await read(b,SOURCE);
      if(!source||typeof source.runId!=="string")
        return answer({error:"no-differential-source"},409);
      const report=initial(source,now);
      await write(b,report);
      return answer(publicReport(report));
    }finally{await lease(env,holder,"release");}
  }catch{return answer({error:"failure-audit-unavailable"},503);}
}
export async function runGameDifferentialFailureAuditTick(env,now=Date.now()){
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.put||!b?.list||
     !env?.ROSTER_BATCH_LOCK?.get||!env.ROSTER_BATCH_LOCK.idFromName)
    return {status:"storage-unavailable"};
  try{
    const state=await read(b,CHECKPOINT);
    if(!state)return {status:"not-started"};
    if(state.version!==1)return {status:"invalid-state"};
    if(state.status!=="running")return {status:state.status};
    const holder=crypto.randomUUID();
    if(!await lease(env,holder,"acquire"))return {status:"busy"};
    try{
      const s=await read(b,CHECKPOINT);
      if(s?.status!=="running"||s?.version!==1)return {status:s?.status||"not-started"};
      const list=await b.list({prefix:PREFIX,limit:PAGE,
        ...(s.cursor?{cursor:s.cursor}:{})});
      if(!Array.isArray(list?.objects)||list.objects.length>PAGE||
         list.truncated===true&&(!list.cursor||list.cursor===s.cursor)||
         list.objects.some(x=>typeof x?.key!=="string"||
           !new RegExp("^"+PREFIX.replace(/[.*+?^$()|[\]{}]/g,"\\$&")+
             "[0-9a-f]{64}\\.json$").test(x.key)))
        return {status:"invalid-r2-page"};
      // Persist the cursor only after every record and aggregate was read.
      for(const entry of list.objects){
        const item=await read(b,entry.key,MAX_RECORD_BYTES);
        record(s,item);
      }
      s.cursor=list.truncated?list.cursor:null;
      s.stats.pages++;
      s.updatedAt=stamp(now);
      if(!list.truncated){
        const latest=sourceView(await read(b,SOURCE));
        s.sourceAtEnd=latest;
        s.sourceChanged=JSON.stringify(latest)!==JSON.stringify(s.sourceAtStart);
        s.status="snapshot-complete";
        s.finishedAt=stamp(now);
      }
      await write(b,s);
      return {status:s.status,scanned:s.stats.scanned,valid:s.stats.valid};
    }finally{await lease(env,holder,"release");}
  }catch{return {status:"unavailable"};}
}
