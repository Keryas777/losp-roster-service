// Opt-in single-alliance roster recovery. Admin action only queues in private R2;
// the existing every-minute Cron performs one bounded automatic microbatch.
// No detached tasks, extra cron, public roster data or unapproved collection.
import {captainConfigReady} from "./captain-vault.js";
import {readApproval} from "./roster-sync-preflight.js";
import {BATCH_PREFIX} from "./private-roster-batches.js";
import {manualRosterWindow,runRosterAutoTick,ROSTER_CRON}
  from "./automatic-roster-scheduler.js";
import {rosterCooldownKey} from "./roster-auto-diagnostics.js";

// Existing roster-batches lifecycle purges queue metadata after seven days.
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const FP=/^[a-f0-9]{64}$/;
const ACTIVE=new Set(["queued","running"]);
const QUEUE_LOCK="d".repeat(64);
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
export const rosterRecoveryKey=fp=>BATCH_PREFIX+fp+"/automatic-recovery.json";
const progressKey=fp=>BATCH_PREFIX+fp+"/progress.json";
const clock=ms=>new Date(ms).toISOString();
const answer=(data,status=200)=>Response.json(data,{status,headers:HEADERS});
const iso=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
function recoveryWindow(now){
  if(!Number.isFinite(now))return null;
  const date=new Date(now),hour=date.getUTCHours();
  if(hour<4||(hour>=14&&hour<16))return null;
  const slot=manualRosterWindow(now);
  if(!slot)return null;
  const until=slot.campaign.endsWith("-am")?
    Date.parse(slot.date+"T14:00:00Z"):
    Date.parse(slot.date+"T00:00:00Z")+86400000;
  return {slot,until};
}
async function safeJSON(bucket,key,limit=10000){
  const object=await bucket.get(key);
  if(!object)return null;
  const raw=await object.text();
  if(raw.length>limit)throw Error("invalid-recovery-record");
  return JSON.parse(raw);
}
async function write(bucket,key,value){
  await bucket.put(key,JSON.stringify(value),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
}
function validatedQueue(record,fp){
  if(record===null)return null;
  if(!record||record.version!==1||record.fingerprint!==fp||
     !/^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(record.campaign)||
     !["queued","running","complete","stopped","expired","failed"].includes(record.status)||
     !iso(record.requestedAt)||!iso(record.updatedAt)||!iso(record.deadlineAt)||
     !Number.isSafeInteger(record.attempts)||record.attempts<0||
     (record.lastOutcome!==null&&record.lastOutcome!==undefined&&
       (typeof record.lastOutcome!=="string"||record.lastOutcome.length>70))||
     (record.lastRequests!==undefined&&(!Number.isInteger(record.lastRequests)||
       record.lastRequests<0||record.lastRequests>24)))
    throw Error("invalid-recovery-record");
  return record;
}
async function readQueue(bucket,fp){
  return validatedQueue(await safeJSON(bucket,rosterRecoveryKey(fp)),fp);
}
function publicQueue(record,now=Date.now()){
  if(!record)return {status:"not-started"};
  const status=ACTIVE.has(record.status)&&now>=Date.parse(record.deadlineAt)?
    "expired":record.status;
  return {status,campaign:record.campaign,requestedAt:record.requestedAt,
    updatedAt:record.updatedAt,deadlineAt:record.deadlineAt,
    attempts:record.attempts,lastOutcome:record.lastOutcome||null,
    lastRequests:record.lastRequests??0,
    ...(record.githubDispatch?{githubDispatch:record.githubDispatch}:{})};
}
export async function readRosterRecoveryStatus(bucket,fp,now=Date.now()){
  if(!FP.test(fp))return {status:"invalid"};
  try{return publicQueue(await readQueue(bucket,fp),now);}
  catch{return {status:"invalid"};}
}
// Separate short-lived Durable Object lease for queue state only. The main
// scheduler's GLOBAL_LOCK and each alliance's existing lock are untouched.
async function withQueueLock(env,fn){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.get||!binding?.idFromName)throw Error("lock-unavailable");
  const holder=crypto.randomUUID();
  const stub=binding.get(binding.idFromName(QUEUE_LOCK));
  const send=async action=>{
    const response=await stub.fetch(new Request("https://recovery-lock.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,holder,fingerprint:QUEUE_LOCK})
    }));
    return response.ok&&(await response.json()).status===
      (action==="acquire"?"acquired":"released");
  };
  if(!await send("acquire"))return {status:"busy"};
  try{return await fn();}
  finally{try{await send("release");}catch{}}
}
function configured(env){
  return env?.ROSTER_AUTO_ENABLED==="true"&&
    env?.ROSTER_RETENTION_CONFIRMED==="true"&&
    captainConfigReady(env)&&Boolean(env?.CAPTAIN_BUCKET?.get)&&
    Boolean(env?.CAPTAIN_BUCKET?.put)&&Boolean(env?.ROSTER_BATCH_LOCK?.get);
}
// Only called behind handleAdmin's Cloudflare Access gate.
export async function handleAdminRosterRecovery(request,env,now=Date.now()){
  if(request.method!=="POST")return answer({status:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return answer({status:"forbidden"},403);
  let fingerprint,action;
  try{
    const raw=await request.text();
    if(raw.length>180||!raw.trim())throw Error("invalid");
    const body=JSON.parse(raw);
    if(!body||typeof body!=="object"||Array.isArray(body)||
       Object.keys(body).length!==2||!FP.test(body.fingerprint)||
       !["start","stop"].includes(body.action))
      throw Error("invalid");
    fingerprint=body.fingerprint;action=body.action;
  }catch{return answer({status:"invalid-selection"},400);}
  if(!configured(env))return answer({status:"disabled"},503);
  try{
    const approval=await readApproval(env);
    if(approval.status!=="configured"||
       !approval.alliances.some(a=>a.fingerprint===fingerprint))
      return answer({status:"alliance-not-approved"},403);
    if(action==="start"){
      const window=recoveryWindow(now);
      if(!window)return answer({status:"outside-recovery-window"},409);
      const progress=await safeJSON(env.CAPTAIN_BUCKET,progressKey(fingerprint),30000);
      // Never silently launch a new AM/PM generation or overwrite a completed one.
      if(!progress||progress.version!==1||progress.fingerprint!==fingerprint||
         progress.campaign!==window.slot.campaign||
         !iso(progress.expiresAt)||Date.parse(progress.expiresAt)<=now||
         !Number.isInteger(progress.completed)||
         !Number.isInteger(progress.totalEligible)||
         progress.completed<0||progress.completed>progress.totalEligible||
         progress.selfCompleted===true)
        return answer({status:"no-incomplete-current-campaign"},409);
      const result=await withQueueLock(env,async()=>{
        const stored=await readQueue(env.CAPTAIN_BUCKET,fingerprint);
        if(stored&&ACTIVE.has(stored.status)&&
           stored.campaign===window.slot.campaign&&
           now<Date.parse(stored.deadlineAt))
          return {status:"already-queued",recovery:publicQueue(stored,now)};
        const record={version:1,fingerprint,campaign:window.slot.campaign,
          status:"queued",requestedAt:clock(now),updatedAt:clock(now),
          deadlineAt:clock(window.until),attempts:0,lastOutcome:null,lastRequests:0};
        await write(env.CAPTAIN_BUCKET,rosterRecoveryKey(fingerprint),record);
        return {status:"queued",recovery:publicQueue(record,now)};
      });
      return answer(result,result.status==="busy"?409:200);
    }
    const result=await withQueueLock(env,async()=>{
      const stored=await readQueue(env.CAPTAIN_BUCKET,fingerprint);
      if(!stored||!ACTIVE.has(stored.status)||
         now>=Date.parse(stored.deadlineAt))
        return {status:"not-running",recovery:publicQueue(stored,now)};
      const updated={...stored,status:"stopped",updatedAt:clock(now)};
      await write(env.CAPTAIN_BUCKET,rosterRecoveryKey(fingerprint),updated);
      return {status:"stopped",recovery:publicQueue(updated,now)};
    });
    return answer(result,result.status==="busy"?409:200);
  }catch{return answer({status:"unavailable"},503);}
}
const FATAL=new Set(["alliance-not-approved","invalid-approvals",
  "invalid-budget-state","current-membership-unverified",
  "approval-withdrawn","membership-changed-restart-required",
  "expired-restart-required","invalid-members","invalid-selection"]);
// Reuses an existing cron. At most one alliance and one automatic 24-GET
// microbatch per tick; no fire-and-forget background promises.
export async function runRosterRecoveryTick(env,now=Date.now(),fetchImpl=fetch,
  options={}){
  if(!configured(env))return {status:"disabled",requestsThisTick:0};
  if(!Number.isFinite(now))return {status:"invalid-time",requestsThisTick:0};
  const window=recoveryWindow(now);
  try{
    const approval=await readApproval(env);
    if(approval.status!=="configured")return {status:"not-configured",requestsThisTick:0};
    const alliances=approval.alliances.map(a=>a.fingerprint).filter(fp=>FP.test(fp));
    if(!alliances.length)return {status:"idle",requestsThisTick:0};
    const available=[];
    for(const fp of alliances){
      const queue=await readQueue(env.CAPTAIN_BUCKET,fp);
      if(!queue||!ACTIVE.has(queue.status))continue;
      if(now>=Date.parse(queue.deadlineAt)||
         !window||queue.campaign!==window.slot.campaign){
        await withQueueLock(env,async()=>{
          const current=await readQueue(env.CAPTAIN_BUCKET,fp);
          if(current&&ACTIVE.has(current.status)&&
             (now>=Date.parse(current.deadlineAt)||
              !window||current.campaign!==window.slot.campaign))
            await write(env.CAPTAIN_BUCKET,rosterRecoveryKey(fp),
              {...current,status:"expired",updatedAt:clock(now)});
        });
        continue;
      }
      const pause=await safeJSON(env.CAPTAIN_BUCKET,rosterCooldownKey(fp));
      if(iso(pause?.until)&&Date.parse(pause.until)>now)continue;
      available.push({fp,queue});
    }
    if(!available.length)return {status:"idle",requestsThisTick:0};
    // Round-robin by minute across queued alliances, without selecting
    // any alliance that is temporarily in cooldown.
    available.sort((a,b)=>a.fp.localeCompare(b.fp));
    const selected=available[Math.floor(now/60000)%available.length];
    const reserve=await withQueueLock(env,async()=>{
      const current=await readQueue(env.CAPTAIN_BUCKET,selected.fp);
      if(!current||!ACTIVE.has(current.status)||
         current.campaign!==window.slot.campaign||
         current.requestedAt!==selected.queue.requestedAt||
         now>=Date.parse(current.deadlineAt))
        return {status:"stale"};
      await write(env.CAPTAIN_BUCKET,rosterRecoveryKey(selected.fp),
        {...current,status:"running",updatedAt:clock(now)});
      return {status:"reserved"};
    });
    if(reserve.status!=="reserved")return {status:reserve.status,requestsThisTick:0};
    const result=await runRosterAutoTick(env,{
      scheduledTime:now,cron:ROSTER_CRON},fetchImpl,{
      manual:true,targetFingerprint:selected.fp,
      ...(options.githubFetch?{githubFetch:options.githubFetch}:{})
    });
    const outcome=typeof result.status==="string"?result.status:"unavailable";
    await withQueueLock(env,async()=>{
      const current=await readQueue(env.CAPTAIN_BUCKET,selected.fp);
      // An administrator can stop during an in-flight request; never restore
      // the queue or start additional batches after that cancellation.
      if(!current||!ACTIVE.has(current.status)||
         current.campaign!==window.slot.campaign||
         current.requestedAt!==selected.queue.requestedAt)return;
      const status=["complete","partial-consent"].includes(outcome)?
        "complete":FATAL.has(outcome)?"failed":"queued";
      await write(env.CAPTAIN_BUCKET,rosterRecoveryKey(selected.fp),{
        ...current,status,updatedAt:clock(now),lastOutcome:outcome,
        lastRequests:result.requestsThisTick||0,
        attempts:current.attempts+(result.requestsThisTick>0?1:0),
        ...(result.githubDispatch?{githubDispatch:result.githubDispatch}:{})
      });
    });
    return {status:outcome,requestsThisTick:result.requestsThisTick||0,
      ...(result.githubDispatch?{githubDispatch:result.githubDispatch}:{})};
  }catch{return {status:"unavailable",requestsThisTick:0};}
}
