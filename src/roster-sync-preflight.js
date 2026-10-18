// Private preflight and explicit LoSP alliance approval.
// This module does NOT fetch character rosters, run a cron or publish files.
// Admin approval is separate from Scopely OAuth consent and roster sharing.
import {scanPrivateCoverage} from "./alliance-coverage.js";
import {captainConfigReady} from "./captain-vault.js";

export const ROSTER_APPROVAL_KEY="roster-sync/v1/approved-alliances.json";
const FP=/^[a-f0-9]{64}$/;
const MAX_APPROVED=12;
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"};
const response=(body,status=200)=>Response.json(body,{status,headers});

function validApprovals(value){
  if(!value||value.version!==1||!Array.isArray(value.alliances)||
     value.alliances.length>MAX_APPROVED)return null;
  const seen=new Set();
  for(const item of value.alliances){
    if(!item||!FP.test(item.fingerprint)||typeof item.name!=="string"||
       !item.name.trim()||item.name.length>140||seen.has(item.fingerprint))return null;
    seen.add(item.fingerprint);
  }
  return value.alliances;
}

export async function readApproval(env){
  const item=await env.CAPTAIN_BUCKET.get(ROSTER_APPROVAL_KEY);
  if(!item)return {status:"not-configured",alliances:[]};
  const raw=await item.text();
  if(raw.length>20000)return {status:"invalid-registry",alliances:[]};
  try{
    const record=JSON.parse(raw);
    const alliances=validApprovals(record);
    return alliances?{status:"configured",alliances}:
      {status:"invalid-registry",alliances:[]};
  }catch{return {status:"invalid-registry",alliances:[]};}
}

function currentView(scan,approval){
  const all=(scan.alliances||[]).map(a=>({
    name:a.name,fingerprint:a.allianceFingerprint,
    captainConnections:a.captainConnections,status:a.status,
    memberCount:a.memberCount,sharedCount:a.sharedCount,
    notSharedCount:a.notSharedCount,
    approved:approval.alliances.some(p=>p.fingerprint===a.allianceFingerprint)
  }));
  const discovered=new Set(all.map(x=>x.fingerprint));
  const unobserved=approval.alliances.filter(a=>!discovered.has(a.fingerprint))
    .map(a=>({name:a.name,fingerprint:a.fingerprint}));
  const allowed=all.filter(a=>a.approved);
  return {
    version:1,mode:"approval-preflight-only",observedAt:scan.observedAt,
    registryStatus:approval.status,complete:scan.complete,
    scannedSessions:scan.scannedSessions,unavailableSessions:scan.unavailableSessions,
    alliances:all,unobservedApproved:unobserved,
    approvedCount:approval.alliances.length,
    readyCount:allowed.filter(a=>a.status==="available").length,
    // A connected captain's personal roster needs its own authorized read.
    // SharedCount is NOT the number of guaranteed complete rosters.
    requiresPersonalRosterCheck:true,
    canCollectAutomatically:false,
    // No collection or write of characters is enabled by this module.
    next:"validate-approvals-and-collection-pilot"
  };
}

export async function rosterSyncPreflight(env,fetchImpl=fetch){
  if(!captainConfigReady(env))return response({error:"storage-unavailable"},503);
  try{
    const approval=await readApproval(env);
    if(approval.status==="invalid-registry")
      return response({error:"invalid-roster-registry"},503);
    const scan=await scanPrivateCoverage(env,fetchImpl);
    if(!scan)return response({error:"coverage-unavailable"},503);
    return response(currentView(scan,approval));
  }catch{return response({error:"preflight-unavailable"},503);}
}

export async function saveRosterSyncApprovals(request,env,fetchImpl=fetch){
  if(!captainConfigReady(env))return response({error:"storage-unavailable"},503);
  const url=new URL(request.url);
  if(request.method!=="POST")return response({error:"method-not-allowed"},405);
  // Signed Cloudflare Access admin authentication is checked by handleAdmin.
  if(request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return response({error:"forbidden"},403);
  let body;
  try{
    const raw=await request.text();
    if(raw.length>2000)return response({error:"invalid-payload"},400);
    body=JSON.parse(raw);
  }catch{return response({error:"invalid-payload"},400);}
  const selected=body?.fingerprints;
  if(!Array.isArray(selected)||selected.length<1||selected.length>MAX_APPROVED||
     selected.some(x=>typeof x!=="string"||!FP.test(x))||
     new Set(selected).size!==selected.length||
     Object.keys(body).some(k=>k!=="fingerprints"))
    return response({error:"invalid-selection"},400);

  try{
    // Fresh provider census every time; stale/partial or unknown alliances
    // cannot silently become approved.
    const scan=await scanPrivateCoverage(env,fetchImpl);
    if(!scan||!scan.complete)return response({error:"incomplete-current-census"},409);
    const approved=[];
    for(const fingerprint of selected){
      const match=scan.alliances.find(a=>a.allianceFingerprint===fingerprint&&
        a.status==="available");
      if(!match)return response({error:"alliance-not-verified"},409);
      approved.push({fingerprint,name:match.name});
    }
    // Registry contains only current stable-AID fingerprints and labels.
    // Never tokens, member IDs, player names or roster data.
    await env.CAPTAIN_BUCKET.put(ROSTER_APPROVAL_KEY,JSON.stringify({
      version:1,approvedAt:new Date().toISOString(),alliances:approved
    }),{httpMetadata:{contentType:"application/json",cacheControl:"no-store"}});
    return response({status:"approved",count:approved.length,collectionEnabled:false});
  }catch{return response({error:"approval-unavailable"},503);}
}
