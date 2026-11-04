// Explicit guest-alliance enrollment, separate from LoSP approvals.
// An OAuth session by itself never grants access to collective collection.
// Store only the stable alliance fingerprint: no player or provider names.
import {readApproval} from "./roster-sync-preflight.js";
import {scanPrivateCoverage} from "./alliance-coverage.js";
import {captainConfigReady} from "./captain-vault.js";

export const GUEST_APPROVAL_KEY="roster-sync/v1/approved-guest-alliances.json";
const FP=/^[a-f0-9]{64}$/;
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const reply=(body,status=200)=>Response.json(body,{status,headers:HEADERS});

// Guest approvals are administrative configuration, not a roster snapshot.
// Current alliance and roster-share permissions are rechecked by collectors.
export async function readGuestApprovals(env){
  const item=await env.CAPTAIN_BUCKET.get(GUEST_APPROVAL_KEY);
  if(!item)return {status:"not-configured",alliances:[]};
  const raw=await item.text();
  if(raw.length>200000)return {status:"invalid-registry",alliances:[]};
  try{
    const record=JSON.parse(raw);
    if(record?.version!==1||!Array.isArray(record.alliances))
      return {status:"invalid-registry",alliances:[]};
    const seen=new Set();
    for(const a of record.alliances){
      if(!a||Object.keys(a).length!==1||!FP.test(a.fingerprint)||
         seen.has(a.fingerprint))return {status:"invalid-registry",alliances:[]};
      seen.add(a.fingerprint);
    }
    return {status:"configured",alliances:record.alliances};
  }catch{return {status:"invalid-registry",alliances:[]};}
}

// Existing LoSP consumers continue using readApproval unchanged. This
// combined view is used ONLY by the private collectors and their diagnostics.
// A broken guest registry must never interrupt already-working LoSP campaigns.
export async function readCollectibleApprovals(env){
  const losp=await readApproval(env);
  if(losp.status==="invalid-registry")
    return {status:"invalid-registry",alliances:[],
      lospAlliances:[],guestAlliances:[],guestRegistryStatus:"not-checked"};
  let guestStatus="not-configured",guestAlliances=[];
  try{
    const guest=await readGuestApprovals(env);
    guestStatus=guest.status;
    if(guest.status==="configured"){
      const lospKeys=new Set(losp.alliances.map(a=>a.fingerprint));
      // The LoSP registry always wins if an alliance was promoted later.
      guestAlliances=guest.alliances
        .filter(a=>!lospKeys.has(a.fingerprint))
        .map(a=>({fingerprint:a.fingerprint,name:"Alliance invitée"}));
    }
  }catch{guestStatus="unavailable";}
  const lospAlliances=losp.alliances;
  return {status:losp.status==="configured"||guestAlliances.length?
      "configured":"not-configured",
    alliances:[...lospAlliances,...guestAlliances],
    lospAlliances,guestAlliances,guestRegistryStatus:guestStatus};
}

// Called exclusively behind the signed Cloudflare Access admin gate.
// Approval requires a fresh, valid Scopely alliance census plus explicit admin
// action. In-game rank isn't an OAuth permission: Scopely enforces roster sharing.
// Revocation needs no Scopely calls, never changes the LoSP registry.
export async function handleGuestAllianceApproval(request,env,fetchImpl=fetch){
  if(request.method!=="POST")return reply({error:"method-not-allowed"},405);
  if(!captainConfigReady(env))return reply({error:"storage-unavailable"},503);
  const url=new URL(request.url);
  if(url.search||request.headers.get("Origin")!==url.origin||
     !(request.headers.get("Content-Type")||"").toLowerCase()
       .startsWith("application/json"))return reply({error:"forbidden"},403);
  let fingerprint,action;
  try{
    const raw=await request.text();
    if(raw.length>220)throw Error("invalid-length");
    const body=JSON.parse(raw);
    if(!body||typeof body!=="object"||Array.isArray(body)||
       Object.keys(body).length!==2||!FP.test(body.fingerprint)||
       !["approve","revoke"].includes(body.action))throw Error("invalid-body");
    ({fingerprint,action}=body);
  }catch{return reply({error:"invalid-selection"},400);}
  try{
    const losp=await readApproval(env);
    const guest=await readGuestApprovals(env);
    if(losp.status==="invalid-registry"||guest.status==="invalid-registry")
      return reply({error:"invalid-registry"},503);
    if(action==="approve"&&losp.alliances.some(a=>a.fingerprint===fingerprint))
      return reply({error:"already-losp-approved"},409);
    const already=guest.alliances.some(a=>a.fingerprint===fingerprint);
    if(action==="approve"&&!already){
      const scan=await scanPrivateCoverage(env,fetchImpl);
      const verified=scan?.alliances?.find(a=>
        a.allianceFingerprint===fingerprint&&a.status==="available");
      if(!verified)return reply({error:"alliance-not-currently-verifiable"},409);
    }
    const alliances=action==="approve"?
      already?guest.alliances:[...guest.alliances,{fingerprint}]:
      guest.alliances.filter(a=>a.fingerprint!==fingerprint);
    if((action==="approve"&&!already)||(action==="revoke"&&already)){
      await env.CAPTAIN_BUCKET.put(GUEST_APPROVAL_KEY,JSON.stringify({
        version:1,approvedAt:new Date().toISOString(),alliances
      }),{httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
    }
    return reply({status:action==="approve"?
      already?"already-approved":"approved":
      already?"revoked":"not-approved",count:alliances.length});
  }catch{return reply({error:"approval-unavailable"},503);}
}
