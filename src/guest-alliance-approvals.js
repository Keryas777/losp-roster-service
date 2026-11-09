// Explicit guest-alliance enrollment, separate from LoSP approvals.
// An OAuth session by itself never grants access to collective collection.
// Store only the stable alliance fingerprint: no player or provider names.
import {readApproval} from "./roster-sync-preflight.js";
import {scanPrivateCoverage} from "./alliance-coverage.js";
import {captainConfigReady} from "./captain-vault.js";
import {enqueueGuestInitialSync} from "./guest-initial-sync.js";
import {dispatchGuestEvolutionPublication} from "./guest-evolution-publication-dispatch.js";

export const GUEST_APPROVAL_KEY="roster-sync/v1/approved-guest-alliances.json";
const FP=/^[a-f0-9]{64}$/;
const ALLIANCE_KEY=/^[a-z][a-z0-9-]{1,63}$/;
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
    const seen=new Set(),keys=new Set();
    for(const a of record.alliances){
      const names=Object.keys(a||{});
      if(!a||!FP.test(a.fingerprint)||seen.has(a.fingerprint)||
         ![1,2].includes(names.length)||
         names.some(key=>!["fingerprint","allianceKey"].includes(key))||
         (a.allianceKey!==undefined&&(!ALLIANCE_KEY.test(a.allianceKey)||
           keys.has(a.allianceKey))))
        return {status:"invalid-registry",alliances:[]};
      seen.add(a.fingerprint);
      if(a.allianceKey)keys.add(a.allianceKey);
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
  let fingerprint,action,allianceKey;
  try{
    const raw=await request.text();
    if(raw.length>310)throw Error("invalid-length");
    const body=JSON.parse(raw);
    if(!body||typeof body!=="object"||Array.isArray(body)||
       !FP.test(body.fingerprint)||
       !["approve","revoke","bind","unbind"].includes(body.action)||
       Object.keys(body).length!==((body.action==="bind"||
         (body.action==="approve"&&Object.hasOwn(body,"allianceKey")))?3:2)||
       Object.keys(body).some(key=>!["fingerprint","action","allianceKey"].includes(key))||
       ((body.action==="bind"||Object.hasOwn(body,"allianceKey"))&&
         !ALLIANCE_KEY.test(body.allianceKey)))
      throw Error("invalid-body");
    ({fingerprint,action,allianceKey}=body);
  }catch{return reply({error:"invalid-selection"},400);}
  try{
    const losp=await readApproval(env);
    const guest=await readGuestApprovals(env);
    if(losp.status==="invalid-registry"||guest.status==="invalid-registry")
      return reply({error:"invalid-registry"},503);
    if(action==="approve"&&losp.alliances.some(a=>a.fingerprint===fingerprint))
      return reply({error:"already-losp-approved"},409);
    const already=guest.alliances.some(a=>a.fingerprint===fingerprint);
    if(["bind","unbind"].includes(action)&&!already)
      return reply({error:"guest-not-approved"},409);
    // Record the approved tenant key in the SAME R2 write, when supplied by
    // the administrator. Never silently change an existing association.
    if(["approve","bind"].includes(action)&&allianceKey&&
       guest.alliances.some(a=>a.allianceKey===allianceKey&&
         a.fingerprint!==fingerprint))
      return reply({error:"alliance-key-already-bound"},409);
    if(action==="approve"&&already&&allianceKey){
      const bound=guest.alliances.find(a=>a.fingerprint===fingerprint);
      if(bound.allianceKey&&bound.allianceKey!==allianceKey)
        return reply({error:"alliance-already-bound"},409);
    }
    if(action==="approve"&&!already){
      const scan=await scanPrivateCoverage(env,fetchImpl);
      const verified=scan?.alliances?.find(a=>
        a.allianceFingerprint===fingerprint&&a.status==="available");
      if(!verified)return reply({error:"alliance-not-currently-verifiable"},409);
    }
    const alliances=action==="approve"?
      already?guest.alliances.map(a=>a.fingerprint!==fingerprint?a:
        allianceKey&&!a.allianceKey?{fingerprint,allianceKey}:a):
        [...guest.alliances,{fingerprint,...(allianceKey?{allianceKey}:{})}]:
      action==="revoke"?guest.alliances.filter(a=>a.fingerprint!==fingerprint):
      guest.alliances.map(a=>a.fingerprint!==fingerprint?a:
        action==="bind"?{fingerprint,allianceKey}:{fingerprint});
    const before=JSON.stringify(guest.alliances);
    const changed=before!==JSON.stringify(alliances);
    if(changed){
      await env.CAPTAIN_BUCKET.put(GUEST_APPROVAL_KEY,JSON.stringify({
        version:1,approvedAt:new Date().toISOString(),alliances
      }),{httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
    }
    const status=action==="approve"?(already?"already-approved":"approved"):
      action==="revoke"?(already?"revoked":"not-approved"):
      action==="bind"?(changed?"bound":"already-bound"):
      (changed?"unbound":"already-unbound");
    // Queue all initial private captures only when explicit guest approval and
    // canonical WebApp binding are BOTH present. OAuth alone is never enough.
    // The queue is idempotent and resumes on the existing minute Cron.
    let initialSync=null;
    let staticPublication=null;
    if(changed){
      // A revoke/unbind should propagate to public Pages promptly. The workflow
      // rereads R2 and applies current consent; this dispatch carries no data.
      staticPublication=await dispatchGuestEvolutionPublication(env);
    }
    if(["approve","bind"].includes(action)){
      const row=alliances.find(a=>a.fingerprint===fingerprint);
      if(row?.allianceKey){
        try{
          const queued=await enqueueGuestInitialSync(env,fingerprint,
            row.allianceKey);
          initialSync=queued.status;
        }catch{initialSync="unavailable";}
      }
    }
    return reply({status,count:alliances.length,
      ...(initialSync!==null?{initialSync}:{}),
      ...(staticPublication!==null?{staticPublication}: {})});
  }catch{return reply({error:"approval-unavailable"},503);}
}
