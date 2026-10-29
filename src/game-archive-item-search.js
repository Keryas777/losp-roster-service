// Private, exact-ID lookup of archived /game/v1/items/{id} responses.
// No Scopely calls, no R2 writes, no player data or private R2 keys returned.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,DIFF=ROOT+"diff/";
const ACTIVE=ROOT+"active.json";
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"};
const json=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const ID=/^[A-Za-z0-9:_-]{1,180}$/;
const RUN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
const CURSOR=/^[A-Za-z0-9+/=_-]{1,800}$/;
const PAGE=20,MAX_JSON_BYTES=750_000,MAX_META_BYTES=8000;
const TTL=30*24*60*60*1000;
const sha256=async value=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(value)))]
  .map(v=>v.toString(16).padStart(2,"0")).join("");
const fresh=(value,now)=>{
  const time=typeof value==="string"?Date.parse(value):
    value instanceof Date?value.getTime():NaN;
  return Number.isFinite(time)&&time>0&&time<=now+300000&&now-time<TTL;
};
const read=async(b,key)=>{
  const obj=await b.get(key);
  if(!obj)return null;
  if(!Number.isFinite(obj.size)||obj.size>MAX_META_BYTES)throw Error("metadata-size");
  return JSON.parse(await obj.text());
};
async function verifiedJSON(b,objectKey,expectedSha,storedAt,now){
  if(!fresh(storedAt,now))return {issue:"expired-or-unknown-date"};
  const head=await b.head(objectKey);
  if(!head)return {issue:"missing-object"};
  if(head.uploaded&&!fresh(head.uploaded,now))return {issue:"expired-object"};
  if(!Number.isFinite(head.size)||head.size>MAX_JSON_BYTES)
    return {issue:"object-too-large-to-display"};
  const obj=await b.get(objectKey);
  if(!obj||!Number.isFinite(obj.size)||obj.size!==head.size)
    return {issue:"missing-or-inconsistent-object"};
  if(obj.size>MAX_JSON_BYTES)return {issue:"object-too-large-to-display"};
  const raw=await obj.text();
  if(await sha256(raw)!==expectedSha)return {issue:"sha256-mismatch"};
  try{
    const payload=JSON.parse(raw);
    if(!payload||typeof payload!=="object"||Array.isArray(payload)||
       !Object.hasOwn(payload,"data"))return {issue:"invalid-game-json"};
    return {payload};
  }catch{return {issue:"invalid-game-json"};}
}
async function differential(b,path,now){
  const pointer=await read(b,DIFF+"latest/"+await sha256(path)+".json");
  if(!pointer)return {issue:null};
  const hash=pointer.sha256,key=pointer.objectKey,receiptKey=pointer.receiptKey;
  if(pointer.path!==path||!SHA.test(hash||"")||
     typeof key!=="string"||!key.endsWith("/objects/"+hash+".json")||
     !(key.startsWith(ROOT+"runs/")||key.startsWith(DIFF+"runs/"))||
     typeof receiptKey!=="string"||
     !new RegExp("^"+DIFF.replaceAll("/","\\/")+"runs/[0-9a-f-]{36}/checks/\\d{8}\\.json$","i").test(receiptKey))
    return {issue:"invalid-differential-pointer"};
  const receipt=await read(b,receiptKey);
  if(!receipt||receipt.version!==2||
     !["changed","unchanged"].includes(receipt.status)||
     receipt.path!==path||receipt.objectKey!==key||
     receipt.sha256!==hash||receipt.storedAt!==pointer.storedAt||
     receipt.checkedAt!==pointer.checkedAt)
    return {issue:"invalid-differential-receipt"};
  const result=await verifiedJSON(b,key,hash,receipt.storedAt,now);
  return result.payload?
    {status:"found",source:"differential",storedAt:receipt.storedAt,
      checkedAt:receipt.checkedAt,payload:result.payload}:
    {issue:result.issue};
}
async function initialReceipt(b,receipt,path,run,now){
  if(receipt?.path!==path||receipt.status!==200)return null;
  const sha=receipt.sha256,key=receipt.objectKey;
  if(!SHA.test(sha||"")||typeof key!=="string"||
     key!==ROOT+"runs/"+run+"/objects/"+sha+".json")
    return {issue:receipt.indexed===false?"raw-unindexed":"invalid-original-receipt"};
  const result=await verifiedJSON(b,key,sha,receipt.capturedAt,now);
  return result.payload?
    {status:"found",source:"original",storedAt:receipt.capturedAt,
      payload:result.payload}:{issue:result.issue};
}
export async function handleGameArchiveItemSearch(request,env,now=Date.now()){
  if(request.method!=="GET")return json({error:"method-not-allowed"},405);
  const q=new URL(request.url).searchParams,id=q.get("id"),cursor=q.get("cursor");
  if(!ID.test(id||"")||q.size>(cursor===null?1:2)||
     (cursor!==null&&!CURSOR.test(cursor)))
    return json({error:"invalid-search"},400);
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.head||!b?.list)return json({error:"storage-unavailable"},503);
  const path="/game/v1/items/"+id;
  try{
    const active=await read(b,ACTIVE);
    if(!RUN.test(active?.runId||""))return json({error:"no-active-run"},404);
    let warning=null;
    // The hash-addressed differential lookup costs one R2 GET.
    if(!cursor){
      const latest=await differential(b,path,now);
      if(latest.status==="found")
        return json({id,path,...latest,scope:"verified-archived-json"});
      warning=latest.issue;
    }
    // Legacy receipts have no URL index. Scan a bounded page per request,
    // allowing the browser to resume with R2's opaque cursor.
    const prefix=ROOT+"runs/"+active.runId+"/receipts/";
    const page=await b.list({prefix,limit:PAGE,...(cursor?{cursor}:{})});
    if(!Array.isArray(page?.objects)||page.objects.some(o=>
      typeof o?.key!=="string"||!o.key.startsWith(prefix))||
       page.truncated&&(!page.cursor||!CURSOR.test(page.cursor)||
       page.cursor===cursor))
      return json({error:"invalid-receipt-list"},503);
    let examined=0;
    for(const entry of page.objects){
      examined++;
      let receipt;
      try{receipt=await read(b,entry.key);}
      catch{warning=warning||"unreadable-receipt";continue;}
      const candidate=await initialReceipt(b,receipt,path,active.runId,now);
      if(candidate?.status==="found")
        return json({id,path,...candidate,scope:"verified-archived-json"});
      if(candidate?.issue)warning=warning||candidate.issue;
    }
    return json({id,path,status:page.truncated?"searching":"not-indexed",
      examined,nextCursor:page.truncated?page.cursor:null,
      issue:warning,
      note:page.truncated?"Continue scanning original receipts.":
        "No validated exact-path receipt found. Orphaned blobs cannot prove an ID."});
  }catch{return json({error:"r2-search-unavailable"},503);}
}
