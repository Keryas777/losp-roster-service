// Explicit, admin-only ONE shared roster pilot.
// No cron collection, no WebApp push, no public download, no Google Sheets writes.
import {CAPTAIN_PREFIX,validCaptainKey,captainConfigReady} from "./captain-vault.js";
import {discoverAlliance,MAX_COVERAGE_SESSIONS} from "./alliance-coverage.js";
import {readApproval} from "./roster-sync-preflight.js";
import {collectAllianceRosterSample} from "./roster-collector.js";

export const ROSTER_PILOT_PREFIX="roster-pilot/v1/latest/";
export const ROSTER_PILOT_MAX_AGE_MS=7*24*60*60*1000;
const fingerprintPattern=/^[0-9a-f]{64}$/;
const MAX_PILOT_BYTES=3_000_000;
const secureHeaders={
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"
};
const answer=(data,status=200)=>Response.json(data,{status,headers:secureHeaders});
async function fingerprint(aid){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(aid));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function accessToken(env,key){
  const id=env.CAPTAIN_REFRESH_COORDINATOR.idFromName(key);
  const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(id);
  const res=await stub.fetch(new Request("https://captain-coordinator.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"access",key})
  }));
  if(!res.ok)return null;
  const data=await res.json();
  return data.status==="active"&&typeof data.accessToken==="string"&&data.accessToken?
    data.accessToken:null;
}
export function approvedFingerprint(approval,fp){
  return approval.status==="configured"&&approval.alliances.some(a=>a.fingerprint===fp);
}
export async function chooseAccount(env,requested,fetchImpl){
  const listed=await env.CAPTAIN_BUCKET.list({
    prefix:CAPTAIN_PREFIX,limit:MAX_COVERAGE_SESSIONS+1
  });
  if(listed.truncated||(listed.objects||[]).length>MAX_COVERAGE_SESSIONS)
    return {status:"session-census-incomplete"};
  const keys=(listed.objects||[]).filter(o=>validCaptainKey(o.key))
    .map(o=>o.key).sort();
  for(const key of keys){
    const token=await accessToken(env,key).catch(()=>null);
    if(!token)continue;
    const current=await discoverAlliance(token,fetchImpl);
    if(!current.ok)continue;
    if(await fingerprint(current.aid)===requested)
      return {status:"ok",token,aid:current.aid,name:current.name};
  }
  return {status:"approved-alliance-unavailable"};
}
async function collectPilot(env,selected,fp,fetchImpl,now){
  // Each pilot gathers exactly one already-shared OTHER member.
  // The self roster will receive its separate, scope-aware collector later.
  const result=await collectAllianceRosterSample(selected.token,fetchImpl,{
    maxMembers:1,charInfo:true,requireCurrentMembership:true,
    requireStableMembership:true
  });
  if(result.status!=="complete")return {status:result.status};
  if(result.completedCount!==1||result.rosters?.length!==1)
    return {status:"no-eligible-shared-member"};
  const roster=result.rosters[0];
  if(!Array.isArray(roster.chars)||!roster.chars.length)
    return {status:"empty-roster"};
  // Reconfirm the captain still belongs to the same APPROVED alliance.
  const after=await discoverAlliance(selected.token,fetchImpl);
  if(!after.ok||after.aid!==selected.aid)
    return {status:"alliance-changed-during-read"};
  const approvalAgain=await readApproval(env);
  if(!approvedFingerprint(approvalAgain,fp))
    return {status:"approval-withdrawn"};
  const record={
    version:1,kind:"private-manual-pilot",capturedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+ROSTER_PILOT_MAX_AGE_MS).toISOString(),
    allianceFingerprint:fp,allianceName:after.name,
    playerName:typeof roster.name==="string"?roster.name.slice(0,140):"",
    // Not a permanent identity! Never use memberId as a long-term player key.
    memberIdVolatile:roster.memberId,
    characters:roster.chars
  };
  const raw=JSON.stringify(record);
  if(raw.length>MAX_PILOT_BYTES)return {status:"snapshot-too-large"};
  await env.CAPTAIN_BUCKET.put(ROSTER_PILOT_PREFIX+fp+".json",raw,{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  return {status:"stored",alliance:after.name,player:record.playerName,
    characters:roster.chars.length,pages:result.pages,requests:result.requests+2,
    capturedAt:record.capturedAt,expiresAt:record.expiresAt,
    storage:"private-r2",publiclyAvailable:false};
}

export async function handlePrivateRosterPilot(request,env,fetchImpl=fetch,now=Date.now()){
  if(request.method!=="POST")return answer({status:"method-not-allowed"},405);
  if(!captainConfigReady(env))return answer({status:"storage-unavailable"},503);
  const url=new URL(request.url);
  if(request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return answer({status:"forbidden"},403);
  let requested;
  try{
    const raw=await request.text();
    if(raw.length>256)throw Error("payload too long");
    const parsed=JSON.parse(raw);
    if(!parsed||Object.keys(parsed).length!==1||
       !fingerprintPattern.test(parsed.fingerprint))throw Error("invalid");
    requested=parsed.fingerprint;
  }catch{return answer({status:"invalid-selection"},400);}
  try{
    const approval=await readApproval(env);
    if(!approvedFingerprint(approval,requested))
      return answer({status:"alliance-not-approved"},403);
    const account=await chooseAccount(env,requested,fetchImpl);
    if(account.status!=="ok")return answer({status:account.status},409);
    const outcome=await collectPilot(env,account,requested,fetchImpl,now);
    return outcome.status==="stored"?answer(outcome):
      answer(outcome,409);
  }catch{return answer({status:"pilot-unavailable"},503);}
}

// Daily cleanup shares the EXISTING maintenance cron; never initiates API
// Scopely reads or collect operations. Lifecycle TTL on R2 is also recommended.
export async function prunePrivateRosterPilots(env,now=Date.now()){
  if(!env?.CAPTAIN_BUCKET?.list||!env?.CAPTAIN_BUCKET?.delete||
     !env?.CAPTAIN_BUCKET?.get)return {status:"disabled"};
  try{
    const approval=await readApproval(env);
    const allowed=new Set(approval.status==="configured"?
      approval.alliances.map(a=>a.fingerprint):[]);
    let deleted=0,checked=0,cursor;
    for(let page=0;page<4;page++){
      const list=await env.CAPTAIN_BUCKET.list({
        prefix:ROSTER_PILOT_PREFIX,limit:100,
        ...(cursor?{cursor}:{})
      });
      for(const item of list.objects||[]){
        checked++;
        const fp=item.key.slice(ROSTER_PILOT_PREFIX.length).replace(/\.json$/,"");
        // Fail closed on deleted approvals, even before the seven-day TTL.
        const stale=Number.isFinite(new Date(item.uploaded).getTime())&&
          now-new Date(item.uploaded).getTime()>=ROSTER_PILOT_MAX_AGE_MS;
        if(!fingerprintPattern.test(fp)||!allowed.has(fp)||stale){
          await env.CAPTAIN_BUCKET.delete(item.key);
          deleted++;
        }
      }
      if(!list.truncated)break;
      if(!list.cursor||list.cursor===cursor)return {status:"partial",checked,deleted};
      cursor=list.cursor;
    }
    return {status:"checked",checked,deleted};
  }catch{return {status:"unavailable"};}
}
