// Recoverability audit for existing indexed /game/v1 R2 objects, no Scopely requests.
// Writes ONLY its own resumable audit checkpoint; never alters source archives.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT;
const ACTIVE=ROOT+"active.json";
const RUN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}\.json$/i;
const GAME_PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const PAGE=40,CONCURRENT=4,MAX_JSON_BYTES=256_000,MAX_RECEIPT_BYTES=4096;
const MAX_EVIDENCE_BYTES=1_500_000,MAX_SHAPES=48;
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex"};
const send=(data,status=200)=>Response.json(data,{status,headers:HEADERS});
const prefix=run=>ROOT+"runs/"+run+"/";
const auditKey=run=>prefix(run)+"orphan-audit/v1-progress.json";
const objectPrefix=run=>prefix(run)+"objects/";
const receiptPrefix=run=>prefix(run)+"receipts/";
const queuePrefix=run=>prefix(run)+"queue/";
const seenPrefix=run=>prefix(run)+"phase2-seen/";
const progressKey=run=>prefix(run)+"progress.json";
async function getSmall(bucket,key,maxBytes){
  const file=await bucket.get(key);
  if(!file)return null;
  if(Number.isFinite(file.size)&&file.size>maxBytes)throw Error("oversized");
  const content=await file.text();
  if(content.length>maxBytes)throw Error("oversized");
  return JSON.parse(content);
}
async function save(bucket,key,state){
  await bucket.put(key,JSON.stringify(state),{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"
  }});
}
async function listing(bucket,p,state,limit=PAGE){
  const listed=await bucket.list({prefix:p,limit,
    ...(state.cursor?{cursor:state.cursor}:{})});
  if(!Array.isArray(listed?.objects)||
      (listed.truncated&&(!listed.cursor||listed.cursor===state.cursor))||
      listed.objects.some(o=>typeof o?.key!=="string"||!o.key.startsWith(p)))
    throw Error("invalid-r2-page");
  return listed;
}
function empty(run,stamp){
  return {version:1,runId:run,status:"running",phase:"receipts",
    startedAt:stamp,updatedAt:stamp,finishedAt:null,cursor:null,pages:0,
    references:[],receipts:{listed:0,valid:0,invalid:0,unreadable:0},
    evidence:{queueChunks:0,queueTasks:0,seenShards:0,seenPaths:0,
      unreadable:0,progressStatus:null,collectorArchived:null,collectorTasks:null},
    evidenceStage:"queue",
    objects:{listed:0,withReceipt:0,orphaned:0,inspected:0,
      hashVerified:0,hashMismatch:0,invalidJSON:0,unreadable:0,
      tooLarge:0,invalidNames:0,bytesListed:0},
    shapes:{},otherShapes:0,
    note:"Inventaire des reçus, des indices historiques puis des objets R2."};
}
function shapeOf(doc){
  const data=doc?.data;
  if(!doc||typeof doc!=="object"||Array.isArray(doc)||data===undefined)
    return null;
  const row=Array.isArray(data)?data.find(x=>x&&typeof x==="object"&&!Array.isArray(x)):data;
  const fields=row&&typeof row==="object"&&!Array.isArray(row)?
    Object.keys(row).sort().slice(0,30):[];
  const keys=new Set(fields);
  const has=(...names)=>names.every(n=>keys.has(n));
  let likely="indetermined";
  if(has("striker","healer","fortifier"))likely="iso8Abilities";
  else if(has("character","equips"))likely="items-character-relations";
  else if(has("unlockStars","traits","portrait"))likely="characters";
  else if(has("stats","sheetStats","basic"))likely="characterInstances";
  else if(has("level","gearTier","basic","special"))likely="characterInstanceCaps";
  else if(has("numChapters","chapters"))likely="episodics";
  else if(has("startTime","endTime","milestone"))likely="events";
  else if(keys.has("noInv")||has("icon","tier"))likely="items";
  else if(has("rewardBackground","utUpgrade"))likely="decorations";
  // Identifying by structure can NEVER prove the originating endpoint.
  return {likely,form:Array.isArray(data)?"array":data===null?"null":typeof data,
    fields,signature:(Array.isArray(data)?"array|":"object|")+fields.join("|")};
}
function observe(state,shape){
  if(!shape)return;
  const key=shape.signature.slice(0,350);
  const current=state.shapes[key];
  if(current){current.count++;return;}
  if(Object.keys(state.shapes).length>=MAX_SHAPES){state.otherShapes++;return;}
  state.shapes[key]={likelyFamily:shape.likely,form:shape.form,fields:shape.fields,
    count:1,confidence:"structural-hypothesis-only"};
}
function publicState(s){
  if(!s)return {status:"not-started",note:"Démarrage manuel nécessaire ; aucun appel Scopely."};
  const {references,shapes,evidenceStage,cursor,...summary}=s;
  const variants=Object.values(shapes).sort((a,b)=>b.count-a.count);
  const likelyFamilies={};
  for(const v of variants)likelyFamilies[v.likelyFamily]=(likelyFamilies[v.likelyFamily]||0)+v.count;
  return {...summary,referenceCount:references.length,
    variants,likelyFamilies,
    note:s.status==="snapshot-complete"?
      "Audit de la présence et de la structure, sans preuve de provenance pour les orphelins.":
      s.note};
}
export async function handleGameOrphanAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))return send({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return send({error:"unsupported-query"},400);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list)return send({error:"storage-unavailable"},503);
  try{
    const active=await getSmall(bucket,ACTIVE,4096);
    if(!RUN.test(active?.runId||""))return send({error:"no-active-run"},404);
    const key=auditKey(active.runId),previous=await getSmall(bucket,key,150_000);
    if(request.method==="GET")return send(publicState(previous));
    if(new URL(request.url).origin!==ORIGIN||
      request.headers.get("Origin")!==ORIGIN||
      !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
      return send({error:"forbidden"},403);
    const body=await request.text();
    if(body.length>80||JSON.parse(body)?.action!=="start")
      return send({error:"invalid-action"},400);
    // Do not overwrite completed or running reports. Any rerun should be a
    // separately versioned snapshot, not an implicit destructive restart.
    if(previous)return send(publicState(previous));
    const state=empty(active.runId,new Date(now).toISOString());
    await save(bucket,key,state);
    return send(publicState(state));
  }catch{return send({error:"orphan-audit-unavailable"},503);}
}
async function receiptsTick(bucket,s){
  const listed=await listing(bucket,receiptPrefix(s.runId),s);
  const keys=listed.objects.map(o=>o.key),refs=new Set(s.references);
  let next=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENT,keys.length)},async()=>{
    while(next<keys.length){
      const i=next++,obj=listed.objects[i];
      s.receipts.listed++;
      try{
        if(Number.isFinite(obj.size)&&obj.size>MAX_RECEIPT_BYTES)throw Error("oversized");
        const value=await getSmall(bucket,obj.key,MAX_RECEIPT_BYTES);
        const path=value?.path,objectKey=value?.objectKey,
          base=objectPrefix(s.runId);
        if(value?.status===200&&GAME_PATH.test(path||"")&&
          typeof objectKey==="string"&&objectKey.startsWith(base)&&
          SHA.test(objectKey.slice(base.length))){
          s.receipts.valid++;refs.add(objectKey.slice(base.length));
        }else s.receipts.invalid++;
      }catch{s.receipts.unreadable++;}
    }
  }));
  s.references=[...refs];
  s.cursor=listed.truncated?listed.cursor:null;s.pages++;
  if(!listed.truncated){s.phase="evidence";s.evidenceStage="queue";}
}
async function evidenceTick(bucket,s){
  if(s.evidence.progressStatus===null){
    try{
      const p=await getSmall(bucket,progressKey(s.runId),MAX_EVIDENCE_BYTES);
      s.evidence.progressStatus=typeof p?.status==="string"?p.status:"unavailable";
      s.evidence.collectorArchived=Number.isSafeInteger(p?.count)?p.count:null;
      s.evidence.collectorTasks=Number.isSafeInteger(p?.completedOffset)&&
        Number.isSafeInteger(p?.cursor)?p.completedOffset+p.cursor:null;
      if(Array.isArray(p?.tasks))s.evidence.currentWindowTasks=p.tasks.length;
    }catch{s.evidence.progressStatus="unreadable";s.evidence.unreadable++;}
  }
  const stage=s.evidenceStage,folder=stage==="queue"?"queue":"phase2-seen";
  const listed=await listing(bucket,
    stage==="queue"?queuePrefix(s.runId):seenPrefix(s.runId),s,4);
  for(const o of listed.objects){
    try{
      if(Number.isFinite(o.size)&&o.size>MAX_EVIDENCE_BYTES)throw Error("oversized");
      const data=await getSmall(bucket,o.key,MAX_EVIDENCE_BYTES);
      if(!Array.isArray(data))throw Error("invalid-list");
      if(stage==="queue"){
        s.evidence.queueChunks++;
        s.evidence.queueTasks+=data.filter(x=>typeof x?.path==="string"&&
          x.path.startsWith("/game/v1/")).length;
      }else{
        s.evidence.seenShards++;
        s.evidence.seenPaths+=data.filter(x=>typeof x==="string"&&
          x.startsWith("/game/v1/")).length;
      }
    }catch{s.evidence.unreadable++;}
  }
  s.cursor=listed.truncated?listed.cursor:null;s.pages++;
  if(!listed.truncated){
    if(stage==="queue")s.evidenceStage="seen";
    else s.phase="objects";
  }
}
async function objectsTick(bucket,s){
  const folder=objectPrefix(s.runId),listed=await listing(bucket,folder,s);
  const refs=new Set(s.references);
  let next=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENT,listed.objects.length)},async()=>{
    while(next<listed.objects.length){
      const entry=listed.objects[next++],name=entry.key.slice(folder.length);
      s.objects.listed++;
      if(!SHA.test(name)){s.objects.invalidNames++;continue;}
      if(Number.isFinite(entry.size)&&entry.size>=0)
        s.objects.bytesListed+=entry.size;
      if(refs.has(name)){s.objects.withReceipt++;continue;}
      s.objects.orphaned++;
      if(!Number.isSafeInteger(entry.size)||entry.size<0||
        entry.size>MAX_JSON_BYTES){s.objects.tooLarge++;continue;}
      try{
        const stored=await bucket.get(entry.key);
        if(!stored)throw Error("missing");
        const bytes=await stored.arrayBuffer();
        if(bytes.byteLength>MAX_JSON_BYTES){s.objects.tooLarge++;continue;}
        const calculated=await crypto.subtle.digest("SHA-256",bytes);
        const hex=Array.from(new Uint8Array(calculated),b=>b.toString(16).padStart(2,"0")).join("");
        if(hex+".json"!==name){s.objects.hashMismatch++;continue;}
        s.objects.hashVerified++;
        let payload;
        try{payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
        catch{s.objects.invalidJSON++;continue;}
        const shape=shapeOf(payload);
        if(!shape){s.objects.invalidJSON++;continue;}
        s.objects.inspected++;observe(s,shape);
      }catch{s.objects.unreadable++;}
    }
  }));
  s.cursor=listed.truncated?listed.cursor:null;s.pages++;
  if(!listed.truncated){s.phase="complete";s.status="snapshot-complete";}
}
export async function runGameOrphanAuditTick(env,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list)return {status:"storage-unavailable"};
  try{
    const active=await getSmall(bucket,ACTIVE,4096);
    if(!RUN.test(active?.runId||""))return {status:"not-started"};
    const key=auditKey(active.runId),s=await getSmall(bucket,key,150_000);
    if(!s||s.version!==1||s.runId!==active.runId||s.status!=="running")
      return {status:s?.status||"not-started"};
    if(s.phase==="receipts")await receiptsTick(bucket,s);
    else if(s.phase==="evidence")await evidenceTick(bucket,s);
    else if(s.phase==="objects")await objectsTick(bucket,s);
    else return {status:"invalid-phase"};
    s.updatedAt=new Date(now).toISOString();
    if(s.status==="snapshot-complete")s.finishedAt=s.updatedAt;
    await save(bucket,key,s);
    return {status:s.status,phase:s.phase,objects:s.objects.listed,
      orphaned:s.objects.orphaned,receipts:s.receipts.listed};
  }catch{return {status:"orphan-audit-unavailable"};}
}
