// Explicit guest-alliance enrollment, separate from LoSP approvals.
// An OAuth session by itself never grants access to collective collection.
// Store only the stable alliance fingerprint: no player or provider names.
import {readApproval} from "./roster-sync-preflight.js";
import {scanPrivateCoverage} from "./alliance-coverage.js";
import {captainConfigReady} from "./captain-vault.js";
import {enqueueGuestInitialSync} from "./guest-initial-sync.js";

export const GUEST_APPROVAL_KEY="roster-sync/v1/approved-guest-alliances.json";
export const GUEST_INITIAL_SYNC_STATE_ROOT="roster-batches/v1/guest-initial-sync-state/";
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
         names.length<1||names.length>2||
         names.some(key=>!["fingerprint","allianceKey"].includes(key))||
         (a.allianceKey!==undefined&&(!ALLIANCE_KEY.test(a.allianceKey)||
           keys.has(a.allianceKey))))
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

const INITIAL_SYNC_STATES=["pending","restart-requested","complete","stopped",
  "failed","binding-changed"];
const initialSyncStateKey=fingerprint=>
  GUEST_INITIAL_SYNC_STATE_ROOT+fingerprint+".json";

// Lifecycle state is stored separately from the strict approval registry.
// Older Workers can therefore continue reading approvals during rollback.
export async function readGuestInitialSyncState(env,fingerprint,allianceKey){
  if(!FP.test(fingerprint||"")||
     (allianceKey!==undefined&&!ALLIANCE_KEY.test(allianceKey||"")))
    return {status:"invalid-selection"};
  try{
    const item=await env?.CAPTAIN_BUCKET?.get(initialSyncStateKey(fingerprint));
    if(!item)return {status:"not-found"};
    const raw=await item.text();
    if(raw.length>2000)return {status:"invalid-state"};
    const record=JSON.parse(raw);
    if(record?.version!==1||record.fingerprint!==fingerprint||
       Object.keys(record).length!==5||
       Object.keys(record).some(name=>![
         "version","fingerprint","allianceKey","status","updatedAt"
       ].includes(name))||
       !ALLIANCE_KEY.test(record.allianceKey||"")||
       !INITIAL_SYNC_STATES.includes(record.status)||
       !Number.isFinite(Date.parse(record.updatedAt)))
      return {status:"invalid-state"};
    if(allianceKey!==undefined&&record.allianceKey!==allianceKey)
      return {status:"binding-changed",allianceKey:record.allianceKey};
    return {...record,etag:item.etag||null};
  }catch{return {status:"storage-unavailable"};}
}

// The permanent status lives outside the seven-day queue object. It protects
// completed and stopped runs while remaining backward-compatible with older
// Workers that strictly validate the approval registry's compact schema.
export async function setGuestInitialSyncState(env,fingerprint,allianceKey,state,
    {allowUnbound=false}={}){
  if(!FP.test(fingerprint||"")||!ALLIANCE_KEY.test(allianceKey||"")||
     !INITIAL_SYNC_STATES.includes(state))
    return {status:"invalid-selection"};
  for(let attempt=0;attempt<8;attempt++){
    const guest=await readGuestApprovalSnapshot(env);
    if(guest.status==="invalid-registry")return {status:"invalid-registry"};
    const row=guest.alliances.find(a=>a.fingerprint===fingerprint);
    if((!row||row.allianceKey!==allianceKey)&&!allowUnbound)
      return {status:"not-approved-and-bound"};
    const key=initialSyncStateKey(fingerprint);
    const current=await readGuestInitialSyncState(env,fingerprint);
    if(current.status==="invalid-state"||current.status==="storage-unavailable")
      return current;
    const reviewedRebind=row?.allianceKey===allianceKey&&
      ["pending","restart-requested"].includes(state);
    if(current.status!=="not-found"&&current.allianceKey!==allianceKey&&
       state!=="binding-changed"&&!reviewedRebind)
      return {status:"binding-changed"};
    if(current.status!=="not-found"&&current.allianceKey===allianceKey&&
       current.status===state)return {status:"unchanged"};
    if(["pending","restart-requested"].includes(state)&&
       current.status==="complete")
      return {status:"already-complete"};
    const record={version:1,fingerprint,allianceKey,status:state,
      updatedAt:new Date().toISOString()};
    const saved=await env.CAPTAIN_BUCKET.put(key,JSON.stringify(record),{
        onlyIf:current.etag?{etagMatches:current.etag}:{etagDoesNotMatch:"*"},
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
    let alliances,already=false,changed=false,previousAllianceKey;
    let written=false;
    for(let attempt=0;attempt<8;attempt++){
      const guest=await readGuestApprovalSnapshot(env);
      if(guest.status==="invalid-registry")
        return reply({error:"invalid-registry"},503);
      const previous=guest.alliances.find(a=>a.fingerprint===fingerprint);
      already=Boolean(previous);
      previousAllianceKey=previous?.allianceKey;
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
          return {...a,allianceKey};
        }):[...guest.alliances,{fingerprint,
          ...(allianceKey?{allianceKey}:{})}];
      }else if(action==="revoke"){
        alliances=guest.alliances.filter(a=>a.fingerprint!==fingerprint);
      }else{
        alliances=guest.alliances.map(a=>{
          if(a.fingerprint!==fingerprint)return a;
          if(action==="unbind")return {fingerprint};
          if(a.allianceKey===allianceKey)return a;
          return {...a,allianceKey};
        });
      }
      changed=JSON.stringify(guest.alliances)!==JSON.stringify(alliances);
      if(!changed){
        written=true;
        break;
      }
      const candidate=alliances.find(a=>a.fingerprint===fingerprint);
      const newEnrollment=Boolean(candidate?.allianceKey&&
        !previousAllianceKey&&["approve","bind"].includes(action));
      if(newEnrollment){
        const lifecycle=await readGuestInitialSyncState(env,fingerprint,
          candidate.allianceKey);
        if(["invalid-state","storage-unavailable"].includes(lifecycle.status))
          return reply({error:"initial-sync-state-unavailable"},503);
        if(lifecycle.status==="not-found"){
          // Persist the intent first. If the Worker stops after the approval
          // CAS, the existing cron can still create the queue from this marker.
          const prepared=await setGuestInitialSyncState(env,fingerprint,
            candidate.allianceKey,"pending",{allowUnbound:true});
          if(!["pending","unchanged","already-complete"]
            .includes(prepared.status))
            return reply({error:"initial-sync-intent-write-failed"},503);
        }
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
    const row=alliances.find(a=>a.fingerprint===fingerprint);
    let confirmedBinding=false;
    if(action==="bind"&&!changed&&row?.allianceKey){
      const current=await readGuestInitialSyncState(env,fingerprint,row.allianceKey);
      if(current.status==="binding-changed"){
        const reviewed=await setGuestInitialSyncState(env,fingerprint,
          row.allianceKey,"pending");
        confirmedBinding=["pending","unchanged"].includes(reviewed.status);
      }
    }
    const initialEnrollment=Boolean(
      (row?.allianceKey&&!previousAllianceKey&&changed)||confirmedBinding);
    if((action==="revoke"||action==="unbind")&&previousAllianceKey){
      try{await setGuestInitialSyncState(env,fingerprint,previousAllianceKey,
        "stopped",{allowUnbound:true});}catch{}
    }
    if(row?.allianceKey&&previousAllianceKey&&
       previousAllianceKey!==row.allianceKey){
      try{await setGuestInitialSyncState(env,fingerprint,row.allianceKey,
        "binding-changed");}catch{}
    }
    // Queue all initial private captures only when explicit guest approval and
    // canonical WebApp binding are BOTH present. OAuth alone is never enough.
    // The queue is idempotent and resumes on the existing minute Cron.
    let initialSync=null;
    if(["approve","bind"].includes(action)){
      if(row?.allianceKey&&!(previousAllianceKey&&
         previousAllianceKey!==row.allianceKey)){
        try{
          const queued=await enqueueGuestInitialSync(env,fingerprint,
            row.allianceKey,Date.now(),{initialEnrollment});
          initialSync=queued.status;
        }catch{initialSync="unavailable";}
      }else if(row?.allianceKey){
        initialSync="binding-changed-requires-review";
      }
    }
    return reply({status,count:alliances.length,
      ...(initialSync!==null?{initialSync}:{})});
  }catch{return reply({error:"approval-unavailable"},503);}
}
