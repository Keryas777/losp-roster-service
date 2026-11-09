// Separate, cumulative archive for the static WebApp's guest Evolution page.
// Unlike the seven-day R2 staging prefix, historical WebApp checkpoints never
// age out automatically. One immutable object per Sunday and a dated index.
// Historical observations remain visible to authorized alliance members.
// Current rosterShare controls only new collection, not past checkpoints.
// No additional Scopely/provider requests.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {verifiedDiscord,selectApproved,headers} from "./secure-guest-arena-history.js";
import {activeSharers} from "./secure-guest-evolution.js";

const ROOT="webapp-evolution/v1/";
const STAGING="roster-batches/v1/guest-evolution/";
const DAY=86400000,MAX_BYTES=15000000,MAX_INDEX_BYTES=1500000;
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const FP=/^[a-f0-9]{64}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const PLAYER=/^g_[a-z][a-z0-9-]{1,63}__[a-z0-9]{1,140}$/;
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLowerCase().replace(/[^a-z0-9]/g,"");
const identity=(alliance,name)=>"g_"+alliance+"__"+norm(name);
const reply=(req,data,status=200)=>Response.json(data,{status,headers:headers(req)});
const indexKey=fp=>ROOT+fp+"/index.json";
const checkpointKey=(fp,date)=>ROOT+fp+"/checkpoints/"+date+".json";
const sourceKey=fp=>STAGING+fp+"/rolling.json";
const time=s=>typeof s==="string"?Date.parse(s):NaN;
function isSunday(date){
  if(!DATE.test(date||""))return false;
  const d=new Date(date+"T00:00:00Z");
  return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===date&&
    d.getUTCDay()===0;
}
async function read(bucket,key,limit=MAX_BYTES){
  const item=await bucket.get(key);
  if(!item)return null;
  if(Number.isSafeInteger(item.size)&&item.size>limit)
    throw Error("oversized-archive");
  const raw=await item.text();
  if(raw.length>limit)throw Error("oversized-archive");
  return JSON.parse(raw);
}
async function write(bucket,key,value){
  const body=JSON.stringify(value);
  if(body.length>MAX_BYTES)throw Error("oversized-checkpoint");
  await bucket.put(key,body,{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"}});
}
function validateSnapshot(snapshot,fp,alliance){
  if(!obj(snapshot)||snapshot.version!==1||
     snapshot.fingerprint!==fp||snapshot.allianceKey!==alliance||
     !isSunday(snapshot.date)||!Number.isFinite(time(snapshot.sourceCapturedAt))||
     !Array.isArray(snapshot.players)||snapshot.players.length>40)return false;
  const ids=new Set();
  for(const p of snapshot.players){
    const id=identity(alliance,p?.player);
    if(!PLAYER.test(id)||ids.has(id)||p.alliance!==alliance||
       !obj(p.chars)||!obj(p.iso))return false;
    ids.add(id);
  }
  return true;
}
function validateIndex(index,fp,alliance){
  if(!obj(index)||index.version!==1||index.fingerprint!==fp||
     index.allianceKey!==alliance||!Array.isArray(index.checkpoints)||
     index.checkpoints.length>1000)return false;
  const dates=new Set();
  for(const checkpoint of index.checkpoints){
    if(!isSunday(checkpoint?.date)||dates.has(checkpoint.date)||
       !Number.isFinite(time(checkpoint.sourceCapturedAt))||
       !Array.isArray(checkpoint.players)||checkpoint.players.length>40||
       new Set(checkpoint.players.map(norm)).size!==checkpoint.players.length||
       checkpoint.players.some(x=>typeof x!=="string"||!norm(x)))
      return false;
    dates.add(checkpoint.date);
  }
  return true;
}
function checkpointRecord(snapshot){
  return {date:snapshot.date,sourceCapturedAt:snapshot.sourceCapturedAt,
    players:snapshot.players.map(p=>p.player)};
}
function matchesRecord(snapshot,record){
  return snapshot.date===record.date&&
    snapshot.sourceCapturedAt===record.sourceCapturedAt&&
    snapshot.players.length===record.players.length&&
    snapshot.players.every((p,i)=>p.player===record.players[i]);
}
function blank(fp,alliance){
  return {version:1,fingerprint:fp,allianceKey:alliance,checkpoints:[]};
}
function indexResponse(index,alliance){
  const players={};
  const dates=[];
  for(const c of index.checkpoints){
    let count=0;
    for(const name of c.players){
      const id=identity(alliance,name);
      if(!PLAYER.test(id))continue;
      if(!players[id])players[id]={
        name,currentAlliance:alliance,checkpoints:[]};
      players[id].checkpoints.push(c.date);
      count++;
    }
    if(count)dates.push({date:c.date,players:count,cadence:"weekly",
      sourceCapturedAt:c.sourceCapturedAt});
  }
  return {version:1,players,checkpoints:dates};
}
function rowsResponse(snapshot,alliance,date){
  return {version:1,checkpoint:date,players:(snapshot?.players||[])
    .map(p=>({
      player:p.player,playerKey:identity(alliance,p.player),
      alliance,totalPower:Object.values(p.chars).reduce((sum,c)=>
        sum+(Number.isSafeInteger(c?.power)&&c.power>=0?c.power:0),0)
    }))};
}
function playerResponse(snapshot,alliance,date,id){
  const row=snapshot?.players.find(p=>identity(alliance,p.player)===id);
  return row?{player:row.player,playerKey:id,alliance,checkpoint:date,
    source:{capturedAt:snapshot.sourceCapturedAt},
    chars:row.chars,iso:row.iso}:null;
}
async function approved(env){
  const [guest,losp]=await Promise.all([
    readGuestApprovals(env),readApproval(env)]);
  if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
    throw Error("invalid-approvals");
  const owned=new Set((losp.alliances||[]).map(a=>a.fingerprint));
  return (guest.alliances||[])
    .filter(a=>FP.test(a.fingerprint)&&KEY.test(a.allianceKey||"")&&
      !owned.has(a.fingerprint))
    .sort((a,b)=>a.allianceKey.localeCompare(b.allianceKey));
}
// Called just AFTER the existing Sunday/daily staging tick, with no provider
// calls. Imports immutable real checkpoints into an independent WebApp archive.
// If the staging object is later rotated, the archive remains intact.
export async function archivePermanentGuestEvolutionTick(env,now=Date.now()){
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put||
     !Number.isFinite(now))return {status:"disabled"};
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
    weekday:"short"}).formatToParts(new Date(now))
    .filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  const hour=Number(parts.hour),minute=Number(parts.minute);
  const sunday=parts.weekday==="Sun";
  if(!(sunday&&hour===23)&&hour!==11)
    return {status:"outside-window"};
  try{
    const list=await approved(env);
    if(list.length>60)return {status:"too-many-guests"};
    const index=sunday&&hour===23&&list.length<=30?minute%30:minute;
    if(index>=list.length)return {status:"idle"};
    const selected=list[index],bucket=env.CAPTAIN_BUCKET;
    // Refuse copies of a checkpoint after withdrawal or without fresh Infos.
    const allowed=await activeSharers(bucket,selected.fingerprint,now);
    if(!allowed)return {status:"consent-not-verifiable"};
    const staging=await read(bucket,sourceKey(selected.fingerprint));
    if(!staging)return {status:"staging-not-ready"};
    if(staging?.version!==1||staging.fingerprint!==selected.fingerprint||
       staging.allianceKey!==selected.allianceKey||
       !Array.isArray(staging.checkpoints))
      return {status:"invalid-staging"};
    const original=await read(bucket,indexKey(selected.fingerprint),MAX_INDEX_BYTES);
    if(original&&!validateIndex(original,selected.fingerprint,selected.allianceKey))
      return {status:"invalid-index"};
    const updated=original?structuredClone(original):
      blank(selected.fingerprint,selected.allianceKey);
    const recorded=new Map(updated.checkpoints.map(c=>[c.date,c]));
    // Each immutable checkpoint is written BEFORE its index entry.
    // A failed index write leaves a recoverable orphan. The next tick
    // validates and adopts the existing bytes instead of overwriting them.
    let added=0,recovered=0;
    for(const c of staging.checkpoints){
      if(added>=2)break;
      if(!isSunday(c?.date)||!Array.isArray(c.players))
        return {status:"invalid-checkpoint"};
      const path=checkpointKey(selected.fingerprint,c.date);
      const prior=recorded.get(c.date);
      const saved=await read(bucket,path);
      if(prior){
        // An index pointing to absent/corrupt content is an integrity alarm.
        // Never silently re-create an indexed historical observation.
        if(!validateSnapshot(saved,selected.fingerprint,selected.allianceKey)||
           !matchesRecord(saved,prior))
          return {status:"archive-integrity-error"};
        continue;
      }
      let snapshot=saved;
      if(snapshot){
        // Orphan from a crash after checkpoint PUT but before index PUT.
        // Adopt the original immutable observation, even if the latest
        // rosterShare/census excludes some past members. Historical reads
        // retain the consent-valid observation captured at that date.
        if(!validateSnapshot(snapshot,selected.fingerprint,selected.allianceKey)||
           snapshot.date!==c.date||
           snapshot.sourceCapturedAt!==c.sourceCapturedAt)
          return {status:"orphan-conflict"};
        recovered++;
      }else{
        snapshot={version:1,fingerprint:selected.fingerprint,
          allianceKey:selected.allianceKey,date:c.date,
          sourceCapturedAt:c.sourceCapturedAt,
          players:c.players};
        if(!validateSnapshot(snapshot,selected.fingerprint,selected.allianceKey))
          return {status:"invalid-checkpoint"};
        if(!snapshot.players.length)continue;
        await write(bucket,path,snapshot);
      }
      const record=checkpointRecord(snapshot);
      updated.checkpoints.push(record);
      recorded.set(record.date,record);
      added++;
    }
    if(!added)return {status:"unchanged",count:updated.checkpoints.length};
    updated.checkpoints.sort((a,b)=>a.date.localeCompare(b.date));
    const encoded=JSON.stringify(updated);
    if(encoded.length>MAX_INDEX_BYTES)throw Error("index-too-large");
    await write(bucket,indexKey(selected.fingerprint),updated);
    return {status:recovered?"recovered":"archived",
      added,recovered,total:updated.checkpoints.length};
  }catch{
    return {status:"unavailable"};
  }
}
export async function securePermanentGuestEvolution(request,env,
  now=Date.now(),fetchImpl=fetch){
  if(request.method==="OPTIONS")
    return new Response(null,{status:request.headers.get("Origin")===
      "https://keryas777.github.io"?204:403,headers:headers(request)});
  if(request.method!=="GET")return reply(request,{status:"method-not-allowed"},405);
  if(request.headers.get("Origin")&&
     request.headers.get("Origin")!=="https://keryas777.github.io")
    return reply(request,{status:"forbidden-origin"},403);
  const query=new URL(request.url).searchParams,view=query.get("view");
  const alliance=query.get("alliance");
  const required=view==="index"?["alliance","view"]:
    view==="group"?["alliance","date","view"]:
    view==="player"?["alliance","date","playerKey","view"]:null;
  if(!required||[...query.keys()].sort().join(",")!==required.join(",")||
     required.some(k=>query.getAll(k).length!==1)||
     !KEY.test(alliance||"")||
     (view!=="index"&&!isSunday(query.get("date")))||
     (view==="player"&&!PLAYER.test(query.get("playerKey")||"")))
    return reply(request,{status:"invalid-query"},400);
  if(!env?.CAPTAIN_BUCKET?.get||!env?.LOSP_AUTH?.fetch)
    return reply(request,{status:"unavailable"},503);
  const verifiedFetch=fetchImpl===fetch?
    (...args)=>env.LOSP_AUTH.fetch(...args):fetchImpl;
  const auth=await verifiedDiscord(request,verifiedFetch);
  if(auth.status!=="ok")return reply(request,{status:auth.status},
    auth.status==="unauthorized"?401:503);
  if(!auth.allowed.has(alliance))return reply(request,{status:"forbidden"},403);
  try{
    const [guest,losp]=await Promise.all([
      readGuestApprovals(env),readApproval(env)]);
    const approved=selectApproved(guest,losp,[alliance]);
    if(!approved)return reply(request,{
      status:"alliance-not-bound-or-not-approved"},409);
    const fp=approved[0].fingerprint,bucket=env.CAPTAIN_BUCKET;
    const index=await read(bucket,indexKey(fp),MAX_INDEX_BYTES)||blank(fp,alliance);
    if(!validateIndex(index,fp,alliance))return reply(request,{
      status:"archive-not-verified"},503);
    let answer;
    if(view==="index")answer={index:indexResponse(index,alliance)};
    else{
      const date=query.get("date");
      if(!index.checkpoints.some(c=>c.date===date))
        return reply(request,{status:"checkpoint-not-found"},404);
      const snapshot=await read(bucket,checkpointKey(fp,date));
      if(!validateSnapshot(snapshot,fp,alliance)||
         snapshot.date!==date)
        return reply(request,{status:"archive-not-verified"},503);
      answer=view==="group"?
        {group:rowsResponse(snapshot,alliance,date)}:
        {snapshot:playerResponse(snapshot,alliance,date,
          query.get("playerKey"))};
    }
    return reply(request,{status:"ok",version:1,
      kind:"authorized-guest-evolution",alliance,view,
      historyPolicy:"checkpoint-archive",...answer});
  }catch{return reply(request,{status:"unavailable"},503);}
}
