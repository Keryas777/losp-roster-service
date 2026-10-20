// Autonomous, bounded R2-only audit of official MSF /game/v1 JSON shapes.
// Cron advances one receipt page per minute. Does not access Scopely, player
// records, collector queues or raw archives outside the active game run.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,ACTIVE=ROOT+"active.json";
const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GAME_PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const HASH=/^[a-f0-9]{64}\.json$/i;
const KEY=/^[\w:.-]{1,65}$/;
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const PAGE=200,RECEIPT_CONCURRENCY=5,MAX_BYTES=1_250_000,MAX_READS=6,PER_FAMILY=48;
const MAX_FIELDS=150,MAX_VARIANTS=20,MAX_DEPTH=7;
const json=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const auditKey=id=>ROOT+"runs/"+id+"/schema-audit/progress.json";
const progressKey=id=>ROOT+"runs/"+id+"/progress.json";
const receiptPrefix=id=>ROOT+"runs/"+id+"/receipts/";
const dataType=v=>Array.isArray(v)?"array":v===null?"null":typeof v;
async function read(bucket,key){
  const obj=await bucket.get(key);
  return obj?JSON.parse(await obj.text()):null;
}
async function save(bucket,key,obj){
  await bucket.put(key,JSON.stringify(obj),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
}
function familyOf(path){
  const p=path.slice("/game/v1/".length).split(/[/?]/);
  return p[0]==="analysis"&&p[1]==="teamOrder"?
    "analysis/teamOrder":p[0]||"unknown";
}
function receiptObject(receipt,run){
  if(receipt?.status!==200||typeof receipt.path!=="string"||
      !GAME_PATH.test(receipt.path))return null;
  const prefix=ROOT+"runs/"+run+"/";
  const key=receipt.objectKey;
  const indexed=typeof key==="string"&&key.startsWith(prefix+"objects/")&&
    HASH.test(key.slice((prefix+"objects/").length));
  const unindexed=typeof key==="string"&&key.startsWith(prefix+"raw/")&&
    /^[a-f0-9-]{36}\.json$/i.test(key.slice((prefix+"raw/").length));
  return {path:receipt.path,family:familyOf(receipt.path),
    key:indexed?key:null,storage:indexed?"indexed":unindexed?"unindexed":"invalid"};
}
function familyState(){
  return {receipts:0,indexed:0,unindexed:0,invalid:0,inspected:0,
    tooLarge:0,unreadable:0,duplicate:0,
    sampledHashes:[],fields:Object.create(null),variants:[],otherVariants:0};
}
function fieldPaths(document){
  const seen=new Map(),nodes={n:0};
  function walk(value,path,depth){
    if(nodes.n++>=2000||seen.size>=MAX_FIELDS)return;
    if(path){
      if(!seen.has(path))seen.set(path,new Set());
      seen.get(path).add(dataType(value));
    }
    if(depth>=MAX_DEPTH||value===null||typeof value!=="object")return;
    if(Array.isArray(value)){
      for(const v of value.slice(0,6))walk(v,path+"[]",depth+1);
    }else{
      for(const [k,v] of Object.entries(value).slice(0,40)){
        if(KEY.test(k))walk(v,path?path+"."+k:k,depth+1);
      }
    }
  }
  walk(document,"",0);
  return [...seen].map(([path,types])=>({path,types:[...types].sort()}));
}
function variant(document){
  const data=document?.data;
  const obj=dataType(data)==="object"?data:
    Array.isArray(data)?data.find(v=>v&&typeof v==="object"):null;
  const fields=obj&&!Array.isArray(obj)?Object.keys(obj)
    .filter(k=>KEY.test(k)).sort().slice(0,60):[];
  const kind=dataType(data);
  return {kind,fields,signature:kind+"|"+fields.join("|")};
}
export function inspectNestedGameShape(document){
  return {paths:fieldPaths(document),variant:variant(document)};
}
function recordFamilySample(group,document,path){
  const shape=inspectNestedGameShape(document);
  group.inspected++;
  for(const field of shape.paths){
    if(!group.fields[field.path]&&Object.keys(group.fields).length>=MAX_FIELDS)
      continue;
    const item=group.fields[field.path]||{count:0,types:[]};
    item.count++;
    for(const type of field.types)if(!item.types.includes(type))item.types.push(type);
    group.fields[field.path]=item;
  }
  let found=group.variants.find(v=>v.signature===shape.variant.signature);
  if(found){found.count++;return;}
  if(group.variants.length>=MAX_VARIANTS){group.otherVariants++;return;}
  group.variants.push({...shape.variant,count:1,examplePath:path});
}
function empty(run,now){
  return {version:1,runId:run,status:"running",startedAt:now,
    updatedAt:now,finishedAt:null,cursor:null,pages:0,receiptsListed:0,
    validReceipts:0,failedReceipts:0,
    families:Object.create(null),note:"Scan en cours : couverture partielle."};
}
function result(state){
  if(!state)return {status:"not-started",note:"L'audit n'a pas été lancé."};
  const families=Object.entries(state.families||{}).map(([family,group])=>{
    const {sampledHashes,...safe}=group;
    return {family,...safe};
  }).sort((a,b)=>b.receipts-a.receipts||a.family.localeCompare(b.family));
  return {status:state.status,startedAt:state.startedAt,
    updatedAt:state.updatedAt,finishedAt:state.finishedAt,
    receiptsListed:state.receiptsListed,validReceipts:state.validReceipts,
    failedReceipts:state.failedReceipts,pages:state.pages,
    families,note:state.note};
}
export async function handleGameArchiveSchemaAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))
    return json({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list||!bucket?.head)
    return json({error:"storage-unavailable"},503);
  if(new URL(request.url).search) return json({error:"unsupported-query"},400);
  try{
    const active=await read(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))return json({error:"no-active-run"},404);
    const key=auditKey(active.runId);
    if(request.method==="GET")return json(result(await read(bucket,key)));
    if(new URL(request.url).origin!==ORIGIN||
      request.headers.get("Origin")!==ORIGIN||
      !(request.headers.get("Content-Type")||"").toLowerCase()
        .startsWith("application/json"))
      return json({error:"forbidden"},403);
    const body=await request.text();
    if(body.length>80||JSON.parse(body)?.action!=="start")
      return json({error:"invalid-action"},400);
    const existing=await read(bucket,key);
    if(existing?.status==="running")return json(result(existing));
    const state=empty(active.runId,new Date(now).toISOString());
    await save(bucket,key,state);
    return json(result(state));
  }catch{return json({error:"audit-unavailable"},503);}
}
export async function runGameArchiveSchemaAuditTick(env,now=Date.now()){
  // Invoked only by the existing game cron, after collector's own tick.
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list||!bucket?.head)
    return {status:"storage-unavailable"};
  try{
    const active=await read(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))return {status:"not-started"};
    const key=auditKey(active.runId),state=await read(bucket,key);
    if(!state||state.version!==1||state.runId!==active.runId||
      state.status!=="running")return {status:state?.status||"not-started"};
    const prefix=receiptPrefix(active.runId);
    const listed=await bucket.list({prefix,limit:PAGE,
      ...(state.cursor?{cursor:state.cursor}:{})});
    // If R2 signals another page but supplies no usable cursor, fail
    // explicitly rather than re-reading page one forever.
    if(listed.truncated&&(!listed.cursor||listed.cursor===state.cursor))
      return {status:"missing-r2-cursor"};
    // R2 internal-service subrequests have their own limits. Process up to
    // 200 receipt objects with a maximum of five concurrent R2 reads, below
    // Cloudflare's six simultaneous outgoing connections. Keep the original
    // list order so restart checkpoints and all counters are deterministic.
    const receiptKeys=(listed.objects||[])
      .map(entry=>entry.key).filter(key=>
        typeof key==="string"&&key.startsWith(prefix)).slice(0,PAGE);
    const receipts=new Array(receiptKeys.length);
    let nextReceipt=0;
    await Promise.all(Array.from({
      length:Math.min(RECEIPT_CONCURRENCY,receiptKeys.length)
    },async()=>{
      while(nextReceipt<receiptKeys.length){
        const i=nextReceipt++;
        try{receipts[i]={value:await read(bucket,receiptKeys[i])};}
        catch{receipts[i]={error:true};}
      }
    }));
    const candidates=[],seenInPage=new Set();
    for(const item of receipts){
      state.receiptsListed++;
      if(item.error){state.failedReceipts++;continue;}
      const safe=receiptObject(item.value,active.runId);
      if(!safe)continue;
      state.validReceipts++;
      const group=state.families[safe.family]||familyState();
      state.families[safe.family]=group;
      group.receipts++;
      if(safe.storage==="unindexed"){group.unindexed++;continue;}
      if(safe.storage!=="indexed"){group.invalid++;continue;}
      group.indexed++;
      if(group.inspected>=PER_FAMILY)continue;
      const objectHash=safe.key.slice(safe.key.lastIndexOf("/")+1);
      const unique=safe.family+"|"+objectHash;
      if(group.sampledHashes.includes(objectHash)||seenInPage.has(unique)){
        group.duplicate++;continue;
      }
      seenInPage.add(unique);
      candidates.push({safe,group,objectHash});
    }
    // Prioritize families not yet understood, rather than spending every
    // sample on the many chronological event receipts.
    let reads=0;
    const attemptsByFamily=new Map();
    while(candidates.length&&reads<MAX_READS){
      candidates.sort((a,b)=>
        (a.group.inspected+100*(attemptsByFamily.get(a.safe.family)||0))-
        (b.group.inspected+100*(attemptsByFamily.get(b.safe.family)||0))||
        a.group.receipts-b.group.receipts);
      const {safe,group,objectHash}=candidates.shift();
      attemptsByFamily.set(safe.family,
        (attemptsByFamily.get(safe.family)||0)+1);
      group.sampledHashes.push(objectHash);
      if(group.sampledHashes.length>PER_FAMILY*3)
        group.sampledHashes.shift();
      let head;
      try{head=await bucket.head(safe.key);}catch{group.unreadable++;continue;}
      if(!head||!Number.isFinite(head.size)){group.unreadable++;continue;}
      if(head.size>MAX_BYTES){group.tooLarge++;continue;}
      reads++; // Bound JSON loads even when parsing fails.
      try{
        const document=await read(bucket,safe.key);
        if(!document||typeof document!=="object"||
          !Object.hasOwn(document,"data")){
          group.unreadable++;continue;
        }
        recordFamilySample(group,document,safe.path);
      }catch{group.unreadable++;}
    }
    state.pages++;
    state.cursor=listed.truncated?listed.cursor:null;
    state.updatedAt=new Date(now).toISOString();
    if(!listed.truncated){
      state.finishedAt=state.updatedAt;
      const collector=await read(bucket,progressKey(active.runId));
      const finalized=["completed","completed-with-gaps"].includes(collector?.status);
      state.status="snapshot-complete";
      state.note=finalized?
        "Tous les reçus listés à la fin du scan ont été parcourus. Les échantillons JSON sont limités et ne certifient pas la couverture des champs ou la résolution des lacunes.":
        "Instantané terminé pendant une collecte encore active. De nouveaux reçus peuvent avoir été ajoutés depuis le scan ; relancer l'audit après la fin de la collecte.";
    }
    await save(bucket,key,state);
    return {status:state.status,receiptsListed:state.receiptsListed,
      samples:Object.values(state.families).reduce((n,f)=>n+f.inspected,0)};
  }catch{return {status:"audit-unavailable"};}
}
