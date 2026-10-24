// Session-scoped, opt-in PRIVATE personal roster. Never reads another player.
// Every record stays under the existing seven-day R2 lifecycle prefix.
import {CAPTAIN_PREFIX,validCaptainKey,captainConfigReady} from "./captain-vault.js";
import {collectPersonalRoster} from "./roster-collector.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {CONNECTED_ALLIANCE_PREFIX} from "./connected-alliance-index.js";

const ROOT="roster-batches/v1/connected-personal-rosters/";
const SIZE=3_000_000;
const AGE=7*86400000;
const HEX=/^[a-f0-9]{64}$/;
const key=id=>ROOT+id;
const indexed=key=>CONNECTED_ALLIANCE_PREFIX+key.slice(CAPTAIN_PREFIX.length);
const metadata={httpMetadata:{contentType:"application/json",
  cacheControl:"private, no-store"}};
const sha=async text=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,"0")).join("");

function validStored(value,session,now){
  return value?.version===1&&value.session===session&&
    HEX.test(value.allianceFingerprint)&&Array.isArray(value.characters)&&
    value.characters.length>0&&typeof value.capturedAt==="string"&&
    Number.isFinite(Date.parse(value.expiresAt))&&
    Date.parse(value.expiresAt)>now&&
    (value.campaign===undefined||/^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(value.campaign));
}
export async function readConnectedPersonalRoster(env,sessionKey,now=Date.now()){
  if(!validCaptainKey(sessionKey))return null;
  const session=sessionKey.slice(CAPTAIN_PREFIX.length);
  const item=await env.CAPTAIN_BUCKET.get(key(session)+"/latest.json");
  if(!item||Number.isFinite(item.size)&&item.size>SIZE)return null;
  try{
    const raw=await item.text();
    if(raw.length>SIZE)return null;
    const data=JSON.parse(raw);
    return validStored(data,session,now)?data:null;
  }catch{return null;}
}

// Uses an exact CURRENT AllianceCard and membership digest before/after the
// personal roster fetch. No member rosters, alliance-wide scan or approval.
export async function captureConnectedPersonalRoster(env,sessionKey,token,
    fetchImpl=fetch,now=Date.now(),campaign=null,expectedFingerprint=null){
  if(!captainConfigReady(env)||!validCaptainKey(sessionKey)||
     typeof token!=="string"||!token)return {status:"unavailable"};
  const session=sessionKey.slice(CAPTAIN_PREFIX.length);
  try{
    const before=await discoverAlliance(token,fetchImpl);
    if(!before.ok)return {status:before.status};
    const fingerprint=await sha(before.aid);
    if(expectedFingerprint&&expectedFingerprint!==fingerprint)
      return {status:"alliance-changed"};
    const previous=await readConnectedPersonalRoster(env,sessionKey,now);
    if(campaign&&previous?.campaign===campaign)
      return {status:"already-collected"};
    // The personal roster endpoint is the current account's own inventory;
    // Scopely alone authorizes its contents with this session's token.
    const collected=await collectPersonalRoster(token,fetchImpl,{
      cached:previous?.asOf?{asOf:previous.asOf,chars:previous.characters}:null,
      includeSourcePayload:true
    });
    if(collected.status!=="complete")return {status:collected.status};
    const after=await discoverAlliance(token,fetchImpl);
    if(!after.ok||after.aid!==before.aid)
      return {status:"alliance-changed"};
    const timestamp=new Date(now).toISOString();
    const expiresAt=new Date(now+AGE).toISOString();
    const record={version:1,kind:"private-consented-personal-roster",
      session,allianceFingerprint:fingerprint,allianceName:after.name,
      playerName:collected.name,volatileMemberId:collected.memberId,
      capturedAt:timestamp,expiresAt,asOf:collected.asOf||null,
      ...(campaign?{campaign}:{}),
      characters:collected.chars};
    const raw=JSON.stringify(record);
    if(raw.length>SIZE)return {status:"too-large"};
    // Preserve original Scopely envelopes only in the private capture object.
    const source=JSON.stringify({version:1,kind:"private-provider-source",
      capturedAt:timestamp,allianceFingerprint:fingerprint,session,
      membersBefore:collected.sourceMembershipBefore,
      membersAfter:collected.sourceMembershipAfter,
      pages:collected.sourceResponses});
    if(source.length>SIZE)return {status:"source-too-large"};
    const run=crypto.randomUUID();
    await env.CAPTAIN_BUCKET.put(key(session)+"/"+run+"/source.json",source,metadata);
    await env.CAPTAIN_BUCKET.put(key(session)+"/"+run+"/roster.json",raw,metadata);
    // Pointer written last: never publish an incomplete personal snapshot.
    await env.CAPTAIN_BUCKET.put(key(session)+"/latest.json",raw,metadata);
    return {status:"stored",characters:collected.chars.length,
      requests:collected.requests+2,alliance:after.name};
  }catch{return {status:"unavailable"};}
}

export async function collectOneConnectedAllianceRoster(env,fp,maxConnected,
    campaign,fetchImpl=fetch,now=Date.now()){
  if(!HEX.test(fp)||!Number.isSafeInteger(maxConnected)||maxConnected<1||
     maxConnected>24||!/^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(campaign))
    return {status:"invalid-config"};
  const {listCaptainSessionKeys}=await import("./alliance-coverage.js");
  // All session keys are opaque and independent. The quota applies only to
  // explicit current OAuth participants, never other roster-sharing members.
  const keys=await listCaptainSessionKeys(env.CAPTAIN_BUCKET);
  let collected=0,attempted=0;
  for(const captainKey of keys){
    const obj=await env.CAPTAIN_BUCKET.get(indexed(captainKey));
    if(!obj)continue;
    let directory;
    try{directory=JSON.parse(await obj.text());}catch{continue;}
    if(directory?.fingerprint!==fp)continue;
    attempted++;
    // Strictly stop at the configured number of connected accounts.
    if(attempted>maxConnected)break;
    const existing=await readConnectedPersonalRoster(env,captainKey,now);
    if(existing?.campaign===campaign){collected++;continue;}
    const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(
      env.CAPTAIN_REFRESH_COORDINATOR.idFromName(captainKey));
    const res=await stub.fetch(new Request("https://captain-coordinator.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"access",key:captainKey})
    }));
    if(!res.ok)return {status:"session-unavailable"};
    const grant=await res.json();
    if(grant.status!=="active"||typeof grant.accessToken!=="string")continue;
    return captureConnectedPersonalRoster(env,captainKey,grant.accessToken,
      fetchImpl,now,campaign,fp);
  }
  return {status:collected?"complete":"no-connected-accounts",
    completed:collected,connected:Math.min(attempted,maxConnected)};
}
