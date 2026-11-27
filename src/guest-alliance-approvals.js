// Explicit guest-alliance enrollment, separate from LoSP approvals.
// An OAuth session by itself never grants access to collective collection.
// Store only the stable alliance fingerprint: no player or provider names.
import {readApproval} from "./roster-sync-preflight.js";
import {scanPrivateCoverage} from "./alliance-coverage.js";
import {captainConfigReady} from "./captain-vault.js";
import {enqueueGuestInitialSync} from "./guest-initial-sync.js";

export const GUEST_APPROVAL_KEY="roster-sync/v1/approved-guest-alliances.json";
const FP=/^[a-f0-9]{64}$/;
const ALLIANCE_KEY=/^[a-z][a-z0-9-]{1,63}$/;
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const reply=(body,status=200)=>Response.json(body,{status,headers:HEADERS});

// Guest approvals are administrative configuration, not a roster snapshot.
// Current alliance and roster-share permissions are rechecked by collectors.
async function readGuestApprovalSnapshot(env){
  const item=await env.CAPTAIN_BUCKET.get(GUEST_APPROVAL_KEY);
  if(!item)return {status:"not-configured",alliances:[],etag:null};
  const raw=await item.text();
  if(raw.length>200000)return {status:"invalid-registry",alliances:[],etag:null};
  try{
    const record=JSON.parse(raw);
    if(record?.version!==1||!Array.isArray(record.alliances))
      return {status:"invalid-registry",alliances:[],etag:null};
    const seen=new Set(),keys=new Set();
    for(const a of record.alliances){
      const names=Object.keys(a||{});
      if(!a||!FP.test(a.fingerprint)||seen.has(a.fingerprint)||
         names.length<1||names.length>3||
         names.some(key=>!["fingerprint","allianceKey","initialSyncStatus"].includes(key))||
         (a.allianceKey!==undefined&&(!ALLIANCE_KEY.test(a.allianceKey)||
           keys.has(a.allianceKey)))||
         (a.initialSyncStatus!==undefined&&
           !["pending","restart-requested","complete","stopped","failed","binding-changed"]
             .includes(a.initialSyncStatus)))
        return {status:"invalid-registry",alliances:[],etag:null};
      seen.add(a.fingerprint);
      if(a.allianceKey)keys.add(a.allianceKey);
    }
    return {status:"configured",alliances:record.alliances,
      approvedAt:record.approvedAt,etag:item.etag||null};
  }catch{return {status:"invalid-registry",alliances:[],etag:null};}
}
export async function readGuestApprovals(env){
  const {status,alliances}=await readGuestApprovalSnapshot(env);
  return {status,alliances};
}

// Durable lifecycle marker lives beside the non-expiring approval registry,
// not beside the seven-day queue object. It prevents a completed or terminal
// onboarding from being recreated when its short-lived queue expires.
export async function setGuestInitialSyncState(env,fingerprint,allianceKey,state){
  if(!FP.test(fingerprint||"")||!ALLIANCE_KEY.test(allianceKey||"")||
     !["pending","restart-requested","complete","stopped","failed"]
       .includes(state))
    return {status:"invalid-selection"};
  for(let attempt=0;attempt<8;attempt++){
    const guest=await readGuestApprovalSnapshot(env);
    if(guest.status==="invalid-registry")return {status:"invalid-registry"};
    const row=guest.alliances.find(a=>a.fingerprint===fingerprint);
    if(!row||row.allianceKey!==allianceKey)return {status:"not-approved-and-bound"};
    if(row.initialSyncStatus===state)return {status:"unchanged"};
    if(["pending","restart-requested"].includes(state)&&
       row.initialSyncStatus==="complete")
      return {status:"already-complete"};
    const alliances=guest.alliances.map(a=>a.fingerprint===fingerprint?
      {...a,initialSyncStatus:state}:a);
    const saved=await env.CAPTAIN_BUCKET.put(GUEST_APPROVAL_KEY,
      JSON.stringify({version:1,
        ...(guest.approvedAt!==undefined?{approvedAt:guest.approvedAt}:{}),
        alliances}),{
        onlyIf:guest.etag?{etagMatches:guest.etag}:{etagDoesNotMatch:"*"},
        httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
      });
    if(saved)return {status:state};
  }
  return {status:"write-conflict"};
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
    if(losp.status==="invalid-registry")
      return reply({error:"invalid-registry"},503);
    if(action==="approve"&&losp.alliances.some(a=>a.fingerprint===fingerprint))
      return reply({error:"already-losp-approved"},409);
    if(action==="approve"){
      const guest=await readGuestApprovals(env);
      if(guest.status==="invalid-registry")
        return reply({error:"invalid-registry"},503);
      const already=guest.alliances.some(a=>a.fingerprint===fingerprint);
      if(!already){
        const scan=await scanPrivateCoverage(env,fetchImpl);
        const verified=scan?.alliances?.find(a=>
          a.allianceFingerprint===fingerprint&&a.status==="available");
        if(!verified)return reply({error:"alliance-not-currently-verifiable"},409);
      }
    }
    let alliances,already=false,changed=false;
    let written=false;
    for(let attempt=0;attempt<8;attempt++){
      const guest=await readGuestApprovalSnapshot(env);
      if(guest.status==="invalid-registry")
        return reply({error:"invalid-registry"},503);
      already=guest.alliances.some(a=>a.fingerprint===fingerprint);
      if(["bind","unbind"].includes(action)&&!already)
        return reply({error:"guest-not-approved"},409);
      if(["approve","bind"].includes(action)&&allianceKey&&
         guest.alliances.some(a=>a.allianceKey===allianceKey&&
           a.fingerprint!==fingerprint))
        return reply({error:"alliance-key-already-bound"},409);
      if(action==="approve"&&already&&allianceKey){
        const bound=guest.alliances.find(a=>a.fingerprint===fingerprint);
        if(bound.allianceKey&&bound.allianceKey!==allianceKey)
          return reply({error:"alliance-already-bound"},409);
      }
      if(action==="approve"){
        alliances=already?guest.alliances.map(a=>{
          if(a.fingerprint!==fingerprint||!allianceKey||a.allianceKey)return a;
          return {...a,allianceKey,
            ...(!a.initialSyncStatus?{initialSyncStatus:"pending"}:{})};
        }):[...guest.alliances,{fingerprint,
          ...(allianceKey?{allianceKey,initialSyncStatus:"pending"}:{})}];
      }else if(action==="revoke"){
        alliances=guest.alliances.filter(a=>a.fingerprint!==fingerprint);
      }else{
        alliances=guest.alliances.map(a=>{
          if(a.fingerprint!==fingerprint)return a;
      if(action==="unbind")return {fingerprint,
            initialSyncStatus:"stopped"};
          if(a.allianceKey===allianceKey)return a;
          return {...a,allianceKey,initialSyncStatus:a.allianceKey?
            "binding-changed":a.initialSyncStatus||"pending"};
        });
      }
      changed=JSON.stringify(guest.alliances)!==JSON.stringify(alliances);
      if(!changed){
        written=true;
        break;
      }
      const saved=await env.CAPTAIN_BUCKET.put(GUEST_APPROVAL_KEY,
        JSON.stringify({version:1,approvedAt:new Date().toISOString(),alliances}),{
          onlyIf:guest.etag?{etagMatches:guest.etag}:{etagDoesNotMatch:"*"},
          httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
        });
      if(saved){written=true;break;}
    }
    if(!written)return reply({error:"approval-write-conflict"},503);
    const status=action==="approve"?(already?"already-approved":"approved"):
      action==="revoke"?(already?"revoked":"not-approved"):
      action==="bind"?(changed?"bound":"already-bound"):
      (changed?"unbound":"already-unbound");
    // Queue all initial private captures only when explicit guest approval and
    // canonical WebApp binding are BOTH present. OAuth alone is never enough.
    // The queue is idempotent and resumes on the existing minute Cron.
    let initialSync=null;
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
      ...(initialSync!==null?{initialSync}:{})});
  }catch{return reply({error:"approval-unavailable"},503);}
}
