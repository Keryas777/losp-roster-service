// Twice-daily, private, resumable alliance Info collection.
// Shares the EXISTING roster cron/approval/locks; never writes to public R2.
// /members includes everybody, regardless of rosterShare.
// Volatile member IDs are used only within a verified single campaign.
import {chooseAccount,approvedFingerprint} from "./private-roster-pilot.js";
import {readApproval} from "./roster-sync-preflight.js";
import {API_KEY} from "./player-card.js";

export const INFO_PREFIX="roster-batches/v1/";
const MAX_MEMBERS=100, CARDS_PER_TICK=2, TTL=7*86400000;
const FP=/^[a-f0-9]{64}$/;
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const validNum=x=>Number.isSafeInteger(x)&&x>=0;
const safeName=x=>typeof x==="string"&&x.trim().length>0&&x.length<=140;
const normalized=x=>String(x||"").trim().toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const snapshotKey=(fp,c)=>INFO_PREFIX+fp+"/campaigns/"+c+"-infos.json";
const progressKey=(fp,c)=>INFO_PREFIX+fp+"/campaigns/"+c+"-infos-progress.json";
const cooldownKey=fp=>INFO_PREFIX+fp+"/infos-cooldown.json";
const storageOptions={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
async function read(bucket,key,max=200000){
  const obj=await bucket.get(key);
  if(!obj)return null;
  const raw=await obj.text();
  if(raw.length>max)throw Error("infos-object-too-large");
  return JSON.parse(raw);
}
async function put(bucket,key,data){
  const raw=JSON.stringify(data);
  if(raw.length>200000)throw Error("infos-object-too-large");
  await bucket.put(key,raw,storageOptions);
}
async function provider(token,path,fetchImpl){
  let response;
  try{
    response=await fetchImpl("https://api.marvelstrikeforce.com"+path,{
      headers:{"Authorization":"Bearer "+token,"x-api-key":API_KEY,
        "User-Agent":"LoSP-Roster-Service","Accept":"application/json"},
      cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(10000)
    });
  }catch{return {status:"network-error"};}
  if(response.status===429)return {status:"rate-limited"};
  if([403,404,464].includes(response.status))return {status:"not-accessible"};
  if(!response.ok)return {status:"provider-"+response.status};
  if(Number(response.headers.get("content-length")||0)>1000000)
    return {status:"oversized"};
  try{
    const body=await response.text();
    if(body.length>1000000)return {status:"oversized"};
    const parsed=JSON.parse(body);
    return isObject(parsed)?{status:"ok",data:parsed.data}:{status:"invalid-json"};
  }catch{return {status:"invalid-json"};}
}
function membersFrom(data){
  if(!Array.isArray(data)||data.length<1||data.length>MAX_MEMBERS)return null;
  const names=new Set(),ids=new Set();
  let self=0;
  for(const row of data){
    if(!isObject(row)||typeof row.id!=="string"||!row.id||row.id.length>256||
       ids.has(row.id)||!isObject(row.card)||!safeName(row.card.name)||
       !validNum(row.card.tcp)||!validNum(row.card.warMvp)||
       typeof row.card.icon!=="string"||typeof row.card.frame!=="string"||
       typeof row.card.rosterShare!=="boolean"||
       !["leader","captain","member"].includes(row.rank))return null;
    const nk=normalized(row.card.name);
    if(!nk||names.has(nk))return null;
    ids.add(row.id);names.add(nk);
    if(row.isSelf===true)self++;
  }
  if(self!==1)return null;
  return [...data].sort((a,b)=>a.id.localeCompare(b.id));
}
function identity(rows){
  return JSON.stringify(rows.map(m=>[m.id,m.card.name]));
}
const extraNumbers=["charactersAtMaxStarRank","bestArena","latestArena",
  "latestBlitz","blitzWins","wwPoints"];
function cardExtras(data,name){
  if(!isObject(data)||!safeName(data.name)||normalized(data.name)!==normalized(name))
    return null;
  const extra={};
  for(const key of extraNumbers)if(validNum(data[key]))extra[key]=data[key];
  if(typeof data.aid==="string"&&data.aid.length<=256)extra.aid=data.aid;
  else if(validNum(data.aid))extra.aid=data.aid; // Provider sometimes uses numeric aid.
  if(isObject(data.qualifications)&&JSON.stringify(data.qualifications).length<4000)
    extra.qualifications=data.qualifications;
  return extra;
}
export function projectInfoRows(members,extras,alliance){
  return members.map((member)=>{
    const c=member.card,extra=extras[member.id];
    const result={name:c.name,alliance,tcp:c.tcp,war_mvp:c.warMvp,
      icon:c.icon,frame:c.frame,rank:member.rank,rosterShare:c.rosterShare};
    for(const field of ["stp","charactersCollected","daysInAlliance"])
      if(validNum(c[field]))result[field]=c[field];
    if(isObject(c.level))result.level=c.level; // SimpleProgress, not a Gear Tier.
    if(extra===null)result.profileStatus="unavailable";
    else if(isObject(extra))Object.assign(result,extra);
    return result;
  });
}
export async function runMemberInfoTick(env,fp,slot,fetchImpl=fetch){
  if(env?.MEMBER_INFO_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(!FP.test(fp)||!/^\d{4}-\d{2}-\d{2}-(am|pm)$/.test(slot?.campaign))
    return {status:"invalid-campaign"};
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put)return {status:"storage-unavailable"};
  const now=Date.parse(slot.stamp);
  if(!Number.isFinite(now))return {status:"invalid-date"};
  let requests=0;
  try{
    if(await read(bucket,snapshotKey(fp,slot.campaign)))return {status:"complete",requests};
    const cooldown=await read(bucket,cooldownKey(fp),3000);
    if(Number.isFinite(Date.parse(cooldown?.until))&&Date.parse(cooldown.until)>now)
      return {status:"cooldown",requests};
    if(!approvedFingerprint(await readApproval(env),fp))
      return {status:"approval-withdrawn",requests};
    // chooseAccount revalidates the CURRENT Scopely alliance on every tick.
    const account=await chooseAccount(env,fp,fetchImpl);
    requests+=account.discoveryRequests||0;
    if(account.status!=="ok")return {status:account.status,requests};
    const current=await provider(account.token,"/player/v1/alliance/members",fetchImpl);
    requests++;
    if(current.status!=="ok")return {status:current.status,requests};
    const members=membersFrom(current.data);
    if(!members)return {status:"invalid-members",requests};
    let state=await read(bucket,progressKey(fp,slot.campaign));
    if(!state||state.version!==1||state.campaign!==slot.campaign||
       state.allianceFingerprint!==fp||state.allianceId!==account.aid||
       state.membership!==identity(members)||!isObject(state.extras)||
       !Number.isInteger(state.cursor)||state.cursor<0||state.cursor>members.length){
      // A transfer or renamed player invalidates all earlier volatile handles.
      state={version:1,campaign:slot.campaign,allianceFingerprint:fp,
        allianceId:account.aid,membership:identity(members),cursor:0,extras:{}};
    }
    for(let i=0;i<CARDS_PER_TICK&&state.cursor<members.length;i++){
      const member=members[state.cursor];
      const card=await provider(account.token,
        "/player/v1/card/member/"+encodeURIComponent(member.id),fetchImpl);
      requests++;
      if(card.status==="rate-limited"){
        await put(bucket,cooldownKey(fp),{until:new Date(now+60*60000).toISOString()});
        return {status:"rate-limited",requests};
      }
      if(card.status!=="ok"&&card.status!=="not-accessible")
        return {status:card.status,requests};
      if(card.status==="ok"){
        const extra=cardExtras(card.data,member.card.name);
        if(extra===null)return {status:"identity-changed",requests};
        state.extras[member.id]=extra;
      }else state.extras[member.id]=null;
      state.cursor++;
    }
    // Retain progress only in private R2, never a public JSON.
    await put(bucket,progressKey(fp,slot.campaign),state);
    if(state.cursor<members.length)
      return {status:"partial",requests,completed:state.cursor,total:members.length};
    const after=await provider(account.token,"/player/v1/alliance/members",fetchImpl);
    requests++;
    const verified=after.status==="ok"?membersFrom(after.data):null;
    if(!verified||identity(verified)!==identity(members))
      return {status:"membership-changed",requests};
    if(!approvedFingerprint(await readApproval(env),fp))
      return {status:"approval-withdrawn",requests};
    const rows=projectInfoRows(verified,state.extras,account.name);
    // No member IDs, OAuth tokens, private application messages, or raw provider envelopes.
    const snapshot={version:1,kind:"alliance-infos-campaign",
      campaign:slot.campaign,allianceFingerprint:fp,
      allianceName:account.name,capturedAt:new Date(now).toISOString(),
      expiresAt:new Date(now+TTL).toISOString(),rows};
    await put(bucket,snapshotKey(fp,slot.campaign),snapshot);
    return {status:"complete",requests,total:rows.length};
  }catch{return {status:"unavailable",requests};}
}
