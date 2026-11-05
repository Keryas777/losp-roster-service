// Admin-controlled, resumable microbatches: no cron collection and no public roster route.
// Exactly 1-2 OTHER members per batch; a connected account's own roster is deferred.
import {captainConfigReady} from "./captain-vault.js";
import {chooseAccount,approvedFingerprint} from "./private-roster-pilot.js";
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {collectAllianceRosterSample,collectPersonalRoster} from "./roster-collector.js";

export const BATCH_PREFIX="roster-batches/v1/";
export const BATCH_MAX_AGE_MS=7*86400000;
const FP=/^[0-9a-f]{64}$/;
const RUN=/^[0-9a-f-]{36}$/;
const MAX_SNAPSHOT_BYTES=3_000_000;
const BATCH_SIZE=2;
// Large /player rosters can need up to 10 pages each. Keep each Cron
// microbatch inside its existing 24-GET bound, even without a usable cache.
const AUTOMATIC_BATCH_SIZE=1;
// Fast mode processes an entire normal 24-member alliance in one invocation
// when the actual provider-request budget permits, without keeping 100 rosters
// in Worker memory. Oversized responses fall back to checked R2 checkpoints.
const FULL_ALLIANCE_BATCH_SIZE=24;
// A changing membership must not cause endless automatic full-roster restarts.
const MAX_AUTOMATIC_RESTARTS=2;
const answer=(v,status=200)=>Response.json(v,{status,headers:{
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"
}});
const stateKey=fp=>BATCH_PREFIX+fp+"/progress.json";
const playerKey=(fp,id,index)=>BATCH_PREFIX+fp+"/"+id+"/member-"+index+".json";
export const completeKey=fp=>BATCH_PREFIX+fp+"/latest-complete.json";
export const trophyCardKey=(fp,campaign)=>BATCH_PREFIX+fp+"/campaigns/"+campaign+"-trophy-card.json";
// Stable per-campaign receipt for late imports. Written after all authorized
// member files and the OAuth owner's roster, before mutable "latest" pointers.
// It uses the existing seven-day roster-batches R2 lifecycle.
export const campaignCompleteKey=(fp,campaign)=>
  BATCH_PREFIX+fp+"/campaigns/"+campaign+".json";
// Archive original provider JSON envelopes, not only the fields used by LoSP.
// All objects remain under the EXISTING 7-day R2 lifecycle prefix. Unique
// paths preserve every successful tick rather than overwriting prior metadata.
async function storeAllianceSource(env,fp,runId,now,entries){
  const capturedAt=new Date(now).toISOString();
  const folder=BATCH_PREFIX+fp+"/"+runId+"/provider-source/"+crypto.randomUUID()+"/";
  const sources=[
    ["alliance-card","/player/v1/alliance/card",entries.card,200],
    ["members-before","/player/v1/alliance/members",entries.before,200],
    ["members-after","/player/v1/alliance/members",entries.after,200]
  ];
  // Raw roster response envelopes include unknown fields and pagination meta.
  // A conditional 344 intentionally has no response body: keep the receipt
  // while existing baseline roster data remains preserved separately.
  for(const roster of entries.rosters||[]){
    if(!/^member-[0-9]+$|^self$/.test(roster.role)||
       !Array.isArray(roster.pages)||roster.pages.length<1||roster.pages.length>10)
      throw Error("invalid roster source");
    for(const [i,page] of roster.pages.entries()){
      if(!page||typeof page.path!=="string"||
         !page.path.startsWith("/player/v1/roster")||
         ![200,344].includes(page.httpStatus))
        throw Error("invalid roster page");
      sources.push(["roster-"+roster.role+"-page-"+i,page.path,
        page.payload,page.httpStatus]);
    }
  }
  for(const [name,endpoint,payload,httpStatus] of sources){
    if((httpStatus===200&&(!payload||typeof payload!=="object"||
       Array.isArray(payload)))||
       (httpStatus===344&&payload!==null))
      throw Error("missing source envelope");
    const raw=JSON.stringify({version:1,kind:"private-provider-source",
      allianceFingerprint:fp,runId,capturedAt,endpoint,httpStatus,
      providerResponse:payload});
    if(raw.length>MAX_SNAPSHOT_BYTES)throw Error("source-envelope-too-large");
    await env.CAPTAIN_BUCKET.put(folder+name+".json",raw,{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
  }

}


// The captain discovery GET already fetched AllianceCard. Preserve that exact
// authorized response before touching any player roster: one private source
// per post-war AM campaign, no new provider GET and no roster dependency.
async function storeEarlyTrophyCard(env,fp,campaign,source,now){
  if(!campaign||!/^\d{4}-\d{2}-\d{2}-am$/.test(campaign)||
     ![4,6].includes(new Date(now).getUTCDay()))return;
  const card=source?.data;
  if(!card||typeof card.id!=="string"||typeof card.name!=="string"||
     !["warTrophies","warRank","raidRank"].every(k=>
       Number.isSafeInteger(card[k])&&card[k]>=0))return;
  const existing=await env.CAPTAIN_BUCKET.get(trophyCardKey(fp,campaign));
  if(existing)return;
  const capturedAt=new Date(now).toISOString();
  const folder=BATCH_PREFIX+fp+"/"+crypto.randomUUID()+
    "/provider-source/"+crypto.randomUUID()+"/";
  const sourceKey=folder+"alliance-card.json";
  const raw=JSON.stringify({version:1,kind:"private-provider-source",
    allianceFingerprint:fp,runId:crypto.randomUUID(),capturedAt,
    endpoint:"/player/v1/alliance/card",httpStatus:200,
    providerResponse:source});
  if(raw.length>MAX_SNAPSHOT_BYTES)throw Error("source-envelope-too-large");
  const options={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
  await env.CAPTAIN_BUCKET.put(sourceKey,raw,options);
  await env.CAPTAIN_BUCKET.put(trophyCardKey(fp,campaign),JSON.stringify({
    version:1,kind:"trophy-card-ready",fingerprint:fp,
    campaign,capturedAt,sourceKey
  }),options);
}

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
     !Number.isInteger(s.totalEligible)||s.totalEligible<0||
     s.totalEligible>100||s.completed>s.totalEligible||
     !Number.isFinite(Date.parse(s.expiresAt))||
     !Number.isFinite(Date.parse(s.startedAt))||
     Date.parse(s.expiresAt)-Date.parse(s.startedAt)!==BATCH_MAX_AGE_MS||
     (s.campaign!==undefined&&typeof s.campaign!=="string")||
     (s.selfCompleted!==undefined&&typeof s.selfCompleted!=="boolean")||
     (s.observedMembers!==undefined&&(!Number.isInteger(s.observedMembers)||
       s.observedMembers<1||s.observedMembers>100))||
     (s.autoRestartCount!==undefined&&(!Number.isInteger(s.autoRestartCount)||
       s.autoRestartCount<0||s.autoRestartCount>MAX_AUTOMATIC_RESTARTS))||
     (s.autoRestartPending!==undefined&&typeof s.autoRestartPending!=="boolean")||
     (s.manualRecovery!==undefined&&s.manualRecovery!==true)||
     (s.autoRestartPending===true&&!(s.autoRestartCount>0))||
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
      (state.selfCompleted===true?
        (state.totalEligible+1===state.observedMembers?"complete":"partial-consent"):
        "complete-co-members"):"in-progress",
    completed:state.completed,eligibleCoMembers:state.totalEligible,
    remaining:state.totalEligible-state.completed,
    observedMembers:state.observedMembers??null,startedAt:state.startedAt,
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
    const approval=await readCollectibleApprovals(env);
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
// Mark a partially collected automatic campaign for a clean restart on its NEXT
// Cron tick. Do not spend a second provider batch in the failing invocation.
// Keep the old snapshots and completed receipts immutable; the new runId will
// prevent mixing member indexes or sharing permissions across two rosters.
async function scheduleAutomaticRestart(env,fp,previous,campaign,status){
  if(!campaign||!previous||
     !["membership-changed-restart-required","changed-during-read"].includes(status)||
     (previous.autoRestartCount||0)>=MAX_AUTOMATIC_RESTARTS)return null;
  const state={...previous,autoRestartCount:(previous.autoRestartCount||0)+1,
    autoRestartPending:true};
  await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify(state),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  return answer({status:"membership-restart-scheduled"},200);
}
async function finishSelf(env,fp,previous,selected,baseline,now,fetchImpl,tick){
  const old=await oldSelf(env,fp,baseline,now);
  // Only reuse the old personal roster when Scopely confirms the same
  // membership snapshot; collectPersonalRoster validates isSelf both times.
  const report=await collectPersonalRoster(selected.token,fetchImpl,{
    expectedMembershipDigest:previous.membershipDigest,
    cached:old&&baseline?.membershipDigest===previous.membershipDigest?
      {asOf:old.asOf,chars:old.chars}:null,
    includeSourcePayload:true
  });
  if(report.status!=="complete")return answer({status:report.status},409);
  if(old&&report.unchanged&&old.memberId!==report.memberId)
    return answer({status:"identity-changed-during-read"},409);
  const after=await discoverAlliance(selected.token,fetchImpl,{includeSourcePayload:true});
  if(!after.ok||after.aid!==selected.aid)
    return answer({status:"alliance-changed-during-read"},409);
  if(!approvedFingerprint(await readCollectibleApprovals(env),fp))
    return answer({status:"approval-withdrawn"},409);
  await storeAllianceSource(env,fp,previous.runId,now,{
    card:after.sourcePayload,
    before:report.sourceMembershipBefore,after:report.sourceMembershipAfter,
    rosters:[{role:"self",pages:report.sourceResponses}]
  });
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
  // Completion means every currently authorized co-member and this OAuth
  // account were stored. An opt-out is NOT a failed collection. Encode its
  // limited coverage explicitly so consumers never mistake it for 100% of
  // the observed alliance (and never request the unshared roster).
  const authorizedTotal=previous.totalEligible+1;
  if(!Number.isSafeInteger(previous.observedMembers)||
     previous.observedMembers<authorizedTotal||previous.observedMembers>100||
     previous.completed!==previous.totalEligible)
    return answer({status:"invalid-membership-count"},409);
  const notSharedCount=previous.observedMembers-authorizedTotal;
  const complete={version:1,fingerprint:fp,runId:previous.runId,
    membershipDigest:previous.membershipDigest,total:authorizedTotal,
    observedMembers:previous.observedMembers,
    coMembers:previous.totalEligible,includesPersonal:true,
    coverage:notSharedCount?"authorized-only":"all-members",notSharedCount,
    capturedAt:new Date(now).toISOString(),expiresAt:previous.expiresAt};
  // All member snapshots and the owner roster exist before this receipt.
  // A later campaign may overwrite both mutable progress.json and
  // latest-complete.json; never overwrite the receipt for ANOTHER campaign.
  const completedState={...previous,selfCompleted:true,lastAutoTick:tick};
  const storageOptions={
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  };
  if(previous.campaign){
    await env.CAPTAIN_BUCKET.put(campaignCompleteKey(fp,previous.campaign),
      JSON.stringify({version:1,campaign:previous.campaign,
        ...(previous.manualRecovery===true?{manualRecovery:true}:{}),
        progress:completedState,manifest:complete}),storageOptions);
  }
  // Preserve existing live pointers and roster scheduler behavior unchanged.
  await env.CAPTAIN_BUCKET.put(completeKey(fp),JSON.stringify(complete),
    storageOptions);
  await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify(completedState),
    storageOptions);
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
    const approval=await readCollectibleApprovals(env);
    if(!approvedFingerprint(approval,fp))return answer({status:"alliance-not-approved"},403);
    const status=await lock(env,fp,"acquire",holder);
    if(status!=="acquired")return answer({status:status==="busy"?"busy":"lock-unavailable"},409);
    acquired=true;
    let campaign=typeof internal?.campaign==="string"&&
      /^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(internal.campaign)?
      internal.campaign:null;
    const fullMode=campaign&&env.ROSTER_FULL_COLLECTION_ENABLED==="true";
    let previous=restart?null:await readState(env,fp);
    // Complete the previous unfinished AM/PM campaign before starting a new
    // generation. The same runId and member indexes remain immutable.
    if(campaign&&previous?.campaign!==campaign){
      if(fullMode&&previous?.campaign&&previous.selfCompleted!==true)
        campaign=previous.campaign;
      else previous=null;
    }
    if(previous&&Date.parse(previous.expiresAt)<=now){
      if(fullMode)previous=null; // expired automatic checkpoint: fresh run
      else return answer({...publicState(previous,now),
        status:"expired-restart-required"},409);
    }
    if(refresh&&(!previous||previous.completed!==previous.totalEligible))
      return answer({status:"refresh-requires-complete-run"},409);
    if(campaign&&previous?.lastAutoTick===internal.tick)
      return answer({status:"already-processed-tick"},200);
    const restarting=Boolean(campaign&&previous?.autoRestartPending);
    const autoRestartCount=campaign?(previous?.autoRestartCount||0):0;
    // Only a scheduled tick consumes the pending restart. Deliberate manual
    // operations remain governed by their existing explicit restart option.
    if(restarting)previous=null;
    if(previous&&previous.completed===previous.totalEligible&&!refresh&&
       (!campaign||previous.selfCompleted===true))
      return answer(publicState(previous,now));
    // Never reuse a pre-change baseline when starting the replacement run.
    const pointer=campaign&&!restarting?await latestComplete(env,fp,now):null;
    let baseline=campaign?(previous?.baseline||
      (pointer?{runId:pointer.runId,membershipDigest:pointer.membershipDigest,
        expiresAt:pointer.expiresAt}:null)):
      refresh?{runId:previous.runId,membershipDigest:previous.membershipDigest,
        expiresAt:previous.expiresAt}:previous?.baseline;
    if(refresh)previous=null;
    const selected=await chooseAccount(env,fp,fetchImpl);
    if(selected.status!=="ok")return answer({status:selected.status},409);
    // This is independent of roster pages and survives their later failures.
    // Failure of this auxiliary archive must not compromise roster collection.
    try{await storeEarlyTrophyCard(env,fp,internal.campaign||campaign,
      selected.sourcePayload,now);}
    catch{/* The next scheduled tick may try again. */}
    if(campaign&&previous&&previous.completed===previous.totalEligible){
      const finalPrevious=internal.manualRecovery===true?
        {...previous,manualRecovery:true}:previous;
      const response=await finishSelf(env,fp,finalPrevious,selected,baseline,now,fetchImpl,internal.tick);
      if(response.status!==409)return response;
      const {status}=await response.clone().json();
      if(fullMode&&status==="request-budget")
        return answer({...publicState(previous,now),status:"complete-co-members",
          deferredPersonal:true},200);
      return await scheduleAutomaticRestart(env,fp,previous,campaign,status)||response;
    }
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
    const remainingRequests=fullMode&&typeof fetchImpl.remainingRequests==="function"?
      fetchImpl.remainingRequests():null;
    // Leave one provider call for the independent final alliance validation.
    if(fullMode&&remainingRequests!==null&&remainingRequests<5)
      return answer({...publicState(previous,now),status:"budget-deferred"},200);
    const options={
      maxMembers:fullMode?FULL_ALLIANCE_BATCH_SIZE:
        campaign?AUTOMATIC_BATCH_SIZE:BATCH_SIZE,startIndex,charInfo:true,
      ...(fullMode?{partialOnBudget:true,
        ...(remainingRequests!==null?{
          maxRequests:Math.min(300,remainingRequests-1)}:{})}:{}),
      parallelMembers:Boolean(campaign),
      preferSinglePage:true,cachedForMember,
      requireCurrentMembership:true,requireStableMembership:true,
      includeMembershipDigest:true,includeSourcePayload:true,
      ...(previous||baseline?{expectedMembershipDigest:
        previous?.membershipDigest||baseline.membershipDigest}:{})
    };
    let result=await collectAllianceRosterSample(selected.token,fetchImpl,options);
    let extraRequests=0;
    // The old valid baseline becomes unusable after a transfer/consent change.
    // Automatically start a clean NEW campaign rather than remain stuck for 7 days.
    if(result.status==="membership-changed-restart-required"&&
       campaign&&!previous&&baseline){
      extraRequests=result.requests||0;
      baseline=null;
      result=await collectAllianceRosterSample(selected.token,fetchImpl,{
        ...options,cachedForMember:undefined,expectedMembershipDigest:undefined
      });
    }
    if(result.status==="request-budget"&&fullMode)
      return answer({...publicState(previous,now),status:"budget-deferred"},200);
    if(result.status!=="complete")
      return await scheduleAutomaticRestart(env,fp,previous,campaign,result.status)||
        answer({status:result.status},409);
    if(previous&&(previous.membershipDigest!==result.membershipDigest||
       previous.totalEligible!==result.sharedCount))
      return await scheduleAutomaticRestart(env,fp,previous,campaign,
        "membership-changed-restart-required")||
        answer({status:"membership-changed-restart-required"},409);
    if(!result.sharedCount){
      if(!campaign)return answer({status:"no-shared-co-members"},409);
      // No co-member permits roster sharing: the captain's OWN authorized
      // roster is still accessible via OAuth. Archive that source only;
      // never probe /roster/member without consent.
      if(previous)return answer({status:"invalid-zero-member-progress"},409);
      const selfOnly={
        version:1,fingerprint:fp,runId:crypto.randomUUID(),
        membershipDigest:result.membershipDigest,
        startedAt:new Date(now).toISOString(),
        expiresAt:new Date(now+BATCH_MAX_AGE_MS).toISOString(),
        totalEligible:0,completed:0,observedMembers:result.memberCount,
        campaign,selfCompleted:false,lastAutoTick:internal.tick,
        autoRestartCount,
        ...(internal.manualRecovery===true?{manualRecovery:true}:{})
      };
      return await finishSelf(env,fp,selfOnly,selected,baseline,now,fetchImpl,internal.tick);
    }
    if(result.selectedCount<1||result.rosters.length!==result.selectedCount||
       result.rosters.some(r=>!Array.isArray(r.chars)||r.chars.length===0))
      return answer({status:"no-complete-roster"},409);
    const stillCurrent=await discoverAlliance(selected.token,fetchImpl,{includeSourcePayload:true});
    if(!stillCurrent.ok||stillCurrent.aid!==selected.aid)
      return answer({status:"alliance-changed-during-read"},409);
    if(!approvedFingerprint(await readCollectibleApprovals(env),fp))
      return answer({status:"approval-withdrawn"},409);
    // The lock ensures only one writer updates the alliance's current progress.
    const runId=previous?.runId||crypto.randomUUID();
    const startedAt=previous?.startedAt||new Date(now).toISOString();
    const expiresAt=previous?.expiresAt||new Date(now+BATCH_MAX_AGE_MS).toISOString();
    // Read endpoints were already called above. Preserve their full envelopes
    // without spending extra provider quota or disclosing them to browsers.
    await storeAllianceSource(env,fp,runId,now,{
      card:stillCurrent.sourcePayload,
      before:result.sourceMembershipBefore,
      after:result.sourceMembershipAfter,
      rosters:result.rosters.map((roster,i)=>({
        role:"member-"+(startIndex+i),pages:roster.sourceResponses
      }))
    });
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
      observedMembers:result.memberCount,
      ...(campaign?{campaign,selfCompleted:false,lastAutoTick:internal.tick,
        autoRestartCount,
        ...((internal.manualRecovery===true||previous?.manualRecovery===true)?
          {manualRecovery:true}:{})}:{}),
      ...(baseline?{baseline}:{})
    };
    await env.CAPTAIN_BUCKET.put(stateKey(fp),JSON.stringify(updated),{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    // The captain's personal roster can be finalized immediately in the same
    // invocation. If the Cloudflare budget runs out, keep the complete member
    // prefix in R2 and finish only the missing work on the next scheduled tick.
    if(fullMode&&updated.completed===updated.totalEligible){
      const finished=await finishSelf(env,fp,updated,selected,baseline,
        now,fetchImpl,internal.tick);
      if(finished.ok){
        const payload=await finished.json();
        return answer({...payload,
          savedThisBatch:result.selectedCount+(payload.savedThisBatch||0),
          charactersThisBatch:result.characterCount+
            (payload.charactersThisBatch||0)});
      }
      const {status}=await finished.clone().json();
      if(status!=="request-budget")
        return await scheduleAutomaticRestart(env,fp,updated,campaign,status)||finished;
    }
    return answer({...publicState(updated,now),
      savedThisBatch:result.selectedCount,charactersThisBatch:result.characterCount,
      pagesThisBatch:result.pages,unchangedThisBatch:result.unchangedCount,
      requestsThisBatch:result.requests+extraRequests+(selected.discoveryRequests||0)+1,
      storage:"private-r2",publiclyAvailable:false});
  }catch{return answer({status:"batch-unavailable"},503);}
  finally{if(acquired)try{await lock(env,fp,"release",holder);}catch{}}
}
