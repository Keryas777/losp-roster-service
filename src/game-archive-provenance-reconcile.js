// R2-only, conservative reconciliation of legacy orphan blobs with later /game/v1
// differential GET receipts. A byte-identical later GET establishes a verified
// endpoint/content association, not the historical request that first wrote it.
// Never alter legacy objects, receipts, queues, diff state or provider budgets.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT;
const ACTIVE=ROOT+"active.json";
const DIFF_LATEST=ROOT+"diff/latest/";
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const LOCK="c".repeat(64);
const PAGE=20,DAY=86400000,MAX_AGE=30*DAY;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const base=run=>ROOT+"runs/"+run+"/";
const prefix=run=>base(run)+"provenance-reconciliation/v1/";
const checkpoint=run=>prefix(run)+"progress.json";
const audit=run=>base(run)+"orphan-audit/v1-progress.json";
const evidenceKey=(run,sha)=>prefix(run)+"evidence/"+sha.slice(0,2)+".json";
const matchKey=(run,sha)=>prefix(run)+"matches/"+sha+".json";
const objectPrefix=run=>base(run)+"objects/";
const sha256=async input=>{
  const bytes=new TextEncoder().encode(input);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
    .map(v=>v.toString(16).padStart(2,"0")).join("");
};
async function read(bucket,key,max=220000){
  const item=await bucket.get(key);
  if(!item)return null;
  if(!Number.isFinite(item.size)||item.size>max)throw Error("invalid-r2-size");
  const raw=await item.text();
  if(raw.length>max)throw Error("invalid-r2-size");
  return JSON.parse(raw);
}
const write=(b,key,data)=>b.put(key,JSON.stringify(data),{
  httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
function stamp(date,now){
  const time=date instanceof Date?date.getTime():Date.parse(date);
  return Number.isFinite(time)&&time>0&&time<=now+300000?time:null;
}
const validAge=(date,now)=>{const t=stamp(date,now);return t!==null&&now-t<MAX_AGE;};
async function lease(env,holder,action){
  const binding=env.ROSTER_BATCH_LOCK;
  const response=await binding.get(binding.idFromName(LOCK)).fetch(
    new Request("https://r2-reconciliation.internal/",{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint:LOCK,holder,action})}));
  return response.ok&&(await response.json()).status===
    (action==="acquire"?"acquired":"released");
}
const publicState=s=>s?{
  version:s.version,runId:s.runId,status:s.status,phase:s.phase,
  startedAt:s.startedAt,updatedAt:s.updatedAt,finishedAt:s.finishedAt,
  sources:s.sources,objects:s.objects,
  note:"Association prouvée par octets identiques et reçu différentiel ultérieur. "+
    "Ce n'est pas une reconstitution certaine de la requête historique perdue. "+
    "Aucun reçu original n'a été créé."
}:{status:"not-started",
  note:"Démarrage manuel nécessaire. R2 uniquement, aucun appel Scopely."};
function startState(run,now){
  const iso=new Date(now).toISOString();
  return {version:1,runId:run,status:"running",phase:"sources",cursor:null,
    startedAt:iso,updatedAt:iso,finishedAt:null,
    sources:{listed:0,verified:0,rejected:0,tooOld:0},
    objects:{listed:0,withReceipt:0,orphaned:0,matched:0,
      ambiguous:0,unresolved:0,tooLarge:0,expiredOrUnknown:0}};
}
function requireBucket(env){
  const b=env?.CAPTAIN_BUCKET;
  return b?.get&&b?.put&&b?.head&&b?.list&&
    env?.ROSTER_BATCH_LOCK?.get&&env?.ROSTER_BATCH_LOCK?.idFromName?b:null;
}
export async function handleGameProvenanceReconcile(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))return respond({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return respond({error:"unsupported-query"},400);
  const b=requireBucket(env);
  if(!b)return respond({error:"storage-unavailable"},503);
  try{
    const active=await read(b,ACTIVE,4096);
    if(!UUID.test(active?.runId||""))return respond({error:"no-active-run"},404);
    const run=active.runId,previous=await read(b,checkpoint(run));
    if(request.method==="GET")return respond(publicState(previous));
    if(new URL(request.url).origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
       !/^application\/json\b/i.test(request.headers.get("Content-Type")||""))
      return respond({error:"forbidden"},403);
    const body=await request.text();
    if(body.length>80||JSON.parse(body)?.action!=="start")
      return respond({error:"invalid-action"},400);
    if(previous)return respond(publicState(previous)); // Never silently restart.
    const earlier=await read(b,audit(run));
    if(earlier?.status!=="snapshot-complete"||earlier?.runId!==run||
       !Array.isArray(earlier.references)||earlier.objects?.orphaned===undefined)
      return respond({error:"completed-orphan-audit-required"},409);
    const state=startState(run,now);
    await write(b,checkpoint(run),state);
    return respond(publicState(state));
  }catch{return respond({error:"provenance-unavailable"},503);}
}
async function list(b,path,cursor){
  const page=await b.list({prefix:path,limit:PAGE,...(cursor?{cursor}:{})});
  if(!Array.isArray(page?.objects)||
     (page.truncated&&(!page.cursor||page.cursor===cursor))||
     page.objects.some(x=>typeof x?.key!=="string"||!x.key.startsWith(path)))
    throw Error("invalid-r2-page");
  return page;
}
async function addEvidence(b,run,hash,e){
  const key=evidenceKey(run,hash),shard=await read(b,key)||{};
  if(!shard||typeof shard!=="object"||Array.isArray(shard))throw Error("invalid-shard");
  const entries=Array.isArray(shard[hash])?shard[hash]:[];
  // Idempotent after an interrupted Cron. Distinct paths stay distinct,
  // never pick one candidate by enumeration order.
  const remaining=entries.filter(x=>x.path!==e.path);
  shard[hash]=[...remaining,e].sort((a,b)=>a.path.localeCompare(b.path));
  await write(b,key,shard);
}
async function sourcesTick(b,s,now){
  const page=await list(b,DIFF_LATEST,s.cursor);
  for(const o of page.objects){
    s.sources.listed++;
    try{
      const p=await read(b,o.key,5000);
      if(!p||!PATH.test(p.path||"")||!HASH.test(p.sha256||"")||
         p.observedSha256!==p.sha256||
         o.key!==DIFF_LATEST+await sha256(p.path)+".json"||
         !/^game-archive\/v1\/diff\/runs\/[0-9a-f-]{36}\/checks\/\d{8}\.json$/i.test(p.receiptKey||""))
        {s.sources.rejected++;continue;}
      const receipt=await read(b,p.receiptKey,6000);
      if(!receipt||receipt.version!==2||
         !["changed","unchanged"].includes(receipt.status)||
         receipt.path!==p.path||receipt.sha256!==p.sha256||
         receipt.observedSha256!==p.sha256||
         receipt.objectKey!==p.objectKey||
         receipt.checkedAt!==p.checkedAt)
        {s.sources.rejected++;continue;}
      if(typeof p.objectKey!=="string"||
         !p.objectKey.endsWith("/objects/"+p.sha256+".json")||
         !(p.objectKey.startsWith(ROOT+"runs/")||
           p.objectKey.startsWith(ROOT+"diff/runs/"))||
         !await b.head(p.objectKey))
        {s.sources.rejected++;continue;}
      if(!validAge(receipt.checkedAt,now)||!validAge(receipt.storedAt,now))
        {s.sources.tooOld++;continue;}
      await addEvidence(b,s.runId,p.sha256,{
        path:p.path,receiptKey:p.receiptKey,
        checkedAt:receipt.checkedAt,storedAt:receipt.storedAt,
        confidence:"later-official-get-exact-bytes"
      });
      s.sources.verified++;
    }catch{
      // A malformed pointer is not evidence. The scan never invents a path.
      s.sources.rejected++;
    }
  }
  s.cursor=page.truncated?page.cursor:null;
  if(!page.truncated)s.phase="objects";
}
async function objectsTick(b,s,now,earlier){
  const refs=new Set(earlier.references);
  const root=objectPrefix(s.runId);
  const page=await list(b,root,s.cursor);
  const shards=new Map();
  for(const o of page.objects){
    s.objects.listed++;
    const name=o.key.slice(root.length),hash=name.slice(0,-5);
    if(!name.endsWith(".json")||!HASH.test(hash)){s.objects.unresolved++;continue;}
    if(refs.has(name)){s.objects.withReceipt++;continue;}
    s.objects.orphaned++;
    if(!Number.isFinite(o.size)||o.size>256000){
      s.objects.tooLarge++;continue;
    }
    // An old object's creation date is never replaced by the current scan.
    if(!validAge(o.uploaded,now)){s.objects.expiredOrUnknown++;continue;}
    const shardName=hash.slice(0,2);
    if(!shards.has(shardName)){
      const index=await read(b,evidenceKey(s.runId,hash));
      shards.set(shardName,index||{});
    }
    const candidates=shards.get(shardName)[hash]||[];
    const distinct=[...new Set(candidates.map(x=>x.path))];
    if(distinct.length!==1){
      if(distinct.length>1)s.objects.ambiguous++;
      else s.objects.unresolved++;
      continue;
    }
    const match=candidates.find(x=>x.path===distinct[0]);
    // A *new* metadata-only link is made; legacy receipts and blobs are untouched.
    await write(b,matchKey(s.runId,hash),{
      version:1,runId:s.runId,sha256:hash,objectKey:o.key,
      path:match.path,evidenceReceiptKey:match.receiptKey,
      checkedAt:match.checkedAt,originalUploadedAt:
        o.uploaded instanceof Date?o.uploaded.toISOString():o.uploaded,
      association:"exact-bytes-seen-at-official-endpoint",
      historicalOriginalRequest:"not-proven"
    });
    s.objects.matched++;
  }
  s.cursor=page.truncated?page.cursor:null;
  if(!page.truncated){s.phase="complete";s.status="snapshot-complete";}
}
export async function runGameProvenanceReconcileTick(env,now=Date.now()){
  const b=requireBucket(env);
  if(!b)return {status:"storage-unavailable"};
  const holder=crypto.randomUUID();
  let acquired=false;
  try{
    acquired=await lease(env,holder,"acquire");
    if(!acquired)return {status:"busy"};
    const active=await read(b,ACTIVE,4096);
    if(!UUID.test(active?.runId||""))return {status:"not-started"};
    const key=checkpoint(active.runId),s=await read(b,key);
    if(!s)return {status:"not-started"};
    if(s.runId!==active.runId||s.version!==1||s.status!=="running")
      return {status:s.status||"invalid-state"};
    if(s.phase==="sources")await sourcesTick(b,s,now);
    else if(s.phase==="objects"){
      const earlier=await read(b,audit(s.runId));
      if(earlier?.status!=="snapshot-complete"||earlier.runId!==s.runId||
         !Array.isArray(earlier.references))return {status:"audit-snapshot-unavailable"};
      await objectsTick(b,s,now,earlier);
    }else return {status:"invalid-phase"};
    s.updatedAt=new Date(now).toISOString();
    if(s.status==="snapshot-complete")s.finishedAt=s.updatedAt;
    await write(b,key,s);
    return {status:s.status,phase:s.phase,
      matched:s.objects.matched,unresolved:s.objects.unresolved};
  }catch{return {status:"provenance-tick-unavailable"};}
  finally{if(acquired)try{await lease(env,holder,"release");}catch{}}
}
