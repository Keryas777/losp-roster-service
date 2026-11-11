// Independent reward-time Info collection, WITHOUT changing existing AM/PM campaigns.
// Starts at 16:01 UTC on the existing once-per-minute cron.
// Stores a short-lived private R2 receipt for each approved alliance.
import {readApproval} from "./roster-sync-preflight.js";
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {captainConfigReady} from "./captain-vault.js";
import {chooseAccount,approvedFingerprint} from "./private-roster-pilot.js";
import {projectInfoRows} from "./member-info-campaign.js";
import {API_KEY} from "./player-card.js";

const PREFIX="roster-batches/v1/";
const TTL_MS=7*86400000;
const MAX_PER_TICK=24;
const PARALLEL=3;
const REWARD_WINDOW_MINUTES=30;
const APPROVED=/^[a-f0-9]{64}$/;
const isObject=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const validNumber=v=>Number.isSafeInteger(v)&&v>=0;
const normalized=v=>String(v||"").trim().toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const receiptKey=(fp,day)=>PREFIX+fp+"/campaigns/"+day+"-reward-infos.json";
const stateKey=(fp,day)=>PREFIX+fp+"/reward/"+day+"-progress.json";
const cooldownKey=fp=>PREFIX+fp+"/reward-cooldown.json";
const storageOpts={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};

export function rewardWindow(timestamp){
  if(!Number.isFinite(timestamp))return null;
  const date=new Date(timestamp);
  if(Number.isNaN(date.getTime()))return null;
  const minute=date.getUTCHours()*60+date.getUTCMinutes();
  const tick=minute-(16*60+1);
  if(tick<0||tick>=REWARD_WINDOW_MINUTES)return null;
  return {day:date.toISOString().slice(0,10),
    tick,stamp:date.toISOString().slice(0,16)+"Z"};
}

async function read(bucket,key,limit=240000){
  const obj=await bucket.get(key);
  if(!obj)return null;
  const raw=await obj.text();
  if(raw.length>limit)throw Error("oversized-reward-state");
  return JSON.parse(raw);
}
async function write(bucket,key,value){
  const raw=JSON.stringify(value);
  if(raw.length>240000)throw Error("oversized-reward-state");
  await bucket.put(key,raw,storageOpts);
}
async function provider(token,route,fetchImpl){
  let response;
  try{
    response=await fetchImpl("https://api.marvelstrikeforce.com"+route,{
      headers:{Authorization:"Bearer "+token,"x-api-key":API_KEY,
        "User-Agent":"LoSP-Roster-Service",Accept:"application/json"},
      cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(10000)
    });
  }catch{return {status:"network-error"};}
  if(response.status===429)return {status:"rate-limited"};
  if([403,404,464].includes(response.status))return {status:"not-accessible"};
  if(!response.ok)return {status:"provider-"+response.status};
  try{
    if(Number(response.headers.get("content-length")||0)>1000000)
      return {status:"oversized"};
    const text=await response.text();
    if(text.length>1000000)return {status:"oversized"};
    const data=JSON.parse(text);
    return isObject(data)?{status:"ok",data:data.data}:{status:"invalid-json"};
  }catch{return {status:"invalid-json"};}
}
function validateMembers(data){
  if(!Array.isArray(data)||data.length<1||data.length>100)return null;
  const ids=new Set(),names=new Set();
  let self=0;
  for(const member of data){
    const card=member?.card, name=card?.name;
    if(!isObject(member)||typeof member.id!=="string"||!member.id||
       member.id.length>256||ids.has(member.id)||!isObject(card)||
       typeof name!=="string"||!name.trim()||name.length>140||
       names.has(normalized(name))||!validNumber(card.tcp)||
       !validNumber(card.warMvp)||typeof card.icon!=="string"||
       typeof card.frame!=="string"||typeof card.rosterShare!=="boolean"||
       !["leader","captain","member"].includes(member.rank))return null;
    ids.add(member.id);names.add(normalized(name));
    if(member.isSelf===true)self++;
  }
  if(self!==1)return null;
  return [...data].sort((a,b)=>a.id.localeCompare(b.id));
}
function memberIdentity(members){
  return JSON.stringify(members.map(m=>[m.id,m.card.name]));
}
function extrasFromCard(data,expected){
  if(!isObject(data)||typeof data.name!=="string"||
     normalized(data.name)!==normalized(expected))return null;
  const result={};
  for(const key of ["charactersAtMaxStarRank","bestArena","latestArena",
      "latestBlitz","blitzWins","wwPoints"]){
    if(validNumber(data[key]))result[key]=data[key];
  }
  if(typeof data.aid==="string"&&data.aid.length<=256)result.aid=data.aid;
  else if(validNumber(data.aid))result.aid=data.aid;
  if(isObject(data.qualifications)&&JSON.stringify(data.qualifications).length<4000)
    result.qualifications=data.qualifications;
  return result;
}
async function lock(env,fp,action,holder){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.idFromName||!binding?.get)return false;
  // Different Durable Object identity from every existing roster lock.
  const stub=binding.get(binding.idFromName("member-info-reward-"+fp));
  const res=await stub.fetch(new Request("https://roster-lock.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,holder,fingerprint:fp})
  }));
  const reply=await res.json().catch(()=>null);
  return res.ok&&reply?.status===(action==="acquire"?"acquired":"released");
}
export async function collectRewardAlliance(env,fp,slot,fetchImpl=fetch){
  if(!APPROVED.test(fp)||!slot?.day)return {status:"invalid-alliance"};
  const bucket=env.CAPTAIN_BUCKET;
  const holder=crypto.randomUUID();
  let acquired=false,requests=0;
  try{
    acquired=await lock(env,fp,"acquire",holder);
    if(!acquired)return {status:"busy"};
    if(await read(bucket,receiptKey(fp,slot.day)))return {status:"complete"};
    const pause=await read(bucket,cooldownKey(fp),3000);
    if(Date.parse(pause?.until)>Date.parse(slot.stamp))return {status:"cooldown"};
    if(!approvedFingerprint(await readCollectibleApprovals(env),fp))
      return {status:"approval-withdrawn"};
    const account=await chooseAccount(env,fp,fetchImpl);
    requests+=account.discoveryRequests||0;
    if(account.status!=="ok")return {status:account.status,requests};
    const current=await provider(account.token,"/player/v1/alliance/members",fetchImpl);
    requests++;
    const members=current.status==="ok"?validateMembers(current.data):null;
    if(!members)return {status:current.status==="ok"?"invalid-members":current.status,requests};
    const membership=memberIdentity(members);
    let state=await read(bucket,stateKey(fp,slot.day));
    if(!state||state.version!==1||state.day!==slot.day||
       state.allianceId!==account.aid||state.membership!==membership||
       !isObject(state.extras)||!isObject(state.observedAt)||
       !Number.isSafeInteger(state.cursor)||state.cursor<0||
       state.cursor>members.length){
      state={version:1,day:slot.day,allianceId:account.aid,
        membership,cursor:0,extras:{},observedAt:{},startedAt:slot.stamp};
    }
    // Keep our independent batch well under the existing service's
    // per-invocation request budget. This is not a Scopely-defined quota.
    const allowance=Math.max(0,Math.min(MAX_PER_TICK,
      36-requests-2));
    const stop=Math.min(members.length,state.cursor+allowance);
    if(stop===state.cursor&&state.cursor<members.length)
      return {status:"request-budget",requests};
    while(state.cursor<stop){
      const batch=members.slice(state.cursor,Math.min(stop,state.cursor+PARALLEL));
      const results=await Promise.all(batch.map(member=>
        provider(account.token,"/player/v1/card/member/"+
          encodeURIComponent(member.id),fetchImpl)));
      requests+=results.length;
      const problem=results.find(r=>r.status!=="ok"&&r.status!=="not-accessible");
      if(problem){
        if(problem.status==="rate-limited"){
          await write(bucket,cooldownKey(fp),{
            until:new Date(Date.parse(slot.stamp)+3600000).toISOString()
          });
        }
        await write(bucket,stateKey(fp,slot.day),state);
        return {status:problem.status,requests};
      }
      for(let i=0;i<batch.length;i++){
        const member=batch[i],result=results[i];
        if(result.status==="not-accessible")state.extras[member.id]=null;
        else{
          const extra=extrasFromCard(result.data,member.card.name);
          if(extra===null){
            await write(bucket,stateKey(fp,slot.day),state);
            return {status:"identity-changed",requests};
          }
          state.extras[member.id]=extra;
        }
        state.observedAt[member.id]=new Date().toISOString();
      }
      state.cursor+=batch.length;
    }
    await write(bucket,stateKey(fp,slot.day),state);
    if(state.cursor<members.length)
      return {status:"partial",requests,members:state.cursor};
    const after=await provider(account.token,"/player/v1/alliance/members",fetchImpl);
    requests++;
    const verified=after.status==="ok"?validateMembers(after.data):null;
    if(!verified||memberIdentity(verified)!==membership)
      return {status:"membership-changed",requests};
    if(!approvedFingerprint(await readCollectibleApprovals(env),fp))
      return {status:"approval-withdrawn",requests};
    const rows=projectInfoRows(verified,state.extras,account.name);
    const observedAt=rows.map((row,i)=>({
      name:row.name,at:state.observedAt[verified[i].id]||null
    }));
    const capturedAt=new Date().toISOString();
    await write(bucket,receiptKey(fp,slot.day),{
      version:1,kind:"alliance-infos-reward",
      campaign:slot.day+"-reward",allianceFingerprint:fp,
      allianceName:account.name,startedAt:state.startedAt,
      capturedAt,expiresAt:new Date(Date.parse(capturedAt)+TTL_MS).toISOString(),
      rows,observedAt
    });
    return {status:"complete",requests,members:rows.length};
  }catch{
    return {status:"unavailable",requests};
  }finally{
    if(acquired)try{await lock(env,fp,"release",holder);}catch{}
  }
}
// A manual request is a private, single-day intent, NOT a second cron. It is
// resumed by the existing every-minute tick, with the same alliance lease and
// per-invocation request bounds as the 16:01 UTC automatic reward campaign.
const MANUAL_TTL_MS=45*60000;
const manualKey=day=>PREFIX+"reward-manual/"+day+".json";
const privateHeaders={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff"};

export function utcRewardDay(timestamp){
  if(!Number.isFinite(timestamp))return null;
    const date=new Date(timestamp);
  const minutes=date.getUTCHours()*60+date.getUTCMinutes();
  return {day:date.toISOString().slice(0,10),
    afterReward:minutes>=16*60+1};
}

async function approvedRewardFingerprints(env,includeGuests=false){
  const approval=includeGuests?
    await readCollectibleApprovals(env):await readApproval(env);
  if(approval.status!=="configured"||!approval.alliances.length)
    return null;
  const fps=approval.alliances.map(a=>a.fingerprint).sort();
  if(fps.some(fp=>!APPROVED.test(fp))||new Set(fps).size!==fps.length)
    return null;
  return fps;
}

async function manualTickSlot(env,scheduledTime){
  const local=utcRewardDay(scheduledTime);
  if(!local?.afterReward)return null;
  const intent=await read(env.CAPTAIN_BUCKET,manualKey(local.day),3000);
  const started=Date.parse(intent?.startedAt);
  const until=Date.parse(intent?.expiresAt);
  if(intent?.version!==1||intent.day!==local.day||
     !Number.isFinite(started)||!Number.isFinite(until)||
     started>scheduledTime||scheduledTime>=until||
     until-started>MANUAL_TTL_MS)return null;
  return {
    day:local.day,
    tick:Math.max(0,Math.floor((scheduledTime-started)/60000)),
    stamp:new Date(scheduledTime).toISOString().slice(0,16)+"Z"
  };
}

// GET and POST {} access R2 only. A second explicit, admin-authenticated
// POST action can collect one approved alliance immediately in its OWN
// Worker invocation (under its own subrequest limit), without minute delays.
// The existing minute cron remains the fallback when the tab closes.
export async function rewardManualStatus(env,now=Date.now()){
  if(env?.MEMBER_INFO_REWARD_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")
    return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env))return {status:"storage-unavailable"};
  const today=utcRewardDay(now);
  if(!today)return {status:"invalid-time"};
  const fps=await approvedRewardFingerprints(env,true);
  if(!fps)return {status:"no-approved-alliances",day:today.day};
  const intent=await read(env.CAPTAIN_BUCKET,manualKey(today.day),3000);
  let complete=0;
  for(const fp of fps){
    const receipt=await read(env.CAPTAIN_BUCKET,receiptKey(fp,today.day),240000);
    if(receipt?.version===1&&receipt.kind==="alliance-infos-reward"&&
       receipt.campaign===today.day+"-reward"&&
       receipt.allianceFingerprint===fp&&Array.isArray(receipt.rows)&&
       Date.parse(receipt.expiresAt)>now)complete++;
  }
  const active=intent?.version===1&&intent.day===today.day&&
    Date.parse(intent.expiresAt)>now;
  return {
    status:complete===fps.length?"complete":
      active?"running":intent?"expired":
        complete>0?"partial":"not-started",
    day:today.day,eligible:today.afterReward,
    alliancesTotal:fps.length,alliancesComplete:complete,
    ...(intent?.startedAt?{startedAt:intent.startedAt}:{}),
    ...(intent?.expiresAt?{expiresAt:intent.expiresAt}:{}),
    mode:"reward-info-manual",storage:"private-r2"
  };
}

// One authorized HTTP invocation collects at most ONE alliance.
// Different requests can execute concurrently without sharing the 50-external-
// subrequest budget of Workers Free. The client supplies only an index into
// the server-side current approved list, not an alliance ID or a date.
export async function collectManualRewardIndex(env,index,now=Date.now(),
  fetchImpl=fetch,collectImpl=collectRewardAlliance){
  if(!Number.isSafeInteger(index)||index<0)return {status:"invalid-index"};
  if(env?.MEMBER_INFO_REWARD_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")
    return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env))return {status:"storage-unavailable"};
  const local=utcRewardDay(now);
  if(!local?.afterReward)return {status:"before-reward-cutoff"};
  const intent=await read(env.CAPTAIN_BUCKET,manualKey(local.day),3000);
  const started=Date.parse(intent?.startedAt),until=Date.parse(intent?.expiresAt);
  if(intent?.version!==1||intent.day!==local.day||
     !Number.isFinite(started)||!Number.isFinite(until)||
     started>now||now>=until||until-started>MANUAL_TTL_MS)
    return {status:"no-active-manual-intent"};
  const fps=await approvedRewardFingerprints(env,true);
  if(!fps||index>=fps.length)return {status:"invalid-index"};
  const slot={day:local.day,tick:index,
    stamp:new Date(now).toISOString().slice(0,16)+"Z"};
  const result=await collectImpl(env,fps[index],slot,fetchImpl);
  // No member names, fingerprints, identities or source records in HTTP.
  return {status:result.status||"unavailable",index,
    requests:Number.isSafeInteger(result.requests)?result.requests:0,
    ...(Number.isSafeInteger(result.members)?{members:result.members}:{})};
}

export async function handleRewardInfoManual(request,env,now=Date.now(),
  fetchImpl=fetch,collectImpl=collectRewardAlliance){
  if(!["GET","POST"].includes(request.method))
    return Response.json({status:"method-not-allowed"},{status:405,headers:privateHeaders});
  let body=null;
  if(request.method==="POST"){
    // Verified Cloudflare Access admin JWT before routing here. Require
    // same-origin JSON and a very small, strictly whitelisted payload.
    const origin=new URL(request.url).origin;
    if(request.headers.get("Origin")!==origin||
       !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("Content-Type")||""))
      return Response.json({status:"forbidden"},{status:403,headers:privateHeaders});
    try{
      const raw=await request.text();
      if(raw.length>60)throw Error("oversized");
      body=JSON.parse(raw);
      if(!isObject(body))throw Error("invalid");
      const keys=Object.keys(body);
      if(keys.length!==0&&!(keys.length===2&&
         keys.includes("action")&&keys.includes("index")&&
         body.action==="collect"&&Number.isSafeInteger(body.index)&&
         body.index>=0&&body.index<100))throw Error("unexpected");
    }catch{
      return Response.json({status:"invalid-payload"},{status:400,headers:privateHeaders});
    }
  }
  try{
    if(body?.action==="collect"){
      const result=await collectManualRewardIndex(env,body.index,now,
        fetchImpl,collectImpl);
      const code=["invalid-index"].includes(result.status)?400:
        ["disabled","retention-not-confirmed","storage-unavailable"].includes(result.status)?503:
        ["before-reward-cutoff","no-active-manual-intent"].includes(result.status)?409:200;
      return Response.json(result,{status:code,headers:privateHeaders});
    }
    const state=await rewardManualStatus(env,now);
    if(request.method==="GET")
      return Response.json(state,{headers:privateHeaders});
    if(["disabled","retention-not-confirmed","storage-unavailable",
         "no-approved-alliances"].includes(state.status))
      return Response.json(state,{status:503,headers:privateHeaders});
    if(!state.eligible)
      return Response.json({...state,status:"before-reward-cutoff"},
        {status:409,headers:privateHeaders});
    if(state.status==="running"||state.status==="complete")
      return Response.json(state,{headers:privateHeaders});
    const startedAt=new Date(now).toISOString();
    await write(env.CAPTAIN_BUCKET,manualKey(state.day),{
      version:1,day:state.day,startedAt,
      expiresAt:new Date(now+MANUAL_TTL_MS).toISOString()
    });
    return Response.json(await rewardManualStatus(env,now),{
      status:202,headers:privateHeaders});
  }catch{
    return Response.json({status:"unavailable"},{status:503,headers:privateHeaders});
  }
}

export async function runRewardInfoAutoTick(env,scheduledTime,fetchImpl=fetch,
  collectImpl=collectRewardAlliance){
  if(env?.MEMBER_INFO_REWARD_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")
    return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env))return {status:"storage-unavailable"};
  try{
    // The official 16:01–16:30 UTC automatic window always keeps priority.
    // Outside it, only a short-lived, explicitly authorized manual intent
    // can wake this same collector. No extra scheduler or daily campaign.
    const automatic=rewardWindow(scheduledTime);
    const slot=automatic||await manualTickSlot(env,scheduledTime);
    if(!slot)return {status:"outside-window"};
    // Both automatic and explicit admin-resumed campaigns include only
    // currently approved LoSP + guest alliances, checked again per micro-lot.
    const fps=await approvedRewardFingerprints(env,true);
    if(!fps)return {status:"no-approved-alliances"};
    return await collectImpl(env,fps[slot.tick%fps.length],slot,fetchImpl);
  }catch{return {status:"unavailable"};}
}
