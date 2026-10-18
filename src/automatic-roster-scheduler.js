// Opt-in private roster scheduler. No public snapshots, WebApp pushes or Sheets writes.
import {captainConfigReady} from "./captain-vault.js";
import {readApproval} from "./roster-sync-preflight.js";
import {handleRosterMicrobatch} from "./private-roster-batches.js";

export const ROSTER_CRON="*/2 2-5,14-17 * * *";
export const DAILY_API_BUDGET=950;
export const TICK_API_BUDGET=18;
const ROOT="roster-auto/v1/";
const GLOBAL_LOCK="f".repeat(64); // A separate Durable Object from the alliance locks.
const BASE_URL="https://losp-roster-service.deliriousfan7.workers.dev";
const MINUTE=60000;
const dayKey=d=>ROOT+"days/"+d+".json";
const pauseKey=fp=>ROOT+"cooldown/"+fp+".json";
const dateOf=ms=>new Date(ms).toISOString().slice(0,10);

async function read(bucket,key){
  const obj=await bucket.get(key);
  if(!obj)return null;
  const raw=await obj.text();
  if(raw.length>7000)throw Error("invalid scheduler state");
  return JSON.parse(raw);
}
async function write(bucket,key,value){
  await bucket.put(key,JSON.stringify(value),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
}
async function lease(env,action,holder){
  const b=env.ROSTER_BATCH_LOCK;
  const stub=b.get(b.idFromName(GLOBAL_LOCK));
  const res=await stub.fetch(new Request("https://roster-lock.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,holder,fingerprint:GLOBAL_LOCK})
  }));
  return res.ok&&(await res.json()).status===
    (action==="acquire"?"acquired":"released");
}
export function rosterWindow(cron,scheduledTime){
  if(cron!==ROSTER_CRON||!Number.isFinite(scheduledTime))return null;
  const d=new Date(scheduledTime),h=d.getUTCHours(),m=d.getUTCMinutes();
  if(m%2!==0||d.getUTCSeconds()!==0)return null;
  let period,start;
  if(h>=2&&h<=5){period="am";start=2;}
  else if(h>=14&&h<=17){period="pm";start=14;}
  else return null;
  const date=dateOf(scheduledTime),tick=(h-start)*30+m/2;
  return {date,campaign:date+"-"+period,tick,
    stamp:d.toISOString().slice(0,16)+"Z"};
}
export async function rosterAutoStatus(env,time=Date.now()){
  const enabled=env?.ROSTER_AUTO_ENABLED==="true";
  const retention=env?.ROSTER_RETENTION_CONFIRMED==="true";
  const out={enabled,retentionConfirmed:retention,
    dailyBudget:DAILY_API_BUDGET,perTickBudget:TICK_API_BUDGET,
    utcWindows:["02:00–06:00","14:00–18:00"],frequencyMinutes:2};
  if(!captainConfigReady(env))return {status:"storage-unavailable",...out};
  try{
    const data=await read(env.CAPTAIN_BUCKET,dayKey(dateOf(time)));
    return {status:enabled&&retention?"ready":"disabled",...out,
      requestsToday:Number.isSafeInteger(data?.used)?data.used:0,
      lastOutcome:typeof data?.lastOutcome==="string"?data.lastOutcome:null,
      lastTick:typeof data?.lastTick==="string"?data.lastTick:null};
  }catch{return {status:"unavailable",...out};}
}
export async function runRosterAutoTick(env,controller,fetchImpl=fetch){
  if(env?.ROSTER_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")
    return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env)||!env.ROSTER_BATCH_LOCK?.get)
    return {status:"storage-unavailable"};
  const timestamp=controller?.scheduledTime;
  const slot=rosterWindow(controller?.cron,timestamp);
  if(!slot)return {status:"outside-window"};
  const holder=crypto.randomUUID();
  let acquired=false;
  try{
    acquired=await lease(env,"acquire",holder);
    if(!acquired)return {status:"busy"};
    const bucket=env.CAPTAIN_BUCKET;
    const raw=await read(bucket,dayKey(slot.date));
    // Invalid counter states are fail-closed, never replaced with zero.
    if(raw&&(raw.date!==slot.date||!Number.isSafeInteger(raw.used)||
       raw.used<0||raw.used>DAILY_API_BUDGET||
       !Number.isSafeInteger(raw.ticks)||raw.ticks<0))
      return {status:"invalid-budget-state"};
    const d=raw||{date:slot.date,used:0,ticks:0,lastTick:null};
    if(d.lastTick===slot.stamp)return {status:"already-processed"};
    if(d.used+TICK_API_BUDGET>DAILY_API_BUDGET)
      return {status:"daily-budget-reached",requestsToday:d.used};
    const approval=await readApproval(env);
    if(approval.status!=="configured"||!approval.alliances.length)
      return {status:"no-approved-alliances"};
    const alliances=approval.alliances.map(a=>a.fingerprint).sort();
    if(new Set(alliances).size!==alliances.length||
       alliances.includes(GLOBAL_LOCK))return {status:"invalid-approvals"};
    const fp=alliances[slot.tick%alliances.length];
    const pause=await read(bucket,pauseKey(fp));
    let used=0,outcome="cooldown",statusCode=200;
    if(!pause||!Number.isFinite(Date.parse(pause.until))||
       Date.parse(pause.until)<=timestamp){
      const limitedFetch=async(url,options)=>{
        // Count every attempted provider API request, including 344, 429 and 472.
        if(new URL(url).hostname==="api.marvelstrikeforce.com"){
          if(used>=TICK_API_BUDGET)throw Error("scopely-tick-budget");
          used++;
        }
        return fetchImpl(url,options);
      };
      const req=new Request(BASE_URL+"/admin/api/roster-batch",{
        method:"POST",headers:{Origin:BASE_URL,"Content-Type":"application/json"},
        body:JSON.stringify({fingerprint:fp})
      });
      try{
        const res=await handleRosterMicrobatch(req,env,limitedFetch,timestamp,{
          campaign:slot.campaign,tick:slot.stamp
        });
        statusCode=res.status;
        const result=await res.json();
        outcome=typeof result.status==="string"?
          result.status.slice(0,65):"unavailable";
      }catch{outcome="unavailable";statusCode=503;}
      if(statusCode!==200&&outcome!=="busy"&&outcome!=="already-processed-tick"){
        // Back off significantly for rate-limits, and avoid hammering failures.
        await write(bucket,pauseKey(fp),{
          until:new Date(timestamp+(outcome==="rate-limited"?60:20)*MINUTE)
            .toISOString(),reason:outcome==="rate-limited"?"429":"error"
        });
      }else{
        await bucket.delete(pauseKey(fp));
      }
    }
    await write(bucket,dayKey(slot.date),{
      date:slot.date,used:d.used+used,ticks:d.ticks+1,
      lastTick:slot.stamp,lastOutcome:outcome
    });
    return {status:outcome,requestsThisTick:used,
      requestsToday:d.used+used,httpStatus:statusCode};
  }catch{return {status:"unavailable"};}
  finally{if(acquired)try{await lease(env,"release",holder);}catch{}}
}
