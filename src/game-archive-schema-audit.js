// Private two-pass, resumable R2-only audit of official /game/v1 schemas.
// Pass 1 indexes all receipts and discovers bounded route-shaped candidates.
// Pass 2 samples every available family/route fairly, irrespective of R2 order.
// NEVER calls Scopely, scans players, modifies receipts or resets the collector.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,ACTIVE=ROOT+"active.json";
const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GAME_PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const HASH=/^[a-f0-9]{64}\.json$/i;
const KEY=/^[A-Za-z0-9_.:-]{1,90}$/;
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const PAGE=200,CONCURRENCY=5,MAX_BYTES=1_250_000;
const SAMPLES_PER_TICK=6,ATTEMPTS_PER_TICK=12;
const MAX_FAMILIES=60,MAX_ROUTES=16,CANDIDATES_PER_ROUTE=8;
const MAX_FAMILY_SAMPLES=48,MAX_FIELDS=240,MAX_VARIANTS=20,MAX_DEPTH=7;
const json=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const auditKey=run=>ROOT+"runs/"+run+"/schema-audit/v2-progress.json";
const progressKey=run=>ROOT+"runs/"+run+"/progress.json";
const receiptPrefix=run=>ROOT+"runs/"+run+"/receipts/";
const typeOf=v=>Array.isArray(v)?"array":v===null?"null":typeof v;
async function read(bucket,key){
  const object=await bucket.get(key);
  return object?JSON.parse(await object.text()):null;
}
async function save(bucket,key,value){
  await bucket.put(key,JSON.stringify(value),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
}
function familyOf(path){
  const parts=path.slice("/game/v1/".length).split(/[/?]/);
  return parts[0]==="analysis"&&parts[1]==="teamOrder"?
    "analysis/teamOrder":parts[0]||"unknown";
}
// Route patterns describe the endpoint SHAPE, never the individual resource ID.
// Episodics has a typed two-segment list and a three-segment detail.
// Non-episodic families use /{id} details and optional nested subresources.
export function classifyGameRoute(path){
  if(typeof path!=="string"||!GAME_PATH.test(path))return null;
  const segments=path.slice("/game/v1/".length).split("?")[0].split("/");
  const family=familyOf(path);
  if(family==="analysis/teamOrder")
    return {family,route:"analysis/teamOrder",kind:"collection"};
  if(segments.length===1)return {family,route:family,kind:"collection"};
  if(family==="episodics"){
    const subtype=KEY.test(segments[1])?segments[1]:"{type}";
    if(segments.length===2)
      return {family,route:family+"/"+subtype,kind:"collection"};
    return {family,route:family+"/"+subtype+"/{id}"+
      (segments.length>3?"/{nested}":""),kind:segments.length>3?"nested":"detail"};
  }
  if(segments.length===2)
    return {family,route:family+"/{id}",kind:"detail"};
  const tail=segments.slice(2,5).map((value,index)=>
    index===0&&["characters","abilities","nodes","tiers"].includes(value)?
      value:"{id}").join("/");
  return {family,route:family+"/{id}/"+tail+
    (segments.length>5?"/{nested}":""),kind:"nested"};
}
function validReceipt(receipt,run){
  if(receipt?.status!==200)return null;
  const classified=classifyGameRoute(receipt.path);
  if(!classified)return null;
  const p=ROOT+"runs/"+run+"/";
  const key=receipt.objectKey;
  const indexed=typeof key==="string"&&key.startsWith(p+"objects/")&&
    HASH.test(key.slice((p+"objects/").length));
  const unindexed=typeof key==="string"&&key.startsWith(p+"raw/")&&
    /^[a-f0-9-]{36}\.json$/i.test(key.slice((p+"raw/").length));
  return {...classified,path:receipt.path,key:indexed?key:null,
    storage:indexed?"indexed":unindexed?"unindexed":"invalid"};
}
function fieldsIn(document){
  const seen=new Map();
  let nodes=0;
  function walk(value,path,depth){
    if(nodes++>=2500||seen.size>=MAX_FIELDS)return;
    if(path){
      let types=seen.get(path);
      if(!types){types=new Set();seen.set(path,types);}
      types.add(typeOf(value));
    }
    if(depth>=MAX_DEPTH||value===null||typeof value!=="object")return;
    if(Array.isArray(value)){
      for(const element of value.slice(0,6))walk(element,path+"[]",depth+1);
    }else{
      for(const [key,element] of Object.entries(value).slice(0,40)){
        if(!KEY.test(key))continue;
        // Level-indexed objects have dynamic numeric keys: normalize them
        // so ISO-8 levels do not consume 20*5 field slots.
        const normalized=/^\d+$/.test(key)?"{n}":key;
        walk(element,path?path+"."+normalized:normalized,depth+1);
      }
    }
  }
  // Observe data before shared metadata. No source values are persisted.
  walk(document.data,"data",1);
  if(Object.hasOwn(document,"meta"))walk(document.meta,"meta",1);
  return [...seen].map(([path,types])=>({path,types:[...types].sort()}));
}
function shapeOf(document){
  const data=document.data;
  const sample=Array.isArray(data)?
    data.find(x=>x&&typeof x==="object"&&!Array.isArray(x)):data;
  const fields=sample&&typeof sample==="object"&&!Array.isArray(sample)?
    Object.keys(sample).filter(k=>KEY.test(k)).sort().slice(0,60):[];
  return {kind:typeOf(data),fields,signature:typeOf(data)+"|"+fields.join("|")};
}
export function inspectNestedGameShape(document){
  return {paths:fieldsIn(document),variant:shapeOf(document)};
}
function emptyGroup(){
  return {receipts:0,indexed:0,unindexed:0,invalid:0,inspected:0,
    tooLarge:0,unreadable:0,duplicate:0,
    fields:Object.create(null),variants:[],otherVariants:0,
    routes:Object.create(null),ignoredRoutes:0,sampledHashes:[]};
}
function emptyRoute(kind){
  return {kind,receipts:0,inspected:0,attempted:0,tooLarge:0,
    unreadable:0,candidates:[]};
}
function rankCandidate(key){
  let h=2166136261;
  for(let i=0;i<key.length;i++){
    h=Math.imul(h^key.charCodeAt(i),16777619);
  }
  return h>>>0;
}
function indexReceipt(state,receipt,run,receiptKey){
  const record=validReceipt(receipt,run);
  if(!record)return;
  state.validReceipts++;
  let group=state.families[record.family];
  if(!group){
    if(Object.keys(state.families).length>=MAX_FAMILIES){
      state.untrackedFamilies++;return;
    }
    group=emptyGroup();state.families[record.family]=group;
  }
  group.receipts++;
  if(record.storage==="unindexed"){group.unindexed++;return;}
  if(record.storage!=="indexed"){group.invalid++;return;}
  group.indexed++;
  let route=group.routes[record.route];
  if(!route){
    if(Object.keys(group.routes).length>=MAX_ROUTES){
      group.ignoredRoutes++;return;
    }
    route=emptyRoute(record.kind);
    group.routes[record.route]=route;
  }
  route.receipts++;
  // Keep a deterministic, bounded cross-archive sample for each route shape.
  // This is independent of receipt enumeration order and avoids first-page bias.
  const sample={key:record.key,path:record.path,rank:rankCandidate(receiptKey)};
  if(route.candidates.some(v=>v.key===sample.key))return;
  if(route.candidates.length<CANDIDATES_PER_ROUTE){
    route.candidates.push(sample);return;
  }
  let highest=0;
  for(let i=1;i<route.candidates.length;i++)
    if(route.candidates[i].rank>route.candidates[highest].rank)highest=i;
  if(sample.rank<route.candidates[highest].rank)
    route.candidates[highest]=sample;
}
function addDocument(group,route,document,path){
  const shape=inspectNestedGameShape(document);
  group.inspected++;route.inspected++;
  for(const row of shape.paths){
    let field=group.fields[row.path];
    if(!field){
      if(Object.keys(group.fields).length>=MAX_FIELDS)continue;
      field={count:0,types:[]};group.fields[row.path]=field;
    }
    field.count++;
    for(const type of row.types)
      if(!field.types.includes(type))field.types.push(type);
  }
  let found=group.variants.find(v=>v.signature===shape.variant.signature);
  if(found){found.count++;return;}
  if(group.variants.length>=MAX_VARIANTS){group.otherVariants++;return;}
  group.variants.push({...shape.variant,count:1,examplePath:path});
}
function empty(run,now){
  return {version:2,runId:run,status:"running",phase:"indexing",
    startedAt:now,updatedAt:now,finishedAt:null,cursor:null,
    pages:0,receiptsListed:0,validReceipts:0,failedReceipts:0,
    untrackedFamilies:0,families:Object.create(null),
    note:"Inventaire des routes en cours, puis échantillonnage équilibré."};
}
function present(state){
  if(!state)return {status:"not-started",
    note:"Aucun audit V2 lancé. Le rapport V1 est conservé séparément dans R2."};
  const families=Object.entries(state.families||{}).map(([family,g])=>{
    const routes=Object.entries(g.routes).map(([pattern,r])=>({
      pattern,kind:r.kind,receipts:r.receipts,inspected:r.inspected,
      attempted:r.attempted,tooLarge:r.tooLarge,unreadable:r.unreadable,
      state:r.inspected?"sampled":r.candidates.length?"pending":
        r.attempted?"unavailable":"not-sampled"
    })).sort((a,b)=>b.receipts-a.receipts||a.pattern.localeCompare(b.pattern));
    const {sampledHashes,routes:internal,...other}=g;
    return {family,...other,routes};
  }).sort((a,b)=>b.receipts-a.receipts||a.family.localeCompare(b.family));
  return {version:state.version,runId:state.runId,status:state.status,
    phase:state.phase,startedAt:state.startedAt,updatedAt:state.updatedAt,
    finishedAt:state.finishedAt,receiptsListed:state.receiptsListed,
    validReceipts:state.validReceipts,failedReceipts:state.failedReceipts,
    pages:state.pages,untrackedFamilies:state.untrackedFamilies,
    families,note:state.note};
}
export async function handleGameArchiveSchemaAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))
    return json({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list||!bucket?.head)
    return json({error:"storage-unavailable"},503);
  if(new URL(request.url).search)return json({error:"unsupported-query"},400);
  try{
    const active=await read(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))return json({error:"no-active-run"},404);
    const key=auditKey(active.runId);
    if(request.method==="GET")return json(present(await read(bucket,key)));
    if(new URL(request.url).origin!==ORIGIN||
      request.headers.get("Origin")!==ORIGIN||
      !(request.headers.get("Content-Type")||"").toLowerCase()
        .startsWith("application/json"))return json({error:"forbidden"},403);
    const body=await request.text();
    if(body.length>80||JSON.parse(body)?.action!=="start")
      return json({error:"invalid-action"},400);
    const existing=await read(bucket,key);
    if(existing?.status==="running")return json(present(existing));
    const state=empty(active.runId,new Date(now).toISOString());
    await save(bucket,key,state);
    return json(present(state));
  }catch{return json({error:"audit-unavailable"},503);}
}
async function indexTick(bucket,state,run){
  const prefix=receiptPrefix(run);
  const listed=await bucket.list({prefix,limit:PAGE,
    ...(state.cursor?{cursor:state.cursor}:{})});
  if(listed.truncated&&(!listed.cursor||listed.cursor===state.cursor))
    return {status:"missing-r2-cursor"};
  const keys=(listed.objects||[]).map(x=>x.key).filter(key=>
    typeof key==="string"&&key.startsWith(prefix)).slice(0,PAGE);
  const rows=new Array(keys.length);
  let next=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,keys.length)},
    async()=>{
      while(next<keys.length){
        const i=next++;
        try{rows[i]={value:await read(bucket,keys[i])};}
        catch{rows[i]={error:true};}
      }
    }));
  for(let i=0;i<rows.length;i++){
    state.receiptsListed++;
    if(rows[i].error){state.failedReceipts++;continue;}
    indexReceipt(state,rows[i].value,run,keys[i]);
  }
  state.pages++;
  state.cursor=listed.truncated?listed.cursor:null;
  if(!listed.truncated){
    state.phase="sampling";
    state.note="Inventaire terminé. Échantillonnage des familles et routes en cours.";
  }
  return {status:"ok"};
}
function pendingRoutes(state){
  const all=[];
  for(const [family,g] of Object.entries(state.families)){
    if(g.inspected>=MAX_FAMILY_SAMPLES)continue;
    for(const [pattern,r] of Object.entries(g.routes)){
      if(r.candidates.length&&r.attempted<CANDIDATES_PER_ROUTE)
        all.push({family,pattern,g,r});
    }
  }
  return all;
}
async function sampleTick(bucket,state){
  let fetched=0,attempts=0;
  while(fetched<SAMPLES_PER_TICK&&attempts<ATTEMPTS_PER_TICK){
    const choices=pendingRoutes(state);
    if(!choices.length)break;
    // Select the least-covered family and route. A busy /items/detail route
    // cannot starve /characters, /events, /traits or /scopes anymore.
    choices.sort((a,b)=>
      a.g.inspected-b.g.inspected||
      a.r.inspected-b.r.inspected||
      a.r.attempted-b.r.attempted||
      a.family.localeCompare(b.family)||
      a.pattern.localeCompare(b.pattern));
    const {g,r}=choices[0];
    const candidate=r.candidates.shift();
    r.attempted++;attempts++;
    const hash=candidate.key.slice(candidate.key.lastIndexOf("/")+1);
    if(g.sampledHashes.includes(hash)){g.duplicate++;continue;}
    g.sampledHashes.push(hash);
    if(g.sampledHashes.length>MAX_FAMILY_SAMPLES*3)
      g.sampledHashes.shift();
    let head;
    try{head=await bucket.head(candidate.key);}
    catch{g.unreadable++;r.unreadable++;continue;}
    if(!head||!Number.isFinite(head.size)){
      g.unreadable++;r.unreadable++;continue;
    }
    if(head.size>MAX_BYTES){g.tooLarge++;r.tooLarge++;continue;}
    fetched++;
    try{
      const doc=await read(bucket,candidate.key);
      if(!doc||typeof doc!=="object"||Array.isArray(doc)||
        !Object.hasOwn(doc,"data"))throw Error("invalid-shape");
      addDocument(g,r,doc,candidate.path);
    }catch{g.unreadable++;r.unreadable++;}
  }
}
export async function runGameArchiveSchemaAuditTick(env,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list||!bucket?.head)
    return {status:"storage-unavailable"};
  try{
    const active=await read(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))return {status:"not-started"};
    const key=auditKey(active.runId),state=await read(bucket,key);
    if(!state||state.version!==2||state.runId!==active.runId||
      state.status!=="running")return {status:state?.status||"not-started"};
    if(state.phase==="indexing"){
      const progress=await indexTick(bucket,state,active.runId);
      if(progress.status!=="ok")return progress;
    }else if(state.phase==="sampling"){
      await sampleTick(bucket,state);
      if(!pendingRoutes(state).length){
        state.status="snapshot-complete";state.phase="complete";
        state.finishedAt=new Date(now).toISOString();
        const collector=await read(bucket,progressKey(active.runId));
        const finalized=["completed","completed-with-gaps"].includes(collector?.status);
        state.note=finalized?
          "Toutes les routes indexées ont reçu leurs tentatives d'échantillonnage bornées. Certains JSON peuvent rester inaccessibles, trop volumineux ou non indexés.":
          "Audit terminé sur un instantané pendant la collecte encore active. Relancer l'audit V2 après la collecte ; les nouveaux reçus n'ont pas été parcourus.";
      }
    }else return {status:"invalid-phase"};
    state.updatedAt=new Date(now).toISOString();
    await save(bucket,key,state);
    return {status:state.status,phase:state.phase,
      receiptsListed:state.receiptsListed,
      samples:Object.values(state.families).reduce((n,g)=>n+g.inspected,0)};
  }catch{return {status:"audit-unavailable"};}
}
