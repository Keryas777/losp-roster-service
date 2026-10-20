// Private R2 archive explorer: inspect RECEIPTS and a few small game JSON
// shapes, no raw JSON, no player data, no Scopely requests, no R2 writes.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT;
const ACTIVE=ROOT+"active.json";
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const respond=(payload,status=200)=>Response.json(payload,{status,headers:HEADERS});
const RUN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}\.json$/i;
const ID=/^[A-Za-z0-9:_-]{1,180}$/;
const COUNT=20;
const MAX_SAMPLE_BYTES=750_000;
const MAX_SAMPLES=4;
const getJSON=async(bucket,key)=>{
  const obj=await bucket.get(key);
  if(!obj)return null;
  return JSON.parse(await obj.text());
};
const dataKind=value=>Array.isArray(value)?"array":
  value===null?"null":typeof value;
const keys=value=>value&&typeof value==="object"&&!Array.isArray(value)?
  Object.keys(value).slice(0,40):[];
const familyOf=path=>{
  const seg=path.slice("/game/v1/".length).split(/[/?]/);
  return seg[0]==="analysis"&&seg[1]==="teamOrder"?
    "analysis/teamOrder":seg[0]||"inconnue";
};
export function inspectGameShape(doc){
  if(!doc||typeof doc!=="object"||Array.isArray(doc))
    return {format:"unexpected",rootKeys:[],dataType:dataKind(doc),
      dataKeys:[],entryCount:null,entryKeys:[],metaKeys:[],exampleIds:[]};
  const data=doc.data,first=Array.isArray(data)?data[0]:null;
  const exampleIds=Array.isArray(data)?data.slice(0,15)
    .map(v=>typeof v==="string"?v:v?.id)
    .filter(v=>(typeof v==="string"||typeof v==="number")&&
      ID.test(String(v))).slice(0,3).map(String):[];
  return {format:"json",rootKeys:keys(doc),dataType:dataKind(data),
    dataKeys:keys(data),
    entryCount:Array.isArray(data)?data.length:null,
    entryKeys:keys(first),metaKeys:keys(doc.meta),
    exampleIds};
}
function validReceipt(receipt,run){
  if(!receipt||receipt.status!==200||
     typeof receipt.path!=="string"||
     !/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/.test(receipt.path))
    return null;
  const prefix=ROOT+"runs/"+run+"/";
  const objectKey=receipt.objectKey;
  let kind="none";
  if(typeof objectKey==="string"&&objectKey.startsWith(prefix+"objects/")&&
     HASH.test(objectKey.slice((prefix+"objects/").length)))kind="indexed";
  else if(typeof objectKey==="string"&&
      objectKey.startsWith(prefix+"raw/")&&
      /^[0-9a-f-]{36}\.json$/i.test(objectKey.slice((prefix+"raw/").length)))
    kind="raw-unindexed";
  // The private object key is never returned to the browser.
  return {path:receipt.path,family:familyOf(receipt.path),
    capturedAt:typeof receipt.capturedAt==="string"&&
      /^\d{4}-\d\d-\d\dT/.test(receipt.capturedAt)?
      receipt.capturedAt:null,
    bytes:Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=0?
      receipt.bytes:null,
    storage:kind,objectKey:kind!=="none"?objectKey:null};
}
export async function handleGameArchiveInspect(request,env){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.list||!bucket?.get)return respond({error:"storage-unavailable"},503);
  const params=new URL(request.url).searchParams;
  const cursor=params.get("cursor");
  if(params.size>1||cursor!==null&&(!/^[A-Za-z0-9+/=_-]{1,800}$/.test(cursor)))
    return respond({error:"invalid-cursor"},400);
  try{
    const active=await getJSON(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))
      return respond({error:"no-active-run"},404);
    const prefix=ROOT+"runs/"+active.runId+"/receipts/";
    const result=await bucket.list({prefix,limit:COUNT,
      ...(cursor?{cursor}:{})});
    const rows=[],samples=[],seenFamilies=new Set();
    for(const item of result.objects||[]){
      // Listing is constrained to the current private run prefix.
      if(!item.key?.startsWith(prefix))continue;
      const receipt=await getJSON(bucket,item.key);
      const safe=validReceipt(receipt,active.runId);
      if(!safe)continue;
      const {objectKey,...record}=safe;
      rows.push(record);
      if(safe.storage!=="indexed"||seenFamilies.has(safe.family)||
         samples.length>=MAX_SAMPLES)continue;
      seenFamilies.add(safe.family);
      // R2's object-size metadata avoids loading unbounded JSON into Worker
      // memory merely to display its structure.
      const head=await bucket.head?.(objectKey);
      if(!head||!Number.isFinite(head.size)||head.size>MAX_SAMPLE_BYTES){
        samples.push({path:safe.path,family:safe.family,
          state:head?.size>MAX_SAMPLE_BYTES?"too-large-for-preview":"unavailable"});
        continue;
      }
      try{
        const doc=await getJSON(bucket,objectKey);
        samples.push({path:safe.path,family:safe.family,state:"inspected",
          shape:inspectGameShape(doc)});
      }catch{
        samples.push({path:safe.path,family:safe.family,state:"parse-unavailable"});
      }
    }
    const familyCounts={};
    for(const row of rows)familyCounts[row.family]=(familyCounts[row.family]||0)+1;
    return respond({status:"sample-only",limit:COUNT,listed:(result.objects||[]).length,
      validReceipts:rows.length,byFamily:Object.entries(familyCounts).map(([family,count])=>
        ({family,count})).sort((a,b)=>b.count-a.count),
      receipts:rows,samples,
      nextCursor:result.truncated?result.cursor||null:null,
      note:"Échantillon de reçus, pas un inventaire exhaustif. Aucun GET Scopely ni écriture R2."});
  }catch{return respond({error:"inspect-unavailable"},503);}
}
