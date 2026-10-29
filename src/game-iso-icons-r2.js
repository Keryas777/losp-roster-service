// Read only the six indexed /game/v1 ISO-8 records already stored in private R2.
// Called exclusively after the existing Cloudflare Access admin gate.
// No Scopely GET, R2 listing/write, OAuth access, or player data.
import {summarizeIsoIcons} from "./iso-icons-test.js";

const ROOT="game-archive/v1/";
const CLASSES=["striker","raider","skirmisher","healer","fortifier"];
const GAME="/game/v1/iso8Abilities";
const SHA=/^[a-f0-9]{64}$/;
const RUN="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const OBJECT=new RegExp("^game-archive/v1/(?:runs|diff/runs)/"+RUN+
  "/objects/([a-f0-9]{64})\\.json$","i");
const RECEIPT=new RegExp("^game-archive/v1/diff/runs/"+RUN+
  "/checks/[0-9]{8}\\.json$","i");
const MAX_AGE=30*86400000,MAX_JSON=1_500_000;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(data,code=200)=>Response.json(data,{status:code,headers:HEADERS});
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const fresh=(stamp,now)=>{
  const t=typeof stamp==="string"?Date.parse(stamp):NaN;
  return Number.isFinite(t)&&t<=now+300000&&now-t<MAX_AGE;
};
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(s)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
async function getJSON(bucket,key,max=MAX_JSON){
  const item=await bucket.get(key);
  if(!item)return null;
  if(!Number.isFinite(item.size)||item.size>max)throw Error("oversized");
  const bytes=await item.text();
  if(bytes.length>max)throw Error("oversized");
  return JSON.parse(bytes);
}
async function readIndexedPath(bucket,path,now){
  const latest=ROOT+"diff/latest/"+await hash(path)+".json";
  let pointer;
  try{pointer=await getJSON(bucket,latest,8192);}
  catch{return {path,status:"invalid-pointer"};}
  if(!pointer)return {path,status:"not-indexed"};
  const matched=OBJECT.exec(pointer.objectKey||"");
  if(pointer.version!==2||pointer.path!==path||
     !SHA.test(pointer.sha256||"")||
     !matched||matched[1]!==pointer.sha256||
     !RECEIPT.test(pointer.receiptKey||""))
    return {path,status:"invalid-pointer"};
  let receipt;
  try{receipt=await getJSON(bucket,pointer.receiptKey,8192);}
  catch{return {path,status:"invalid-receipt"};}
  if(!receipt||receipt.version!==2||receipt.path!==path||
     !["changed","unchanged"].includes(receipt.status)||
     receipt.sha256!==pointer.sha256||
     receipt.objectKey!==pointer.objectKey||
     receipt.storedAt!==pointer.storedAt||
     receipt.checkedAt!==pointer.checkedAt)
    return {path,status:"invalid-receipt"};
  if(!fresh(pointer.storedAt,now)||!fresh(pointer.checkedAt,now))
    return {path,status:"expired"};
  try{
    const payload=await getJSON(bucket,pointer.objectKey);
    if(!object(payload)||!object(payload.data))
      return {path,status:"unexpected-shape"};
    return {path,status:"verified",data:payload.data,
      storedAt:pointer.storedAt,checkedAt:pointer.checkedAt};
  }catch{return {path,status:"unreadable-object"};}
}
export async function inspectIsoIconsR2(bucket,now=Date.now()){
  const paths=[GAME,...CLASSES.map(id=>GAME+"/"+id)];
  // Exactly six lookups. No potentially unbounded legacy receipt scan.
  const sources=await Promise.all(paths.map(path=>readIndexedPath(bucket,path,now)));
  const root=sources[0],classes=CLASSES.map((id,index)=>{
    const detail=sources[index+1];
    const detailData=detail.status==="verified"?
      (object(detail.data[id])?detail.data[id]:detail.data):null;
    const rootData=root.status==="verified"?root.data[id]:null;
    const fromDetail=object(detailData)&&Array.isArray(detailData.icons);
    const data=fromDetail?detailData:rootData;
    const source=fromDetail?detail:root;
    const entry=summarizeIsoIcons({[id]:data}).classes.find(x=>x.id===id);
    const tier4=entry?.slots?.find(x=>x.index===4);
    return {id,status:entry?.status||"absent",
      sourceStatus:source.status,sourcePath:source.path,
      checkedAt:source.checkedAt||null,storedAt:source.storedAt||null,
      iconCount:entry?.count??null,
      tier4:{status:tier4?.state||"absent",url:tier4?.url||null},
      // Additional official image URLs are useful for visual comparison.
      icons:(entry?.slots||[]).map(x=>({tier:x.index,status:x.state,url:x.url}))};
  });
  return {status:"ok",source:"private-r2-only",
    note:"L'indice 4 est candidat au palier orange, pas une confirmation visuelle.",
    sources:sources.map(({path,status,checkedAt,storedAt})=>({
      path,status,checkedAt:checkedAt||null,storedAt:storedAt||null})),
    classes};
}
export async function handleGameIsoIconsR2(request,env,now=Date.now()){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return respond({error:"unsupported-query"},400);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)return respond({error:"storage-unavailable"},503);
  try{return respond(await inspectIsoIconsR2(bucket,now));}
  catch{return respond({error:"iso-r2-unavailable"},503);}
}
