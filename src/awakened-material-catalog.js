// Public, read-only subset of the /game/v1 archive: awakened ability material
// icons only. Never exports private R2 keys, source payloads or player data.
// Historical V2 audit seeds the catalog; verified weekly differential receipts
// incrementally refresh it, without a separate Scopely GET or full R2 rescan.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
import {collectMaterials} from "./game-material-audit.js";

const ROOT=GAME_ARCHIVE_ROOT;
const DELTA=ROOT+"materials/public/v1/differential.json";
const ACTIVE=ROOT+"active.json";
const MAX_AGE=30*86400000,MAX_STATE=500000;
const ID=/^ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_(.+)_(BASIC|SPECIAL|ULTIMATE|PASSIVE)$/;
const ICON=/^https:\/\/assets\.marvelstrikeforce\.com\/(?:imgs|key_art)\/[A-Za-z0-9_./%-]{1,240}\.(?:png|webp|jpg|jpeg)$/i;
const HASH=/^[a-f0-9]{64}$/;
const RUN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const clean=(s,max)=>typeof s==="string"&&s.length>0&&s.length<=max&&
  !/[\u0000-\u001f\u007f]/.test(s)?s:null;
const timestamp=t=>typeof t==="string"?Date.parse(t):NaN;
const fresh=(t,now)=>Number.isFinite(timestamp(t))&&
  timestamp(t)<=now+300000&&now-timestamp(t)<MAX_AGE;
const validIcon=x=>typeof x==="string"&&ICON.test(x);
const response=(data,code=200)=>Response.json(data,{status:code,headers:{
  "Access-Control-Allow-Origin":"*","Cache-Control":"public, max-age=60",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"
}});
async function read(b,key,max=MAX_STATE){
  const object=await b.get(key);
  if(!object)return null;
  if(!Number.isFinite(object.size)||object.size>max)throw Error("oversized-catalog");
  const raw=await object.text();
  if(new TextEncoder().encode(raw).byteLength>max)throw Error("oversized-catalog");
  return JSON.parse(raw);
}
const write=(b,key,doc)=>b.put(key,JSON.stringify(doc),{
  httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
});
const validId=id=>typeof id==="string"&&ID.test(id);
function record(id,metadata,sourceSha,storedAt){
  const parts=ID.exec(id);
  if(!parts||!validIcon(metadata?.icon)||!HASH.test(sourceSha||""))
    return null;
  return {id,characterId:parts[1],abilityType:parts[2],
    name:clean(metadata.name,220),description:clean(metadata.description,900),
    iconUrl:metadata.icon,sourceSha256:sourceSha,storedAt};
}
function publicItem(item){
  return {id:item.id,characterId:item.characterId,
    abilityType:item.abilityType,name:item.name||null,
    description:item.description||null,iconUrl:item.iconUrl};
}
// Called ONLY after the game differential has verified the source blob, the
// receipt, and the latest pointer. This does not affect the existing collector.
export async function noteAwakenedMaterials(bucket,document,receipt,now=Date.now()){
  if(!bucket?.get||!bucket?.put||!receipt||
     !fresh(receipt.storedAt,now)||!HASH.test(receipt.sha256||""))
    return {status:"ignored"};
  const observed=collectMaterials(document);
  const entries=[];
  for(const [id,variants] of Object.entries(observed.metadata)){
    if(!validId(id))continue;
    const best=variants.find(x=>validIcon(x.icon));
    const item=record(id,best,receipt.sha256,receipt.storedAt);
    if(item)entries.push(item);
  }
  if(!entries.length)return {status:"no-awakened-materials"};
  const prior=await read(bucket,DELTA);
  if(prior&&prior.version!==1)throw Error("invalid-catalog-version");
  const items={};
  for(const [id,item] of Object.entries(prior?.items||{})){
    if(validId(id)&&item?.id===id&&validIcon(item.iconUrl)&&
       fresh(item.storedAt,now)&&HASH.test(item.sourceSha256||""))
      items[id]=item;
  }
  for(const entry of entries){
    const old=items[entry.id];
    if(!old||timestamp(entry.storedAt)>=timestamp(old.storedAt))
      items[entry.id]=entry;
  }
  await write(bucket,DELTA,{version:1,updatedAt:new Date(now).toISOString(),items});
  return {status:"updated",count:entries.length};
}

export async function publicAwakenedMaterials(request,env,now=Date.now()){
  if(request.method!=="GET")return response({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return response({error:"unsupported-query"},400);
  if(!env?.CAPTAIN_BUCKET?.get)return response({error:"unavailable"},503);
  try{
    const b=env.CAPTAIN_BUCKET;
    const active=await read(b,ACTIVE,4096);
    // Only the active initial archive may provide the baseline; never read
    // arbitrary paths from URL or expose audit state to the browser.
    const audit=RUN.test(active?.runId||"")?
      await read(b,ROOT+"runs/"+active.runId+"/material-audit/v1/progress.json",3000000):null;
    const delta=await read(b,DELTA);
    const result=new Map();
    if(audit?.version===2&&audit.status==="snapshot-complete"&&
       fresh(audit.finishedAt,now)&&timestamp(audit.expiresAt)>now){
      for(const [id,item] of Object.entries(audit.items||{})){
        if(!validId(id))continue;
        const best=[...(item?.metadata||[])].find(x=>validIcon(x.icon));
        const sourceSha=best?.sampleSha256;
        const storedAt=best?.sampleUploadedAt;
        if(!fresh(storedAt,now))continue;
        const entry=record(id,best,sourceSha,storedAt);
        if(entry)result.set(id,entry);
      }
    }
    if(delta?.version===1){
      for(const [id,item] of Object.entries(delta.items||{})){
        if(!validId(id)||item?.id!==id||!validIcon(item.iconUrl)||
           !fresh(item.storedAt,now)||!HASH.test(item.sourceSha256||""))
          continue;
        const old=result.get(id);
        if(!old||timestamp(item.storedAt)>=timestamp(old.storedAt))
          result.set(id,item);
      }
    }
    const materials=[...result.values()].map(publicItem)
      .sort((a,b)=>a.id.localeCompare(b.id));
    // A known empty catalog must not be represented as an empty successful
    // source of truth: this catches missing bootstrap or expired data.
    if(!materials.length)return response({status:"unavailable",materials:[],
      note:"No fresh, validated ability-material catalog"},503);
    return response({schemaVersion:1,status:"ok",
      source:"Scopely /game/v1 via LoSP R2",
      updatedAt:delta?.updatedAt||audit?.finishedAt||null,
      count:materials.length,materials});
  }catch{return response({error:"catalog-unavailable"},503);}
}
