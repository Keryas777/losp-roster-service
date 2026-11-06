// Private, weekly guest Evolution checkpoints. Existing R2-only cron; no Scopely calls.
// The 7-day lifecycle is refreshed daily, but individual observations are removed
// before 30 days and immediately excluded from reads when consent is absent.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {verifiedDiscord,selectApproved,headers} from "./secure-guest-arena-history.js";
import {projectAlliance} from "./secure-guest-rosters.js";

const ROOT="roster-batches/v1/guest-evolution/";
const DAY=86400000, MAX_AGE=29*DAY, SOURCE_AGE=7*DAY;
const MAX_BYTES=15000000, MAX_INFO_BYTES=200000, MAX_GROUP=40;
const KEY=/^[a-z][a-z0-9-]{1,63}$/,DATE=/^\d{4}-\d{2}-\d{2}$/;
const PLAYER=/^g_[a-z][a-z0-9-]{1,63}__[a-z0-9]{1,140}$/;
const valid=x=>x&&typeof x==="object"&&!Array.isArray(x);
const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLowerCase().replace(/[^a-z0-9]/g,"");
const reply=(req,obj,status=200)=>Response.json(obj,{status,headers:headers(req)});
const archiveKey=fp=>ROOT+fp+"/rolling.json";
const dateMs=s=>typeof s==="string"&&Number.isFinite(Date.parse(s))?
  Date.parse(s):NaN;
const localParts=ms=>Object.fromEntries(
  new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Paris",
    year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"})
    .formatToParts(new Date(ms)).filter(p=>p.type!=="literal")
    .map(p=>[p.type,p.value]));
const localDay=ms=>{const p=localParts(ms);return p.year+"-"+p.month+"-"+p.day;};
const identity=(alliance,name)=>"g_"+alliance+"__"+norm(name);
async function read(bucket,path,max=MAX_BYTES){
  const obj=await bucket.get(path);
  if(!obj)return null;
  if(Number.isSafeInteger(obj.size)&&obj.size>max)throw Error("oversized-r2");
  const value=await obj.text();
  if(value.length>max)throw Error("oversized-r2");
  return JSON.parse(value);
}
function validArchive(data,fp,key){
  if(!valid(data)||data.version!==1||data.fingerprint!==fp||
     data.allianceKey!==key||!Array.isArray(data.checkpoints)||
     data.checkpoints.length>6)return false;
  const days=new Set();
  for(const snap of data.checkpoints){
    if(!DATE.test(snap?.date||"")||
       new Date(snap.date+"T00:00:00Z").getUTCDay()!==0||
       days.has(snap.date)||!Number.isFinite(dateMs(snap.sourceCapturedAt))||
       !Array.isArray(snap.players)||snap.players.length>MAX_GROUP)return false;
    days.add(snap.date);
    const names=new Set();
    for(const p of snap.players){
      if(!valid(p)||p.alliance!==key||typeof p.player!=="string"||
         !norm(p.player)||norm(p.player).length>140||
         names.has(norm(p.player))||!valid(p.chars)||!valid(p.iso))
        return false;
      names.add(norm(p.player));
    }
  }
  return true;
}
function recent(snap,now){
  const source=dateMs(snap.sourceCapturedAt);
  const day=Date.parse(snap.date+"T00:00:00Z");
  // At most 29 days from REAL source capture, never from rewritten R2 timestamp.
  return Number.isFinite(source)&&source<=now&&source>=now-MAX_AGE&&
    day<=now&&localDay(source)===snap.date;
}
async function activeSharers(bucket,fp,now){
  const utc=new Date(now).toISOString().slice(0,10)+"T00:00:00Z";
  const base=Date.parse(utc);
  for(let delta=0;delta<=7;delta++){
    const day=new Date(base-delta*DAY).toISOString().slice(0,10);
    for(const slot of ["pm","am"]){
      const campaign=day+"-"+slot;
      const source=await read(bucket,"roster-batches/v1/"+fp+
        "/campaigns/"+campaign+"-infos.json",MAX_INFO_BYTES);
      if(!source)continue;
      if(source.version!==1||source.kind!=="alliance-infos-campaign"||
         source.allianceFingerprint!==fp||source.campaign!==campaign||
         !Array.isArray(source.rows)||source.rows.length>100||
         !Number.isFinite(dateMs(source.capturedAt))||
         dateMs(source.capturedAt)>now||
         dateMs(source.capturedAt)<now-SOURCE_AGE||
         !(dateMs(source.expiresAt)>now))return null;
      const allowed=new Set(),seen=new Set();
      for(const p of source.rows){
        const name=norm(p?.name);
        if(!name||seen.has(name)||typeof p.rosterShare!=="boolean")
          return null;
        seen.add(name);
        if(p.rosterShare)allowed.add(name);
      }
      return allowed;
    }
  }
  return null;
}
function sanitized(archive,fp,key,now,allowed){
  if(archive&&!validArchive(archive,fp,key))throw Error("invalid-archive");
  const checkpoints=(archive?.checkpoints||[])
    .filter(x=>recent(x,now))
    .map(x=>({...x,players:x.players.filter(p=>allowed.has(norm(p.player)))}))
    .filter(x=>x.players.length)
    .sort((a,b)=>a.date.localeCompare(b.date));
  return {version:1,fingerprint:fp,allianceKey:key,
    updatedAt:new Date(now).toISOString(),checkpoints};
}
function toIndex(archive,key){
  const players={};
  for(const snap of archive.checkpoints){
    for(const p of snap.players){
      const id=identity(key,p.player);
      if(!PLAYER.test(id))continue;
      if(!players[id])players[id]={name:p.player,currentAlliance:key,checkpoints:[]};
      players[id].checkpoints.push(snap.date);
    }
  }
  return {version:1,checkpoints:archive.checkpoints.map(s=>({
    date:s.date,players:s.players.length,cadence:"weekly",
    sourceCapturedAt:s.sourceCapturedAt})),players};
}
function toGroup(archive,key,day){
  const snap=archive.checkpoints.find(s=>s.date===day);
  return {version:1,checkpoint:day,players:(snap?.players||[]).map(p=>({
    player:p.player,playerKey:identity(key,p.player),alliance:key,
    totalPower:Object.values(p.chars).reduce((sum,c)=>
      sum+(Number.isSafeInteger(c?.power)&&c.power>=0?c.power:0),0)
  }))};
}
function toPlayer(archive,key,day,id){
  const snap=archive.checkpoints.find(s=>s.date===day);
  const row=snap?.players.find(p=>identity(key,p.player)===id);
  return row?{player:row.player,playerKey:id,alliance:key,
    checkpoint:day,source:{capturedAt:snap.sourceCapturedAt},
    chars:row.chars,iso:row.iso}:null;
}
async function approved(env){
  const [guest,losp]=await Promise.all([readGuestApprovals(env),readApproval(env)]);
  if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
    throw Error("invalid-approvals");
  const owned=new Set((losp.alliances||[]).map(a=>a.fingerprint));
  return (guest.alliances||[])
    .filter(a=>KEY.test(a.allianceKey||"")&&!owned.has(a.fingerprint))
    .sort((a,b)=>a.allianceKey.localeCompare(b.allianceKey));
}
// Invoked by the EXISTING minute Cron; one guest per slot, no new scheduler
// or provider GET. Daily rotation keeps the private 7-day R2 object alive.
// Sunday 23h Paris creates an immutable weekly checkpoint. The manifest's
// actual same-day source timestamp is retained, not retroactively changed.
export async function archiveGuestEvolutionTick(env,now=Date.now()){
  if(!env?.CAPTAIN_BUCKET?.get||!env.CAPTAIN_BUCKET.put||!Number.isFinite(now))
    return {status:"disabled"};
  const p=localParts(now),hour=Number(p.hour),minute=Number(p.minute);
  const sunday=p.weekday==="Sun";
  const capture=sunday&&hour===23&&
    ((minute>=0&&minute<30)||(minute>=30&&minute<60));
  const rotation=hour===11&&minute<30;
  if(!capture&&!rotation)return {status:"outside-window"};
  const targetIndex=capture?minute%30:minute;
  try{
    const list=await approved(env);
    if(list.length>30)return {status:"too-many-guests"};
    if(targetIndex>=list.length)return {status:"idle"};
    const selected=list[targetIndex],bucket=env.CAPTAIN_BUCKET;
    const allowed=await activeSharers(bucket,selected.fingerprint,now);
    if(!allowed)return {status:"infos-not-ready"};
    const original=await read(bucket,archiveKey(selected.fingerprint));
    // A re-bound fingerprint cannot inherit another WebApp tenant's history.
    const existing=original?.allianceKey===selected.allianceKey?original:null;
    const archive=sanitized(existing,selected.fingerprint,selected.allianceKey,
      now,allowed);
    if(capture){
      const checkpoint=localDay(now);
      if(!archive.checkpoints.some(x=>x.date===checkpoint)){
        const projected=await projectAlliance(bucket,selected.fingerprint,
          selected.allianceKey,now);
        if(projected.state!=="complete"||
           localDay(dateMs(projected.capturedAt))!==checkpoint)
          return {status:"roster-not-ready"};
        const players=projected.rosters.filter(p=>allowed.has(norm(p.player)));
        if(players.length){
          archive.checkpoints.push({date:checkpoint,
            sourceCapturedAt:projected.capturedAt,players});
          archive.checkpoints.sort((a,b)=>a.date.localeCompare(b.date));
        }
      }
    }
    if(!archive.checkpoints.length)return {status:"no-checkpoints"};
    const body=JSON.stringify(archive);
    if(body.length>MAX_BYTES)return {status:"archive-too-large"};
    await bucket.put(archiveKey(selected.fingerprint),body,{
      httpMetadata:{contentType:"application/json",
        cacheControl:"private, no-store"}});
    return {status:capture?"checkpoint-ready":"refreshed",
      checkpoints:archive.checkpoints.length};
  }catch{return {status:"unavailable"};}
}
export async function secureGuestEvolution(request,env,now=Date.now(),
  fetchImpl=fetch){
  if(request.method==="OPTIONS")
    return new Response(null,{status:request.headers.get("Origin")===
      "https://keryas777.github.io"?204:403,headers:headers(request)});
  if(request.method!=="GET")return reply(request,{status:"method-not-allowed"},405);
  if(request.headers.get("Origin")&&
     request.headers.get("Origin")!=="https://keryas777.github.io")
    return reply(request,{status:"forbidden-origin"},403);
  const query=new URL(request.url).searchParams;
  const view=query.get("view"),key=query.get("alliance");
  const required=view==="index"?["alliance","view"]:
    view==="group"?["alliance","view","date"]:
    view==="player"?["alliance","view","date","playerKey"]:null;
  if(!required||[...query.keys()].sort().join(",")!==required.sort().join(",")||
     required.some(k=>query.getAll(k).length!==1)||
     !KEY.test(key||"")||
     (view!=="index"&&(!DATE.test(query.get("date")||"")||
       new Date(query.get("date")+"T00:00:00Z").getUTCDay()!==0))||
     (view==="player"&&!PLAYER.test(query.get("playerKey")||"")))
    return reply(request,{status:"invalid-query"},400);
  if(!env?.CAPTAIN_BUCKET?.get||!env?.LOSP_AUTH?.fetch)
    return reply(request,{status:"unavailable",reason:"binding-missing"},503);
  const signedFetch=fetchImpl===fetch?
    (...args)=>env.LOSP_AUTH.fetch(...args):fetchImpl;
  const auth=await verifiedDiscord(request,signedFetch);
  if(auth.status!=="ok")return reply(request,{status:auth.status},
    auth.status==="unauthorized"?401:503);
  if(!auth.allowed.has(key))return reply(request,{status:"forbidden"},403);
  try{
    const [guest,losp]=await Promise.all([
      readGuestApprovals(env),readApproval(env)]);
    const selected=selectApproved(guest,losp,[key]);
    if(!selected)return reply(request,{status:"alliance-not-bound-or-not-approved"},409);
    const fingerprint=selected[0].fingerprint,bucket=env.CAPTAIN_BUCKET;
    const allowed=await activeSharers(bucket,fingerprint,now);
    if(!allowed)return reply(request,{status:"unavailable",
      reason:"current-sharing-not-verifiable"},503);
    const raw=await read(bucket,archiveKey(fingerprint));
    if(raw&&raw.allianceKey!==key)
      return reply(request,{status:"unavailable",
        reason:"archive-tenant-mismatch"},409);
    const archive=sanitized(raw,fingerprint,key,now,allowed);
    const answer=view==="index"?{index:toIndex(archive,key)}:
      view==="group"?{group:toGroup(archive,key,query.get("date"))}:
      {snapshot:toPlayer(archive,key,query.get("date"),
        query.get("playerKey"))};
    return reply(request,{status:"ok",version:1,
      kind:"authorized-guest-evolution",alliance:key,
      retentionDays:29,view,...answer});
  }catch{return reply(request,{status:"unavailable",
    reason:"private-history-unavailable"},503);}
}
