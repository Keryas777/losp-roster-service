// Public, rank-only Arena projection from PRIVATE R2 Infos receipts.
// No Scopely requests, no OAuth/member IDs, no private R2 key exposure.
// Source receipts already exist under the 7-day roster-batches lifecycle.
// Temporary R2 views retain their existing lifecycle; the permanent public
// archive is published to GitHub Pages from a separate rank-only projection.
import {readApproval} from "./roster-sync-preflight.js";
import {readCollectibleApprovals,readGuestApprovals} from "./guest-alliance-approvals.js";

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
function utcParts(ms){
  if(!Number.isFinite(ms))throw Error("invalid-clock");
  const date=new Date(ms);
  return {day:date.toISOString().slice(0,10),
    hour:date.getUTCHours(),minute:date.getUTCMinutes()};
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
async function snapshot(bucket,fps,sourceDay,kind,now,guestKeys=null){
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
  // Private guest archive ONLY: tag each real receipt with the approved
  // stable alliance key. This prevents lookalike/duplicate names from
  // allowing a different guest's rank to cross tenant boundaries.
  const players=receipts.flatMap((x,i)=>x.rows.map(row=>
    guestKeys?.get(fps[i])?{...row,allianceKey:guestKeys.get(fps[i])}:row));
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
       (!dates.has(item.date)||
         (dates.get(item.date)?.sourceKind==="onboarding"&&
          item.sourceKind==="reward")))dates.set(item.date,item);
  }
  return {version:1,retentionDays:30,generatedAt:new Date().toISOString(),
    snapshots:[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date))};
}
export async function buildArenaHistory(env,now=Date.now(),scope="losp"){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)throw Error("storage-unavailable");
  const today=utcParts(now).day;
  const fps=await fingerprints(env,scope);
  if(!fps||!fps.length)throw Error("no-approved-alliances");
  const guestKeys=scope==="guest"?
    new Map((await readGuestApprovals(env)).alliances
      .filter(a=>a.allianceKey).map(a=>[a.fingerprint,a.allianceKey])):null;
  const previous=await json(bucket,scope==="guest"?GUEST_HISTORY_KEY:HISTORY_KEY,2400000);
  if(previous&&(previous.version!==1||!Array.isArray(previous.snapshots)))
    throw Error("invalid-existing-history");
  const incoming=[];
  // Immutable first source: 2026-11-01 AM is deliberately attributed to
  // 2026-10-31, NOT represented as an observation made on October 31.
  if(today>=FIRST_SOURCE_DAY&&today<=dateOffset(FIRST_SOURCE_DAY,6)&&
     !(previous?.snapshots||[]).some(s=>s.date===INITIAL_DAY)){
    const base=await snapshot(bucket,fps,FIRST_SOURCE_DAY,"am",now,guestKeys);
    if(base)incoming.push(base);
  }
  for(const day of [dateOffset(today,-1),today]){
    if(day<FIRST_SOURCE_DAY||day>today)continue;
    if((previous?.snapshots||[]).some(s=>s.date===day&&s.sourceKind!=="onboarding"))continue;
    const point=await snapshot(bucket,fps,day,"reward",now,guestKeys);
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
// The 17:01 reward collection has already persisted source receipts in R2.
// On the first quiet minute after completion, promote *each scope* as soon
// as all of its own approved alliances have valid receipts for TODAY. Guests
// never block LoSP and are NEVER added to its public history.
async function archiveScope(env,now,scope,whenReady=false){
  try{
    const bucket=env.CAPTAIN_BUCKET;
    const key=scope==="guest"?GUEST_HISTORY_KEY:HISTORY_KEY;
    if(whenReady){
      const day=utcParts(now).day;
      const saved=await json(bucket,key,2400000);
      if(saved&&(saved.version!==1||!Array.isArray(saved.snapshots)))
        throw Error("invalid-existing-history");
      if(saved?.snapshots?.some(s=>s.date===day&&s.sourceKind==="reward"))
        return {status:"unchanged",snapshots:saved.snapshots.length};
      const fps=await fingerprints(env,scope);
      if(!fps?.length)return {status:"unavailable"};
      // Read the R2 receipts only; do not call the Scopely API again.
      if(!await snapshot(bucket,fps,day,"reward",now))
        return {status:"awaiting-receipts"};
    }
    const history=await buildArenaHistory(env,now,scope);
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
async function archiveBothScopes(env,now,whenReady){
  const losp=await archiveScope(env,now,"losp",whenReady);
  try{
    const registry=await readCollectibleApprovals(env);
    if(!registry.guestAlliances?.length)return losp;
    const guest=await archiveScope(env,now,"guest",whenReady);
    return {...losp,guestStatus:guest.status,guestSnapshots:guest.snapshots};
  }catch{return {...losp,guestStatus:"unavailable"};}
}
// Called after a quiet collector tick. All windows and campaign dates are UTC.
export async function archiveArenaHistoryWhenReady(env,now=Date.now()){
  const local=utcParts(now);
  const minute=local.hour*60+local.minute;
  if(minute<16*60+1||minute>=19*60+17)
    return {status:"outside-window"};
  return archiveBothScopes(env,now,true);
}
// Keep two UTC-only R2 recovery consolidations as a fallback.
export async function archiveArenaHistory(env,now=Date.now()){
  const local=utcParts(now);
  if(!([19,21].includes(local.hour)&&local.minute===17))
    return {status:"outside-window"};
  return archiveBothScopes(env,now,false);
}


// Capture a genuine "current at onboarding" Arena observation as soon as
// AM/PM Infos receipts are collected. Never label it as the 17:01 reward.
// The later real reward snapshot replaces this initial point for that date.
export async function archiveGuestInitialArena(env,fp,allianceKey,now=Date.now()){
  if(!FP.test(fp||"")||!/^[a-z][a-z0-9-]{1,63}$/.test(allianceKey||"")||
     !Number.isFinite(now)||!env?.CAPTAIN_BUCKET?.get||
     !env.CAPTAIN_BUCKET.put)return {status:"invalid-input"};
  const bucket=env.CAPTAIN_BUCKET;
  try{
    const guest=await readGuestApprovals(env);
    const approved=await readCollectibleApprovals(env);
    if(guest.status!=="configured"||approved.status!=="configured"||
       !approved.guestAlliances?.some(a=>a.fingerprint===fp)||
       !guest.alliances.some(a=>a.fingerprint===fp&&a.allianceKey===allianceKey))
      return {status:"not-approved-and-bound"};
    const todayUtc=new Date(now).toISOString().slice(0,10);
    let source=null,sourceDay=null,sourceProfiles=[];
    for(const day of [todayUtc,dateOffset(todayUtc,-1)]){
      for(const period of ["pm","am"]){
        const campaign=day+"-"+period;
        const raw=await json(bucket,ROOT+fp+"/campaigns/"+campaign+"-infos.json");
        const valid=raw&&sanitizeReceipt(raw,fp,day,period,now);
        if(valid){source=valid;sourceDay=day;sourceProfiles=raw.rows;break;}
      }
      if(source)break;
    }
    if(!source)return {status:"awaiting-infos"};
    // Keep available portraits/frames in the PRIVATE baseline only.
    // The signed Arena endpoint still validates every asset host/path.
    const media=new Map(sourceProfiles.filter(x=>
      typeof x?.name==="string").map(x=>[x.name,x]));
    const players=source.rows.map(row=>{
      const profile=media.get(row.name);
      return {...row,allianceKey,
        ...(typeof profile?.icon==="string"?{icon:profile.icon}:{}),
        ...(typeof profile?.frame==="string"?{frame:profile.frame}:{})};
    });
    if(!players.length)return {status:"awaiting-arena-ranks"};
    const today=utcParts(now).day;
    const previous=await json(bucket,GUEST_HISTORY_KEY,2400000);
    if(previous&&(previous.version!==1||!Array.isArray(previous.snapshots)))
      return {status:"invalid-history"};
    const saved=previous?.snapshots.find(s=>s.date===today);
    if(saved?.sourceKind==="reward")return {status:"already-reward-captured"};
    if(saved&&saved.sourceKind!=="onboarding")
      return {status:"existing-historical-observation"};
    const retained=(saved?.players||[]).filter(p=>p.allianceKey!==allianceKey);
    const combined=retained.concat(players);
    if(combined.length>500)return {status:"too-many-players"};
    const point={date:today,sourceDay,
      attribution:"onboarding-current-observation",sourceKind:"onboarding",
      alliancesComplete:new Set(combined.map(x=>x.allianceKey)).size,
      capturedAt:source.capturedAt,players:combined};
    const snapshots=(previous?.snapshots||[])
      .filter(s=>s.date!==today).concat(point)
      .filter(s=>s.date>=earliest(today)&&s.date<=today)
      .sort((a,b)=>a.date.localeCompare(b.date));
    const output={version:1,retentionDays:30,generatedAt:new Date(now).toISOString(),
      snapshots};
    const encoded=JSON.stringify(output);
    if(encoded.length>2000000)return {status:"oversized-history"};
    if(JSON.stringify(saved)===JSON.stringify(point))
      return {status:"unchanged"};
    await bucket.put(GUEST_HISTORY_KEY,encoded,{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    return {status:"updated",players:players.length};
  }catch{return {status:"unavailable"};}
}
