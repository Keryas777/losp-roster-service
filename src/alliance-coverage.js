// PRIVATE multi-alliance discovery, deliberately not a roster synchronizer.
// Never export raw member IDs, player names, tokens, or data to GitHub Pages.
import { API_KEY } from "./player-card.js";
import { CAPTAIN_PREFIX, validCaptainKey, captainConfigReady } from "./captain-vault.js";

const ROOT="https://api.marvelstrikeforce.com";
export const COVERAGE_KEY="oauth-coverage/v1/latest.json";
export const MAX_COVERAGE_SESSIONS=12;
const MAX_JSON_BYTES=160000;
const fail=(status)=>({ok:false,status});
const safeInteger=(v)=>Number.isSafeInteger(v)&&v>=0?v:null;
const validName=(v)=>typeof v==="string"&&v.trim().length>0&&v.length<=140;
const validMemberId=(v)=>typeof v==="string"&&v.length>0&&v.length<=256;

// Scopely's AllianceId is documented as "{aid}:{member_version}".
// Only the left-hand aid persists across changes of alliance membership.
export function stableAllianceId(value){
  if(typeof value!=="string")return null;
  const m=/^([^:\\s]{1,128}):([^:\\s]{1,128})$/.exec(value);
  return m?m[1]:null;
}
async function jsonGet(path,token,fetchImpl){
  try{
    const res=await fetchImpl(ROOT+path,{
      method:"GET",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(9000),
      headers:{
        "x-api-key":API_KEY,"User-Agent":"APIClient/1.0 (Server)",
        Authorization:"Bearer "+token,Accept:"application/json"
      }
    });
    if(!res.ok)return fail(res.status===401?"unauthorized":
      res.status===403?"forbidden":res.status===429?"rate-limited":"provider-unavailable");
    if(Number(res.headers.get("content-length")||0)>MAX_JSON_BYTES)return fail("oversized");
    const raw=await res.text();
    if(raw.length>MAX_JSON_BYTES)return fail("oversized");
    const v=JSON.parse(raw);
    return v?.data===undefined?fail("invalid-data"):{ok:true,data:v.data};
  }catch{return fail("network-or-data-error");}
}
export async function discoverAlliance(token,fetchImpl=fetch){
  if(typeof token!=="string"||!token)return fail("missing-token");
  const card=await jsonGet("/player/v1/alliance/card",token,fetchImpl);
  if(!card.ok)return card;
  const data=card.data, aid=stableAllianceId(data?.id);
  if(!aid||!validName(data?.name))return fail("invalid-alliance-card");
  return {ok:true,aid,name:data.name.trim().slice(0,90),
    warRank:safeInteger(data.warRank),raidRank:safeInteger(data.raidRank)};
}
export async function readAllianceCoverage(token,fetchImpl=fetch){
  if(typeof token!=="string"||!token)return fail("missing-token");
  const memberResponse=await jsonGet("/player/v1/alliance/members",token,fetchImpl);
  if(!memberResponse.ok)return memberResponse;
  const members=memberResponse.data;
  if(!Array.isArray(members)||members.length>100||members.length===0)
    return fail("invalid-members");
  let self=0,shared=0,otherShared=0;const ids=new Set();
  for(const member of members){
    if(!member||!validMemberId(member.id)||ids.has(member.id)||
       !member.card||typeof member.card!=="object"||Array.isArray(member.card))
      return fail("invalid-members");
    ids.add(member.id);
    if(member.isSelf===true)self++;
    if(member.card.rosterShare===true){
      shared++;
      if(member.isSelf!==true)otherShared++;
    }
  }
  if(self!==1)return fail("current-membership-unverified");
  return {ok:true,members:members.length,shared,otherShared,
    notShared:members.length-shared};
}
const sha=async(v)=>Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))
)).map(b=>b.toString(16).padStart(2,"0")).join("");
async function grant(env,key){
  const id=env.CAPTAIN_REFRESH_COORDINATOR.idFromName(key);
  const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(id);
  const r=await stub.fetch(new Request("https://captain-coordinator.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"access",key})
  }));
  if(!r.ok)return fail("session-unavailable");
  const d=await r.json();
  if(d.status!=="active"||typeof d.accessToken!=="string"||!d.accessToken)
    return fail(d.status==="revoked"?"revoked":"session-unavailable");
  return {ok:true,token:d.accessToken};
}
export async function buildPrivateCoverage(env,fetchImpl=fetch){
  if(!captainConfigReady(env)||env.CAPTAIN_COVERAGE_ENABLED!=="true")
    return {status:"disabled"};
  const listed=await env.CAPTAIN_BUCKET.list({
    prefix:CAPTAIN_PREFIX,limit:MAX_COVERAGE_SESSIONS+1
  });
  // Limit the daily diagnostic to a safe bounded provider request budget.
  const keys=(listed.objects||[]).filter(v=>validCaptainKey(v.key))
    .map(v=>v.key).sort().slice(0,MAX_COVERAGE_SESSIONS);
  const groups=new Map();
  let unavailable=0;
  for(const key of keys){
    let auth;
    try{auth=await grant(env,key);}catch{unavailable++;continue;}
    if(!auth.ok){unavailable++;continue;}
    const card=await discoverAlliance(auth.token,fetchImpl);
    if(!card.ok){unavailable++;continue;}
    const previous=groups.get(card.aid)||{sessions:[]};
    previous.name=card.name;previous.warRank=card.warRank;
    previous.raidRank=card.raidRank;
    previous.sessions.push({key,token:auth.token});
    groups.set(card.aid,previous);
  }
  const alliances=[];
  for(const [aid,g] of groups){
    // Multiple captains in one alliance: only one fresh member query is
    // normally made; try another captain only if the first provider request fails.
    let result=fail("unavailable");
    for(const session of g.sessions){
      result=await readAllianceCoverage(session.token,fetchImpl);
      if(result.ok)break;
    }
    alliances.push({
      allianceFingerprint:await sha(aid),name:g.name,
      captainConnections:g.sessions.length,
      status:result.ok?"available":result.status,
      memberCount:result.ok?result.members:null,
      sharedCount:result.ok?result.shared:null,
      notSharedCount:result.ok?result.notShared:null,
      warRank:g.warRank,raidRank:g.raidRank
    });
  }
  alliances.sort((a,b)=>a.allianceFingerprint.localeCompare(b.allianceFingerprint));
  const snapshot={
    version:1,mode:"private-discovery-only",
    observedAt:new Date().toISOString(),
    scannedSessions:keys.length,
    unavailableSessions:unavailable,
    // Never confuse an incomplete scan with an exhaustive alliance census.
    complete:!listed.truncated&&(listed.objects||[]).length<=MAX_COVERAGE_SESSIONS
      && unavailable===0&&alliances.every(a=>a.status==="available"),
    alliances
  };
  // Only aggregated data; no player roster, name, token or membership identifier
  // is written to R2. R2 bucket remains private (public access disabled).
  await env.CAPTAIN_BUCKET.put(COVERAGE_KEY,JSON.stringify(snapshot),{
    httpMetadata:{contentType:"application/json",cacheControl:"no-store"}
  });
  return {status:"stored",sessions:keys.length,alliances:alliances.length};
}
