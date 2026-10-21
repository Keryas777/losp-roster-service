// Bounded, read-only inventory of PHYSICAL R2 objects for one active game run.
// Does not contact Scopely, inspect game payloads, or write to R2.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,ACTIVE=ROOT+"active.json";
const PAGE=200,CONCURRENCY=5,MAX_RECEIPT_BYTES=4096;
const RUN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}\.json$/i;
const RAW=/^[a-f0-9-]{36}\.json$/i;
const PATH=/^\/game\/v1\/[A-Za-z0-9/_:?.=%&,+-]{1,800}$/;
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"};
const respond=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
async function getJSON(bucket,key){
  const o=await bucket.get(key);
  if(!o)return null;
  if(Number.isFinite(o.size)&&o.size>MAX_RECEIPT_BYTES)
    throw Error("oversized");
  return JSON.parse(await o.text());
}
const suffix=(root,run,type)=>root+"runs/"+run+"/"+type+"/";
function classifiedReceipt(doc,run){
  if(doc?.status!==200||typeof doc.path!=="string"||!PATH.test(doc.path))
    return null;
  const prefix=ROOT+"runs/"+run+"/";
  const key=doc.objectKey;
  if(typeof key!=="string"||!key.startsWith(prefix))return null;
  const tail=key.slice(prefix.length);
  if(tail.startsWith("objects/")&&SHA.test(tail.slice(8)))
    return {type:"objects",id:tail.slice(8)};
  if(tail.startsWith("raw/")&&RAW.test(tail.slice(4)))
    return {type:"raw",id:tail.slice(4)};
  return null;
}
export async function handleGameArchiveInventory(request,env){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.list)return respond({error:"storage-unavailable"},503);
  const params=new URL(request.url).searchParams;
  const kind=params.get("kind");
  if(!["overview","receipts","objects","raw"].includes(kind)|| 
     [...params.keys()].some(k=>!["kind","runId","cursor"].includes(k))||
     params.getAll("kind").length!==1||params.getAll("runId").length>1||
     params.getAll("cursor").length>1)return respond({error:"invalid-query"},400);
  const runId=params.get("runId"),cursor=params.get("cursor");
  if(kind==="overview"&&(runId!==null||cursor!==null))
    return respond({error:"invalid-query"},400);
  if(kind!=="overview"&&(!RUN.test(runId||"")||
     cursor!==null&&!/^[A-Za-z0-9+/_=-]{1,1024}$/.test(cursor)))
    return respond({error:"invalid-query"},400);
  try{
    const active=await getJSON(bucket,ACTIVE);
    if(!RUN.test(active?.runId||""))return respond({error:"no-active-run"},404);
    if(kind==="overview")return respond({
      status:"ready",scope:"physical-r2-inventory",runId:active.runId,
      pageSize:PAGE,source:"private-r2-only",
      note:"Lecture paginée des objets R2, sans données MSF ni appel Scopely."
    });
    if(runId!==active.runId)return respond({error:"active-run-changed"},409);
    const prefix=suffix(ROOT,runId,kind);
    const listed=await bucket.list({prefix,limit:PAGE,
      ...(cursor?{cursor}:{})});
    if(!Array.isArray(listed?.objects)||
       listed.truncated&&(!listed.cursor||listed.cursor===cursor))
      return respond({error:"invalid-r2-page"},503);
    if(listed.objects.some(entry=>typeof entry?.key!=="string"||
      !entry.key.startsWith(prefix)))
      return respond({error:"invalid-r2-page"},503);
    const result={status:"page",runId,kind,listed:listed.objects.length,
      nextCursor:listed.truncated?listed.cursor:null};
    if(kind==="receipts"){
      // Read only small receipt records; never read or expose game JSON.
      const rows=new Array(listed.objects.length);
      let index=0;
      await Promise.all(Array.from({length:Math.min(CONCURRENCY,rows.length)},
        async()=>{
          while(index<rows.length){
            const i=index++,obj=listed.objects[i];
            try{
              if(Number.isFinite(obj.size)&&obj.size>MAX_RECEIPT_BYTES)
                throw Error("oversized");
              const doc=await getJSON(bucket,obj.key);
              rows[i]=doc?{kind:"read",ref:classifiedReceipt(doc,runId)}:
                {kind:"unreadable"};
            }catch{rows[i]={kind:"unreadable"};}
          }
        }));
      result.references=rows.filter(r=>r?.ref).map(r=>r.ref);
      result.validReceipts=result.references.length;
      result.invalidReceipts=rows.filter(r=>r?.kind==="read"&&!r.ref).length;
      result.unreadableReceipts=rows.filter(r=>r?.kind==="unreadable").length;
    }else{
      const expected=kind==="objects"?SHA:RAW;
      const good=listed.objects.filter(o=>expected.test(o.key.slice(prefix.length)));
      result.ids=good.map(o=>o.key.slice(prefix.length));
      result.invalidNames=listed.objects.length-good.length;
      result.bytesKnown=good.filter(x=>Number.isSafeInteger(x.size)&&x.size>=0)
        .reduce((n,x)=>n+x.size,0);
      result.sizesUnknown=good.filter(x=>!Number.isSafeInteger(x.size)||x.size<0).length;
    }
    return respond(result);
  }catch{return respond({error:"inventory-r2-unavailable"},503);}
}
