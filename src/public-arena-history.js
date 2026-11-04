// Public, rank-only Arena projection from PRIVATE R2 Infos receipts.
// No Scopely requests, no OAuth/member IDs, no private R2 key exposure.
// Source receipts already exist under the 7-day roster-batches lifecycle.
// Rolling history uses the SAME lifecycle prefix, is trimmed to 30 dates,
// and is rebuilt on the existing every-minute cron at local 20:17 / 22:17.
import {readApproval} from "./roster-sync-preflight.js";
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";

const ROOT="roster-batches/v1/";
const HISTORY_KEY=ROOT+"arena-history/rolling.json";
// Private-only guest history. Never exposed by /api/public/arena-history.
const GUEST_HISTORY_KEY=ROOT+"guest-arena-history/rolling.json";
const INITIAL_DAY="2026-10-31",FIRST_SOURCE_DAY="2026-11-01";
const DAY_RE=/^\d{4}-\d{2}-\d{2}$/;
const FP=/^[a-f0-9]{64}$/;
const HEADERS={"Content-Type":"application/json; charset=utf-8",
  "Access-Control-Allow-Origin":"*","Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff"};
const validDay=day=>DAY_RE.test(day||"")&&
  new Date(day+"T00:00:00Z").toISOString().slice(0,10)===day;
const dateOffset=(day,n)=>{
  const dt=new Date(day+"T00:00:00Z");dt.setUTCDate(dt.getUTCDate()+n);
  return dt.toISOString().slice(0,10);
};
function parisParts(ms){
  if(!Number.isFinite(ms))throw Error("invalid-clock");
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(new Date(ms)).filter(p=>
    ["year","month","day","hour","minute"].includes(p.type)
  ).map(p=>[p.type,p.value]));
  return {day:parts.year+"-"+parts.month+"-"+parts.day,
    hour:Number(parts.hour),minute:Number(parts.minute)};
}
function earliest(day){return dateOffset(day,-29);}
function safeText(value,max=140){
  return typeof value==="string"&&value.trim()&&value.length<=max?
    value.trim():null;
}
async function json(bucket,key,max=240000){
  const item=await bucket.get(key);
  if(!item)return null;
  if(Number.isSafeInteger(item.size)&&item.size>max)return null;
  const raw=await item.text();
  if(raw.length>max)return null;
  return JSON.parse(raw);
}
async function fingerprints(env,scope="losp"){
  const approval=scope==="guest"?
    await readCollectibleApprovals(env):await readApproval(env);
  if(approval.status!=="configured"||!approval.alliances.length)return null;
  const entries=scope==="guest"?approval.guestAlliances:approval.alliances;
  const list=entries.map(x=>x.fingerprint);
  if(list.length>30||list.some(x=>!FP.test(x))||
    new Set(list).size!==list.length)return null;
  return list;
}
function sanitizeReceipt(receipt,fp,day,kind,now){
  const campaign=day+"-"+kind;
  if(receipt?.version!==1||receipt.kind!==
    (kind==="reward"?"alliance-infos-reward":"alliance-infos-campaign")||
    receipt.campaign!==campaign||receipt.allianceFingerprint!==fp||
    !Array.isArray(receipt.rows)||receipt.rows.length>100||
    !safeText(receipt.allianceName)||!Number.isFinite(Date.parse(receipt.expiresAt))||
    Date.parse(receipt.expiresAt)<=now)return null;
  const times=new Map();
  if(kind==="reward"&&Array.isArray(receipt.observedAt)){
    for(const item of receipt.observedAt){
      if(safeText(item?.name)&&Number.isFinite(Date.parse(item.at)))
        times.set(item.name,item.at);
    }
  }
  const rows=[];
  for(const r of receipt.rows){
    const name=safeText(r?.name);
    if(!name||!Number.isSafeInteger(r.latestArena)||r.latestArena<1)continue;
    rows.push({name,alliance:receipt.allianceName,arenaRank:r.latestArena,
      ...(times.has(name)?{observedAt:times.get(name)}:{})});
  }
  return {rows,capturedAt:receipt.capturedAt||null};
}
async function snapshot(bucket,fps,sourceDay,kind,now){
  if(!validDay(sourceDay))return null;
  const receipts=await Promise.all(fps.map(async fp=>{
    try{
      const key=ROOT+fp+"/campaigns/"+sourceDay+"-"+kind+"-infos.json";
      const raw=await json(bucket,key);
      return sanitizeReceipt(raw,fp,sourceDay,kind,now);
    }catch{return null;}
  }));
  // Never label a date as complete if even one alliance has no valid receipt.
  if(receipts.some(x=>!x))return null;
  const players=receipts.flatMap(x=>x.rows);
  if(!players.length||players.length>500)return null;
  const day=kind==="am"?INITIAL_DAY:sourceDay;
  return {date:day,sourceDay,
    attribution:kind==="am"?"backdated-from-first-next-day-collection":
      "after-daily-arena-rewards",
    sourceKind:kind,alliancesComplete:fps.length,
    capturedAt:receipts.map(x=>x.capturedAt).filter(Boolean).sort().at(-1)||null,
    players};
}
export function mergeArenaHistory(history,incoming,today){
  if(!validDay(today))throw Error("invalid-date");
  const first=earliest(today),dates=new Map();
  for(const value of history?.snapshots||[]){
    if(value?.date>=first&&value?.date<=today&&
       Array.isArray(value.players)&&value.players.length<=500)
      dates.set(value.date,value);
  }
  for(const item of incoming){
    if(item?.date>=first&&item?.date<=today&&
       Array.isArray(item.players)&&item.players.length<=500&&
       !dates.has(item.date))dates.set(item.date,item);
  }
  return {version:1,retentionDays:30,generatedAt:new Date().toISOString(),
    snapshots:[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date))};
}
export async function buildArenaHistory(env,now=Date.now(),scope="losp"){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)throw Error("storage-unavailable");
  const today=parisParts(now).day;
  const fps=await fingerprints(env,scope);
  if(!fps||!fps.length)throw Error("no-approved-alliances");
  const previous=await json(bucket,scope==="guest"?GUEST_HISTORY_KEY:HISTORY_KEY,2400000);
  if(previous&&(previous.version!==1||!Array.isArray(previous.snapshots)))
    throw Error("invalid-existing-history");
  const incoming=[];
  // Immutable first source: 2026-11-01 AM is deliberately attributed to
  // 2026-10-31, NOT represented as an observation made on October 31.
  if(today>=FIRST_SOURCE_DAY&&today<=dateOffset(FIRST_SOURCE_DAY,6)&&
     !(previous?.snapshots||[]).some(s=>s.date===INITIAL_DAY)){
    const base=await snapshot(bucket,fps,FIRST_SOURCE_DAY,"am",now);
    if(base)incoming.push(base);
  }
  for(const day of [dateOffset(today,-1),today]){
    if(day<FIRST_SOURCE_DAY||day>today)continue;
    if((previous?.snapshots||[]).some(s=>s.date===day))continue;
    const point=await snapshot(bucket,fps,day,"reward",now);
    if(point)incoming.push(point);
  }
  return mergeArenaHistory(previous,incoming,today);
}
export async function publicArenaHistory(request,env,now=Date.now()){
  if(request.method!=="GET")return Response.json({status:"method-not-allowed"},
    {status:405,headers:HEADERS});
  try{
    const data=await buildArenaHistory(env,now);
    return Response.json(data,{headers:HEADERS});
  }catch{
    return Response.json({status:"unavailable",snapshots:[]},
      {status:503,headers:HEADERS});
  }
}
async function archiveScope(env,now,scope){
  try{
    const history=await buildArenaHistory(env,now,scope);
    const bucket=env.CAPTAIN_BUCKET;
    const key=scope==="guest"?GUEST_HISTORY_KEY:HISTORY_KEY;
    const previous=await json(bucket,key,2400000);
    if(JSON.stringify(previous?.snapshots||[])===JSON.stringify(history.snapshots))
      return {status:"unchanged",snapshots:history.snapshots.length};
    const raw=JSON.stringify(history);
    if(raw.length>2000000)throw Error("oversized-history");
    await bucket.put(key,raw,{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    return {status:"updated",snapshots:history.snapshots.length};
  }catch{return {status:"unavailable"};}
}
export async function archiveArenaHistory(env,now=Date.now()){
  const local=parisParts(now);
  if(!([20,22].includes(local.hour)&&local.minute===17))
    return {status:"outside-window"};
  const losp=await archiveScope(env,now,"losp");
  try{
    const registry=await readCollectibleApprovals(env);
    if(!registry.guestAlliances?.length)return losp;
    const guest=await archiveScope(env,now,"guest");
    return {...losp,guestStatus:guest.status,guestSnapshots:guest.snapshots};
  }catch{return {...losp,guestStatus:"unavailable"};}
}
