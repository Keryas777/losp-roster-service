// Manual, durable, read-only sampling of /game differential R2 comparisons.
// After an explicit admin start, the existing Cron inspects at most 3 pairs
// per tick. No Scopely GET, no archive mutations and no new Cron.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
import {gameSemanticHash} from "./game-differential-sync.js";

const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const SOURCE=ROOT+"state.json",PREFIX=ROOT+"latest/";
const CHECKPOINT=ROOT+"comparison-audit/v1/progress.json";
const LOCK="9".repeat(64);
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const HEADERS={"Cache-Control":"private, no-store",
  "X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff"};
const SHA=/^[0-9a-f]{64}$/,RUN=/^[0-9a-f-]{36}$/i;
const PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const RECEIPT=/^game-archive\/v1\/(?:diff\/runs\/[0-9a-f-]{36}\/checks\/[0-9]{8}|runs\/[0-9a-f-]{36}\/receipts\/[A-Za-z0-9_-]+)\.json$/i;
const OBJECT=/^game-archive\/v1\/(?:diff\/)?runs\/[0-9a-f-]{36}\/objects\/([0-9a-f]{64})\.json$/i;
const PAGE=12,PER_TICK=3,TARGET=24,MAX_SCANNED=600;
const MAX_META=64_000,MAX_JSON=512_000;
const opts={httpMetadata:{contentType:"application/json",
  cacheControl:"private, no-store"}};
const reply=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const stamp=now=>new Date(now).toISOString();
const eligiblePath=x=>typeof x==="string"&&PATH.test(x)&&!x.includes("#");
const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const sourceView=s=>({runId:RUN.test(s?.runId||"")?s.runId:null,
  status:typeof s?.status==="string"?s.status:null,
  checked:count(s?.checked),changed:count(s?.changed),
  unchanged:count(s?.unchanged),failed:count(s?.failed)});
const family=path=>/^\/game\/v1\/characters\//.test(path)?"characters":
  /^\/game\/v1\/items\//.test(path)?"items":
  /\?page=\d+/.test(path)?"lists":"other";
const hash=async value=>{
  const bytes=typeof value==="string"?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
    .map(x=>x.toString(16).padStart(2,"0")).join("");
};
async function read(b,key,max=MAX_META){
  const file=await b.get(key);
  if(!file)return null;
  if(Number.isFinite(file.size)&&file.size>max)
    throw Error("r2-record-too-large");
  const content=await file.text();
  if(new TextEncoder().encode(content).byteLength>max)
    throw Error("r2-record-too-large");
  return JSON.parse(content);
}
const write=(b,s)=>b.put(CHECKPOINT,JSON.stringify(s),opts);
async function lease(env,holder,action){
  const binding=env.ROSTER_BATCH_LOCK;
  const response=await binding.get(binding.idFromName(LOCK)).fetch(
    new Request("https://diff-compare-audit.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint:LOCK,holder,action})
    }));
  return response.ok&&(await response.json()).status===
    (action==="acquire"?"acquired":"released");
}
async function object(b,ref){
  const match=typeof ref?.objectKey==="string"?
    OBJECT.exec(ref.objectKey):null;
  if(!match||!SHA.test(ref?.sha256||"")||match[1]!==ref.sha256)
    return {error:"invalid-storage-reference"};
  const file=await b.get(ref.objectKey);
  if(!file)return {error:"object-missing"};
  if(Number.isFinite(file.size)&&file.size>MAX_JSON)
    return {error:"object-too-large-for-sample"};
  const content=await file.text();
  const bytes=new TextEncoder().encode(content);
  if(bytes.byteLength>MAX_JSON)return {error:"object-too-large-for-sample"};
  const digest=await hash(bytes);
  if(digest!==ref.sha256)return {error:"stored-sha-mismatch"};
  let body;
  try{body=JSON.parse(content);}
  catch{return {error:"invalid-json"};}
  if(!body||typeof body!=="object"||Array.isArray(body)||
     !Object.hasOwn(body,"data"))return {error:"invalid-envelope"};
  return {body,digest,semantic:await gameSemanticHash(body)};
}
function changedFields(before,after){
  const found=[],max=12;
  let examined=0;
  function inspect(a,b,path,depth){
    if(found.length>=max||examined++>=120)return;
    if(Object.is(a,b))return;
    const aa=a&&typeof a==="object",bb=b&&typeof b==="object";
    if(!aa||!bb||Array.isArray(a)!==Array.isArray(b)||
       depth>=3){if(JSON.stringify(a)!==JSON.stringify(b))
         found.push(path||"(racine)");return;}
    if(Array.isArray(a)){
      if(a.length!==b.length)found.push((path||"data")+".length");
      for(let i=0;i<Math.min(a.length,b.length,4);i++)
        inspect(a[i],b[i],(path||"data")+"["+i+"]",depth+1);
      if(a.length>4&&b.length>4&&
         JSON.stringify(a.slice(4))!==JSON.stringify(b.slice(4))&&
         found.length<max)found.push((path||"data")+"[4+]");
      return;
    }
    const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];
    for(const k of keys.slice(0,40)){
      if(path==="meta"&&k==="asOf")continue;
      const next=path?path+"."+k:k;
      if(!Object.hasOwn(a,k)||!Object.hasOwn(b,k))found.push(next);
      else inspect(a[k],b[k],next,depth+1);
      if(found.length>=max)break;
    }
    if(keys.length>40&&found.length<max)found.push((path||"root")+".…");
  }
  inspect(before,after,"",0);
  return [...new Set(found)].slice(0,max);
}
function result(path,group,kind,extra={}){
  return {path,group,classification:kind,...extra};
}
async function evaluate(b,pointer,key){
  const path=pointer?.path;
  const group=family(path);
  const refKey=pointer?.receiptKey;
  if(!RECEIPT.test(refKey||""))
    return result(path,group,"no-current-receipt");
  const receipt=await read(b,refKey);
  if(!receipt||receipt.path!==path||
     !["changed","unchanged"].includes(receipt.status)||
     receipt.sha256!==pointer.sha256||
     receipt.objectKey!==pointer.objectKey)
    return result(path,group,"current-receipt-inconsistent");
  const oldKey=receipt.sourceReceipt;
  if(!RECEIPT.test(oldKey||""))
    return result(path,group,"no-linked-previous-version",{
      recordedStatus:receipt.status});
  if(oldKey===refKey)return result(path,group,"invalid-self-link");
  const previous=await read(b,oldKey);
  if(!previous)return result(path,group,"previous-receipt-missing");
  if(previous.path!==path||!SHA.test(previous.sha256||""))
    return result(path,group,"previous-receipt-inconsistent");
  const current=await object(b,receipt);
  if(current.error)return result(path,group,"current-"+current.error);
  const old=await object(b,previous);
  if(old.error)return result(path,group,"previous-"+old.error);
  const changed=changedFields(old.body,current.body);
  const exactSame=current.digest===old.digest;
  const semanticSame=current.semantic===old.semantic;
  const recorded=receipt.status;
  const base={recordedStatus:recorded,exactSame,semanticSame,
    changedFields:changed,
    priorReceiptMatches:old.semantic===previous.semanticHash||
      !SHA.test(previous.semanticHash||""),
    currentReceiptMatches:current.semantic===receipt.semanticHash};
  if(!base.currentReceiptMatches||!base.priorReceiptMatches)
    return result(path,group,"semantic-receipt-mismatch",base);
  if(semanticSame&&recorded==="changed")
    return result(path,group,"false-change",base);
  if(!semanticSame&&recorded==="unchanged")
    return result(path,group,"missed-change",base);
  if(exactSame||semanticSame)
    return result(path,group,exactSame?"byte-identical":"only-asof-or-order",base);
  const dataSame=JSON.stringify(old.body.data)===JSON.stringify(current.body.data);
  return result(path,group,dataSame?"metadata-other-change":"data-change",base);
}
function initial(source,now){
  return {version:1,status:"running",startedAt:stamp(now),
    updatedAt:stamp(now),finishedAt:null,cursor:null,end:false,keys:[],
    scanned:0,sampled:0,skipped:0,sourceAtStart:sourceView(source),
    sourceAtEnd:null,sourceChanged:false,groups:{},byClass:{},rows:[],
    limit:TARGET,reason:null};
}
function visible(s){
  if(!s)return {status:"not-started",
    note:"Diagnostic manuel : aucune requête Scopely."};
  const {cursor,keys,...report}=s;
  return {...report,note:s.status==="running"?
    "Lecture progressive R2 en cours par le Cron existant, indépendante du navigateur.":
    "Échantillon exploratoire non représentatif de tout /game. Aucune donnée brute copiée."};
}
function complete(s,now,reason){
  s.status="snapshot-complete";s.finishedAt=stamp(now);s.reason=reason;
}
export async function handleGameDifferentialComparisonAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))
    return reply({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return reply({error:"unsupported-query"},400);
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.put||!b?.list)return reply({error:"storage-unavailable"},503);
  try{
    const existing=await read(b,CHECKPOINT);
    if(request.method==="GET")return reply(visible(existing));
    if(!env?.ROSTER_BATCH_LOCK?.get||!env.ROSTER_BATCH_LOCK.idFromName)
      return reply({error:"lock-unavailable"},503);
    const url=new URL(request.url);
    if(url.origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
       !/^application\/json\b/i.test(request.headers.get("Content-Type")||""))
      return reply({error:"forbidden"},403);
    const raw=await request.text();
    if(raw.length>80)return reply({error:"invalid-action"},400);
    let action;
    try{action=JSON.parse(raw)?.action;}
    catch{return reply({error:"invalid-action"},400);}
    if(!["start","restart"].includes(action))return reply({error:"invalid-action"},400);
    if(action==="start"&&existing)return reply(visible(existing));
    if(action==="restart"&&existing?.status==="running")
      return reply({error:"audit-running"},409);
    const holder=crypto.randomUUID();
    if(!await lease(env,holder,"acquire"))return reply({error:"audit-busy"},409);
    try{
      const state=await read(b,CHECKPOINT);
      if(action==="start"&&state)return reply(visible(state));
      if(action==="restart"&&state?.status==="running")
        return reply({error:"audit-running"},409);
      const source=await read(b,SOURCE);
      if(!RUN.test(source?.runId||""))
        return reply({error:"no-differential-source"},409);
      const audit=initial(source,now);await write(b,audit);
      return reply(visible(audit));
    }finally{await lease(env,holder,"release");}
  }catch{return reply({error:"comparison-audit-unavailable"},503);}
}
export async function runGameDifferentialComparisonAuditTick(env,now=Date.now()){
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.put||!b?.list||
     !env?.ROSTER_BATCH_LOCK?.get||!env.ROSTER_BATCH_LOCK.idFromName)
    return {status:"storage-unavailable"};
  try{
    const current=await read(b,CHECKPOINT);
    if(!current)return {status:"not-started"};
    if(current.version!==1)return {status:"invalid-state"};
    if(current.status!=="running")return {status:current.status};
    const holder=crypto.randomUUID();
    if(!await lease(env,holder,"acquire"))return {status:"busy"};
    try{
      const s=await read(b,CHECKPOINT);
      if(s?.status!=="running"||s.version!==1)
        return {status:s?.status||"not-started"};
      let processed=0;
      while(processed<PER_TICK&&s.sampled<TARGET&&s.scanned<MAX_SCANNED){
        if(!s.keys.length&&!s.end){
          const page=await b.list({prefix:PREFIX,limit:PAGE,
            ...(s.cursor?{cursor:s.cursor}:{})});
          if(!Array.isArray(page?.objects)||page.objects.length>PAGE||
             page.truncated===true&&(!page.cursor||page.cursor===s.cursor)||
             page.objects.some(x=>typeof x?.key!=="string"||
               !/^game-archive\/v1\/diff\/latest\/[0-9a-f]{64}\.json$/.test(x.key)))
            return {status:"invalid-r2-page"};
          s.keys=page.objects.map(x=>x.key);
          s.cursor=page.truncated?page.cursor:null;
          s.end=!page.truncated;
        }
        if(!s.keys.length)break;
        const key=s.keys.shift();processed++;s.scanned++;
        const pointer=await read(b,key);
        if(!eligiblePath(pointer?.path)||!RUN.test(pointer?.runId||"")||
           await hash(pointer.path)!==key.slice(PREFIX.length,-5)){
          s.skipped++;continue;
        }
        const group=family(pointer.path);
        if((s.groups[group]||0)>=8){s.skipped++;continue;}
        const row=await evaluate(b,pointer,key);
        s.rows.push(row);s.groups[group]=(s.groups[group]||0)+1;
        s.byClass[row.classification]=(s.byClass[row.classification]||0)+1;
        s.sampled++;
      }
      if(s.sampled>=TARGET||s.scanned>=MAX_SCANNED||
         s.end&&!s.keys.length){
        complete(s,now,s.sampled>=TARGET?"target-reached":
          s.scanned>=MAX_SCANNED?"scan-limit":"no-more-pointers");
        s.sourceAtEnd=sourceView(await read(b,SOURCE));
        s.sourceChanged=JSON.stringify(s.sourceAtStart)!==
          JSON.stringify(s.sourceAtEnd);
      }
      s.updatedAt=stamp(now);await write(b,s);
      return {status:s.status,scanned:s.scanned,sampled:s.sampled};
    }finally{await lease(env,holder,"release");}
  }catch{return {status:"unavailable"};}
}
