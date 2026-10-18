// Admin-controlled, resumable microbatches: no cron collection and no public roster route.
// Exactly 1-2 OTHER members per batch; a connected account's own roster is deferred.
import {captainConfigReady} from "./captain-vault.js";
import {chooseAccount,approvedFingerprint} from "./private-roster-pilot.js";
import {readApproval} from "./roster-sync-preflight.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {collectAllianceRosterSample,collectPersonalRoster} from "./roster-collector.js";

export const BATCH_PREFIX="roster-batches/v1/";
export const BATCH_MAX_AGE_MS=7*86400000;
const FP=/^[0-9a-f]{64}$/;
const RUN=/^[0-9a-f-]{36}$/;
const MAX_SNAPSHOT_BYTES=3_000_000;
const BATCH_SIZE=2;
const answer=(v,status=200)=>Response.json(v,{status,headers:{
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"
}});
const stateKey=fp=>BATCH_PREFIX+fp+"/progress.json";
const playerKey=(fp,id,index)=>BATCH_PREFIX+fp+"/"+id+"/member-"+index+".json";
export const completeKey=fp=>BATCH_PREFIX+fp+"/latest-complete.json";
const selfKey=(fp,id)=>BATCH_PREFIX+fp+"/"+id+"/member-self.json";
async function lock(env,fp,action,holder){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.idFromName||!binding?.get)return "not-configured";
  const stub=binding.get(binding.idFromName(fp));
  const result=await stub.fetch(new Request("https://batch-lock.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,holder,fingerprint:fp})
  }));
  if(!result.ok)return result.status===409?"busy":"unavailable";
  return (await result.json()).status;
}
async function readState(env,fp){
  const obj=await env.CAPTAIN_BUCKET.get(stateKey(fp));
  if(!obj)return null;
  const raw=await obj.text();
  if(raw.length>30000)throw Error("bad progress");
  const s=JSON.parse(raw);
  if(s.version!==1||s.fingerprint!==fp||!RUN.test(s.runId)||
     !/^[0-9a-f]{64}$/.test(s.membershipDigest)||
     !Number.isInteger(s.completed)||s.completed<0||
     !Number.isInteger(s.totalEligible)||s.totalEligible<1||
     s.totalEligible>100||s.completed>s.totalEligible||
     !Number.isFinite(Date.parse(s.expiresAt))||
     !Number.isFinite(Date.parse(s.startedAt))||
     Date.parse(s.expiresAt)-Date.parse(s.startedAt)!==BATCH_MAX_AGE_MS||
     (s.campaign!==undefined&&typeof s.campaign!=="string")||
     (s.selfCompleted!==undefined&&typeof s.selfCompleted!=="boolean")||
     (s.baseline!==undefined&&(!s.baseline||!RUN.test(s.baseline.runId)||
        !/^[0-9a-f]{64}$/.test(s.baseline.membershipDigest)||
        !Number.isFinite(Date.parse(s.baseline.expiresAt)))))
    throw Error("invalid progress");
  return s;
}
function publicState(state,now=Date.now()){
  if(!state)return {status:"not-started",completed:0,remaining:null,collectionEnabled:false};
  const expired=Date.parse(state.expiresAt)<=now;
  return {
    status:expired?"expired":state.completed===state.totalEligible?
      (state.selfCompleted===true?"complete":"complete-co-members"):"in-progress",
    completed:state.completed,eligibleCoMembers:state.totalEligible,
    remaining:state.totalEligible-state.completed,startedAt:state.startedAt,
    expiresAt:state.expiresAt,personalRosterCollected:state.selfCompleted===true,
    collectionEnabled:false
  };
}
export async function getRosterBatchStatus(request,env,now=Date.now()){
  if(request.method!=="GET")return answer({status:"method-not-allowed"},405);
  if(!captainConfigReady(env))return answer({status:"not-configured"},503);
  const fp=new URL(request.url).searchParams.get("fingerprint");
  if(!FP.test(fp||""))return answer({status:"invalid-selection"},400);
  try{
    const approval=await readApproval(env);
    if(!approvedFingerprint(approval,fp))return answer({status:"alliance-not-approved"},403);
    return answer(publicState(await readState(env,fp),now));
  }catch{return answer({status:"unavailable"},503);}
}
async function latestComplete(env,fp,now){
  try{
    const obj=await env.CAPTAIN_BUCKET.get(completeKey(fp));
    if(!obj)return null;
    const raw=await obj.text();
    if(raw.length>30000)return null;
    const value=JSON.parse(raw);
    return value.version===1&&value.fingerprint===fp&&RUN.test(value.runId)&&
      /^[0-9a-f]{64}$/.test(value.membershipDigest)&&
      Number.isInteger(value.total)&&value.total>=1&&value.total<=100&&
      Number.isFinite(Date.parse(value.expiresAt))&&
      Date.parse(value.expiresAt)>now?value:null;
  }catch{return null;}
}
async function oldSelf(env,fp,base,now){
  if(!base||Date.parse(base.expiresAt)<=now)return null;
  try{
    const obj=await env.CAPTAIN_BUCKET.get(selfKey(fp,base.runId));
    if(!obj)return null;
    const raw=await obj.text();
    if(raw.length>MAX_SNAPSHOT_BYTES)return null;
    const value=JSON.parse(raw);
    if(value.version!==1||value.runId!==base.runId||
       value.allianceFingerprint!==fp||typeof value.asOf!=="string"||
       !Array.isArray(value.characters)||Date.parse(value.expiresAt)<=now)
      return null;
    return {asOf:value.asOf,chars:value.characters,memberId:value.volatileMemberId};
  }catch{return null;}
}
async function finishSelf(env,fp,previous,selected,baseline,now,fetchImpl){
  const old=await oldSelf(env,fp,baseline,now);
  // Only reuse the old personal roster when Scopely confirms the same
  // membership snapshot; collectPersonalRoster validates isSelf both times.
  const report=await collectPersonalRoster(selected.token,fetchImpl,{
    expectedMembershipDigest:previous.membershipDigest,
    cached:old&&baseline?.membershipDigest===previous.membershipDigest?
      {asOf:old.asOf,chars:old.chars}:null
  });
  if(report.status!=="complete")return answer({status:report.status},409);
  if(old&&report.unchanged&&old.memberId!==report.memberId)
    return answer({status:"identity-changed-during-read"},409);
  const after=await discoverAlliance(selected.token,fetchImpl);
  if(!after.ok||after.aid!==selected.aid)
    return answer({status:"alliance-changed-during-read"},409);
  if(!approvedFingerprint(await readApproval(env),fp))
    return answer({status:"approval-withdrawn"},409);
  const record={version:1,kind:"private-staged-personal-roster",
    allianceFingerprint:fp,runId:previous.runId,memberIndex:"self",
    name:report.name,volatileMemberId:report.memberId,
    capturedAt:new Date(now).toISOString(),expiresAt:previous.expiresAt,
    asOf:report.asOf||null,characters:report.chars};
  const raw=JSON.stringify(record);
  if(raw.length>MAX_SNAPSHOT_BYTES)return answer({status:"snapshot-too-large"},409);
  await env.CAPTAIN_BUCKET.put(selfKey(fp,previous.runId),raw,{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  // Only after the LAST expected player is durable: atomic manifest pointer.
  const complete={version:1,fingerprint:fp,runId:previous.runId,
    membershipDigest:previous.membershipDigest,total:previous.totalEligible+1,
    coMembers:previous.totalEligible,includesPersonal:true,
    capturedAt:new Date(now).toISOString(),expiresAt:previous.expiresAt};
  await env.CAPTAIN_BUCKET.put(completeKey(fp),JSON.stringify(complete),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify({
    ...previous,selfCompleted:true
  }),{httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
  return answer({...publicState({...previous,selfCompleted:true},now),
    savedThisBatch:1,charactersThisBatch:report.chars.length,
    pagesThisBatch:report.pages,unchangedThisBatch:report.unchanged?1:0,
    requestsThisBatch:report.requests+(selected.discoveryRequests||0)+1,
    personalRoster:true,storage:"private-r2",publiclyAvailable:false});
}
export async function handleRosterMicrobatch(request,env,fetchImpl=fetch,now=Date.now(),internal={}){
  if(request.method!=="POST")return answer({status:"method-not-allowed"},405);
  if(!captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK)
    return answer({status:"not-configured"},503);
  const url=new URL(request.url);
  if(request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return answer({status:"forbidden"},403);
  let fp,restart,refresh;
  try{
    const raw=await request.text();
    if(raw.length>300)throw Error("too-large");
    const data=JSON.parse(raw);
    if(!data||typeof data!=="object"||Array.isArray(data)||
       !FP.test(data.fingerprint)||Object.keys(data).some(k=>!["fingerprint","restart","refresh"].includes(k))||
       (data.restart!==undefined&&data.restart!==true)||
       (data.refresh!==undefined&&data.refresh!==true)||
       (data.restart===true&&data.refresh===true))throw Error("bad-payload");
    fp=data.fingerprint;restart=data.restart===true;refresh=data.refresh===true;
  }catch{return answer({status:"invalid-selection"},400);}
  let holder=crypto.randomUUID(),acquired=false;
  try{
    const approval=await readApproval(env);
    if(!approvedFingerprint(approval,fp))return answer({status:"alliance-not-approved"},403);
    const status=await lock(env,fp,"acquire",holder);
    if(status!=="acquired")return answer({status:status==="busy"?"busy":"lock-unavailable"},409);
    acquired=true;
    const campaign=typeof internal?.campaign==="string"&&
      /^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(internal.campaign)?
      internal.campaign:null;
    let previous=restart?null:await readState(env,fp);
    if(campaign&&previous?.campaign!==campaign)previous=null;
    if(previous&&Date.parse(previous.expiresAt)<=now)
      return answer({...publicState(previous,now),status:"expired-restart-required"},409);
    if(refresh&&(!previous||previous.completed!==previous.totalEligible))
      return answer({status:"refresh-requires-complete-run"},409);
    if(campaign&&previous?.lastAutoTick===internal.tick)
      return answer({status:"already-processed-tick"},200);
    if(previous&&previous.completed===previous.totalEligible&&!refresh&&
       (!campaign||previous.selfCompleted===true))
      return answer(publicState(previous,now));
    const pointer=campaign?await latestComplete(env,fp,now):null;
    const baseline=campaign?(previous?.baseline||
      (pointer?{runId:pointer.runId,membershipDigest:pointer.membershipDigest,
        expiresAt:pointer.expiresAt}:null)):
      refresh?{runId:previous.runId,membershipDigest:previous.membershipDigest,
        expiresAt:previous.expiresAt}:previous?.baseline;
    if(refresh)previous=null;
    const selected=await chooseAccount(env,fp,fetchImpl);
    if(selected.status!=="ok")return answer({status:selected.status},409);
    if(campaign&&previous&&previous.completed===previous.totalEligible)
      return finishSelf(env,fp,previous,selected,baseline,now,fetchImpl);
    const startIndex=previous?.completed||0;
    const cachedForMember=async(member,index)=>{
      if(!baseline||Date.parse(baseline.expiresAt)<=now)return null;
      try{
        const obj=await env.CAPTAIN_BUCKET.get(playerKey(fp,baseline.runId,index));
        if(!obj)return null;
        const text=await obj.text();
        if(text.length>MAX_SNAPSHOT_BYTES)return null;
        const old=JSON.parse(text);
        if(old.version!==1||old.runId!==baseline.runId||
           old.allianceFingerprint!==fp||old.memberIndex!==index||
           old.volatileMemberId!==member.id||
           typeof old.asOf!=="string"||!old.asOf||
           Date.parse(old.expiresAt)<=now)return null;
        return {asOf:old.asOf,chars:old.characters};
      }catch{return null;}
    };
    const result=await collectAllianceRosterSample(selected.token,fetchImpl,{
      maxMembers:BATCH_SIZE,startIndex,charInfo:true,
      preferSinglePage:true,cachedForMember,
      requireCurrentMembership:true,requireStableMembership:true,
      includeMembershipDigest:true,
      ...(previous||baseline?{expectedMembershipDigest:
        previous?.membershipDigest||baseline.membershipDigest}:{})
    });
    if(result.status!=="complete")return answer({status:result.status},409);
    if(previous&&(previous.membershipDigest!==result.membershipDigest||
       previous.totalEligible!==result.sharedCount))
      return answer({status:"membership-changed-restart-required"},409);
    if(!result.sharedCount)return answer({status:"no-shared-co-members"},409);
    if(result.selectedCount<1||result.rosters.length!==result.selectedCount||
       result.rosters.some(r=>!Array.isArray(r.chars)||r.chars.length===0))
      return answer({status:"no-complete-roster"},409);
    const stillCurrent=await discoverAlliance(selected.token,fetchImpl);
    if(!stillCurrent.ok||stillCurrent.aid!==selected.aid)
      return answer({status:"alliance-changed-during-read"},409);
    if(!approvedFingerprint(await readApproval(env),fp))
      return answer({status:"approval-withdrawn"},409);
    // The lock ensures only one writer updates the alliance's current progress.
    const runId=previous?.runId||crypto.randomUUID();
    const startedAt=previous?.startedAt||new Date(now).toISOString();
    const expiresAt=previous?.expiresAt||new Date(now+BATCH_MAX_AGE_MS).toISOString();
    const snapshots=result.rosters.map((r,i)=>({
      key:playerKey(fp,runId,startIndex+i),value:JSON.stringify({
        version:1,kind:"private-staged-microbatch",allianceFingerprint:fp,
        runId,memberIndex:startIndex+i,name:r.name,volatileMemberId:r.memberId,
        capturedAt:new Date(now).toISOString(),expiresAt,
        asOf:r.asOf||null,characters:r.chars
      })
    }));
    if(snapshots.some(s=>s.value.length>MAX_SNAPSHOT_BYTES))
      return answer({status:"snapshot-too-large"},409);
    for(const s of snapshots){
      await env.CAPTAIN_BUCKET.put(s.key,s.value,{
        httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
      });
    }
    // Progress advances only after EVERY member of this microbatch is stored.
    const updated={
      version:1,fingerprint:fp,runId,membershipDigest:result.membershipDigest,
      startedAt,expiresAt,totalEligible:result.sharedCount,
      completed:startIndex+result.selectedCount,
      ...(campaign?{campaign,selfCompleted:false,lastAutoTick:internal.tick}:{}),
      ...(baseline?{baseline}:{})
    };
    await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify(updated),{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    return answer({...publicState(updated,now),
      savedThisBatch:result.selectedCount,charactersThisBatch:result.characterCount,
      pagesThisBatch:result.pages,unchangedThisBatch:result.unchangedCount,
      requestsThisBatch:result.requests+(selected.discoveryRequests||0)+1,
      storage:"private-r2",publiclyAvailable:false});
  }catch{return answer({status:"batch-unavailable"},503);}
  finally{if(acquired)try{await lock(env,fp,"release",holder);}catch{}}
}
