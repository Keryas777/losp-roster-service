// Admin-controlled, resumable microbatches: no cron collection and no public roster route.
// Exactly 1-2 OTHER members per batch; a connected account's own roster is deferred.
import {captainConfigReady} from "./captain-vault.js";
import {chooseAccount,approvedFingerprint} from "./private-roster-pilot.js";
import {readApproval} from "./roster-sync-preflight.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {collectAllianceRosterSample} from "./roster-collector.js";

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
     Date.parse(s.expiresAt)-Date.parse(s.startedAt)!==BATCH_MAX_AGE_MS)
    throw Error("invalid progress");
  return s;
}
function publicState(state,now=Date.now()){
  if(!state)return {status:"not-started",completed:0,remaining:null,collectionEnabled:false};
  const expired=Date.parse(state.expiresAt)<=now;
  return {
    status:expired?"expired":state.completed===state.totalEligible?
      "complete-co-members":"in-progress",
    completed:state.completed,eligibleCoMembers:state.totalEligible,
    remaining:state.totalEligible-state.completed,startedAt:state.startedAt,
    expiresAt:state.expiresAt,collectionEnabled:false
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
export async function handleRosterMicrobatch(request,env,fetchImpl=fetch,now=Date.now()){
  if(request.method!=="POST")return answer({status:"method-not-allowed"},405);
  if(!captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK)
    return answer({status:"not-configured"},503);
  const url=new URL(request.url);
  if(request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return answer({status:"forbidden"},403);
  let fp,restart;
  try{
    const raw=await request.text();
    if(raw.length>300)throw Error("too-large");
    const data=JSON.parse(raw);
    if(!data||typeof data!=="object"||Array.isArray(data)||
       !FP.test(data.fingerprint)||Object.keys(data).some(k=>!["fingerprint","restart"].includes(k))||
       (data.restart!==undefined&&data.restart!==true))throw Error("bad-payload");
    fp=data.fingerprint;restart=data.restart===true;
  }catch{return answer({status:"invalid-selection"},400);}
  let holder=crypto.randomUUID(),acquired=false;
  try{
    const approval=await readApproval(env);
    if(!approvedFingerprint(approval,fp))return answer({status:"alliance-not-approved"},403);
    const status=await lock(env,fp,"acquire",holder);
    if(status!=="acquired")return answer({status:status==="busy"?"busy":"lock-unavailable"},409);
    acquired=true;
    let previous=restart?null:await readState(env,fp);
    if(previous&&Date.parse(previous.expiresAt)<=now)
      return answer({status:"expired-restart-required",...publicState(previous,now)},409);
    if(previous&&previous.completed===previous.totalEligible)
      return answer(publicState(previous,now));
    const selected=await chooseAccount(env,fp,fetchImpl);
    if(selected.status!=="ok")return answer({status:selected.status},409);
    const startIndex=previous?.completed||0;
    const result=await collectAllianceRosterSample(selected.token,fetchImpl,{
      maxMembers:BATCH_SIZE,startIndex,charInfo:true,
      requireCurrentMembership:true,requireStableMembership:true,
      includeMembershipDigest:true
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
        capturedAt:new Date(now).toISOString(),expiresAt,characters:r.chars
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
      completed:startIndex+result.selectedCount
    };
    await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify(updated),{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    return answer({...publicState(updated,now),
      savedThisBatch:result.selectedCount,charactersThisBatch:result.characterCount,
      pagesThisBatch:result.pages,requestsThisBatch:result.requests,
      storage:"private-r2",publiclyAvailable:false});
  }catch{return answer({status:"batch-unavailable"},503);}
  finally{if(acquired)try{await lock(env,fp,"release",holder);}catch{}}
}
