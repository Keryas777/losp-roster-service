// One-time, consent-aware guest catch-up. Uses existing * * * * * cron,
// private 7-day R2 receipts and existing roster/Info collectors.
// One selected alliance and ONE bounded provider phase per invocation.
// A new approval+WebApp binding queues the catch-up; it never runs Scopely
// calls in an administrator's approval HTTP request.
import {readGuestApprovals,setGuestInitialSyncState}
  from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {captainConfigReady} from "./captain-vault.js";
import {runRosterAutoTick,ROSTER_CRON,manualRosterWindow} from "./automatic-roster-scheduler.js";
import {runMemberInfoTick} from "./member-info-campaign.js";
import {chooseAccount} from "./private-roster-pilot.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {archiveGuestSeasonRankSample} from "./public-guest-season-ranks.js";
import {archiveInitialGuestTrophies} from "./public-trophy-history.js";
import {archiveGuestInitialArena} from "./public-arena-history.js";

const ROOT="roster-batches/v1/guest-initial-sync/";
const FP=/^[a-f0-9]{64}$/;
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const LOCK="e".repeat(64);
const MAX_ATTEMPTS=160,DEADLINE_MS=48*60*60*1000;
const LOCK_LEASE_MS=8*60*1000,LOCK_RETRY_MS=2*60*1000;
const QUEUE_LIST_LIMIT=1000;
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff"};
const recordKey=fp=>ROOT+fp+".json";
const currentCardKey=fp=>ROOT+fp+"-card.json";
const DIRECTORY_DISPATCH="https://api.github.com/repos/Keryas777/msf/actions/workflows/publish-guest-joueurs.yml/dispatches";
const stamp=now=>new Date(now).toISOString();
const answer=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const pending=s=>["queued","running"].includes(s);
const currentCampaign=now=>manualRosterWindow(now);
const validCardInt=x=>Number.isSafeInteger(x)&&x>=0;

async function readStored(bucket,key,max=3500){
  const item=await bucket.get(key);
  if(!item)return null;
  const value=await item.text();
  if(value.length>max)throw Error("oversized-onboarding-record");
  return {item,value:JSON.parse(value)};
}
async function read(bucket,key,max=3500){
  return (await readStored(bucket,key,max))?.value??null;
}
async function write(bucket,key,data){
  try{
    await bucket.put(key,JSON.stringify(data),{httpMetadata:{
      contentType:"application/json",cacheControl:"private, no-store"}});
  }catch{
    const error=Error("guest-sync-storage-write-failed");
    error.code="guest-sync-storage-write-failed";
    throw error;
  }
}
async function createRecord(bucket,key,data){
  return bucket.put(key,JSON.stringify(data),{
    onlyIf:{etagDoesNotMatch:"*"},
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
}
async function replaceRecord(bucket,key,data,etag){
  if(typeof etag!=="string"||!etag)return null;
  return bucket.put(key,JSON.stringify(data),{
    onlyIf:{etagMatches:etag},
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
}
function valid(record,fp){
  return record?.version===1&&record.fingerprint===fp&&
    KEY.test(record.allianceKey||"")&&
    ["queued","running","complete","stopped","failed"].includes(record.status)&&
    ["roster","infos","ranks","arena","trophies","done"].includes(record.phase)&&
    Number.isFinite(Date.parse(record.requestedAt))&&
    Number.isFinite(Date.parse(record.updatedAt))&&
    Number.isFinite(Date.parse(record.deadlineAt))&&
    Number.isFinite(Date.parse(record.nextAt))&&
    Number.isSafeInteger(record.attempts)&&record.attempts>=0&&
    record.attempts<=MAX_ATTEMPTS&&
    (record.lastOutcome===null||
      (typeof record.lastOutcome==="string"&&record.lastOutcome.length<=72))&&
    (record.lockReleaseStatus===undefined||record.lockReleaseStatus===null||
      (typeof record.lockReleaseStatus==="string"&&
       record.lockReleaseStatus.length<=48))&&
    ((record.claimToken===undefined&&record.claimUntil===undefined)||
      (typeof record.claimToken==="string"&&record.claimToken.length<=64&&
       Number.isFinite(Date.parse(record.claimUntil))));
}
async function locking(env,fn){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.idFromName||!binding?.get)return {status:"lock-unavailable"};
  const holder=crypto.randomUUID();
  let stub;
  try{stub=binding.get(binding.idFromName(LOCK));}
  catch{return {status:"lock-unavailable"};}
  const invoke=async action=>{
    let response;
    try{
      response=await stub.fetch(new Request("https://guest-initial-lock.internal/",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action,holder,fingerprint:LOCK})
      }));
    }catch{return {status:action==="acquire"?
      "lock-transport-error":"lock-release-failed"};}
    let body;
    try{body=await response.json();}
    catch{
      const status=action!=="acquire"?"lock-release-failed":
        response.status>=500?"lock-internal-error":"lock-invalid-response";
      return {status,httpStatus:response.status};
    }
    if(action==="acquire"){
      if(response.status===409&&body?.status==="busy")
        return {status:"lock-busy",httpStatus:409};
      if(response.status===400)
        return {status:"lock-invalid-request",httpStatus:400};
      if(response.status===503&&body?.status==="unavailable")
        return {status:"lock-internal-error",httpStatus:503};
      if(response.status===503)
        return {status:"lock-unavailable",httpStatus:503};
      if(response.status>=500)
        return {status:"lock-internal-error",httpStatus:response.status};
      if(response.status!==200||body?.status!=="acquired")
        return {status:"lock-unexpected-response",httpStatus:response.status};
      return {status:"acquired"};
    }
    if(response.status===200&&body?.status==="released")
      return {status:"released"};
    return {status:"lock-release-failed",httpStatus:response.status};
  };
  const acquired=await invoke("acquire");
  if(acquired.status!=="acquired")return acquired;
  let result,error;
  try{result=await fn();}catch(caught){error=caught;}
  const released=await invoke("release");
  if(error){
    if(released.status!=="released"&&error&&typeof error==="object"){
      error.lockReleaseStatus=released.status;
      error.lockReleaseHttpStatus=released.httpStatus;
    }
    throw error;
  }
  if(released.status!=="released")return {...result,
    lockReleaseStatus:released.status,lockReleaseHttpStatus:released.httpStatus};
  return result;
}
async function isApprovedBound(env,fp,key){
  const [guest,losp]=await Promise.all([
    readGuestApprovals(env),readApproval(env)
  ]);
  if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
    return false;
  if((losp.alliances||[]).some(a=>a.fingerprint===fp))return false;
  return (guest.alliances||[]).some(a=>
    a.fingerprint===fp&&a.allianceKey===key);
}
function publicState(record){
  if(!record)return {status:"not-started"};
  return {status:record.status,phase:record.phase,
    requestedAt:record.requestedAt,updatedAt:record.updatedAt,
    attempts:record.attempts,lastOutcome:record.lastOutcome,
    nextAt:record.nextAt,
    ...(record.lockReleaseStatus?{lockReleaseStatus:record.lockReleaseStatus}:{}),
    ...(record.claimUntil?{claimUntil:record.claimUntil}:{}),
    ...(record.directoryDispatch?{directoryDispatch:record.directoryDispatch}:{})};
}
function newRequest(fp,key,now){
  return {version:1,fingerprint:fp,allianceKey:key,status:"queued",
    phase:"ranks",requestedAt:stamp(now),updatedAt:stamp(now),
    deadlineAt:stamp(now+DEADLINE_MS),nextAt:stamp(now),attempts:0,
    lastOutcome:null};
}

// Recover an approved, bound request whose enqueue write was interrupted.
// Only durable pending intents are eligible; legacy markerless alliances remain
// visible to an administrator but are never bulk-replayed after queue expiry.
// One R2 create per minute bounds work; create-if-absent makes races idempotent.
export async function reconcileGuestInitialSyncRequests(env,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list)
    return {status:"storage-unavailable",created:0};
  try{
    const [guest,losp,listing]=await Promise.all([
      readGuestApprovals(env),readApproval(env),
      bucket.list({prefix:ROOT,limit:QUEUE_LIST_LIMIT})
    ]);
    if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
      return {status:"invalid-approval-registry",created:0};
    if(!listing||listing.truncated)
      return {status:"queue-too-large",created:0};
    const existing=new Set((listing.objects||[]).map(item=>item.key));
    const lospFingerprints=new Set((losp.alliances||[]).map(a=>a.fingerprint));
    let created=0;
    for(const alliance of guest.alliances||[]){
      const {fingerprint:fp,allianceKey:key}=alliance||{};
      if(!FP.test(fp||"")||!KEY.test(key||"")||lospFingerprints.has(fp))continue;
      const keyPath=recordKey(fp);
      if(!["pending","restart-requested"].includes(alliance.initialSyncStatus))continue;
      if(existing.has(keyPath)){
        const stored=await readStored(bucket,keyPath);
        const saved=stored?.value;
        if(valid(saved,fp)&&["complete","failed","stopped"].includes(saved.status)){
          if(alliance.initialSyncStatus==="restart-requested"&&
             saved.status!=="complete"){
            const {claimToken,claimUntil,...record}=saved;
            const resumed={...record,status:"queued",updatedAt:stamp(now),
              deadlineAt:stamp(now+DEADLINE_MS),nextAt:stamp(now),attempts:0,
              lastOutcome:"admin-restart"};
            const replaced=await replaceRecord(bucket,keyPath,resumed,stored.item.etag);
            if(!replaced)return {status:"retry-conflict",created:0};
            const marker=await setGuestInitialSyncState(env,fp,key,"pending");
            return {status:["pending","unchanged"].includes(marker.status)?
              "repaired":"marker-repair-failed",created:0};
          }
          const marker=await setGuestInitialSyncState(env,fp,key,saved.status);
          return {status:[saved.status,"unchanged"].includes(marker.status)?
            "repaired":"marker-repair-failed",created:0};
        }
        if(alliance.initialSyncStatus==="restart-requested"){
          const marker=await setGuestInitialSyncState(env,fp,key,"pending");
          return {status:["pending","unchanged"].includes(marker.status)?
            "repaired":"marker-repair-failed",created:0};
        }
        continue;
      }
      if(!await isApprovedBound(env,fp,key))
        return {status:"idle",created:0};
      const record=newRequest(fp,key,now);
      const stored=await createRecord(bucket,keyPath,record);
      if(stored){
        if(alliance.initialSyncStatus==="restart-requested"){
          const marker=await setGuestInitialSyncState(env,fp,key,"pending");
          if(!["pending","unchanged"].includes(marker.status))
            return {status:"marker-repair-failed",created:1};
        }
        created++;break;
      }
      // Another request won the create race. Do not replace its state.
      existing.add(keyPath);
    }
    return {status:created?"queued":"idle",created};
  }catch(error){
    return {status:error?.code==="guest-sync-storage-write-failed"?
      "storage-write-failed":"reconciliation-unavailable",created:0};
  }
}

async function recordLockWait(env,record,lockStatus,now){
  try{
    const bucket=env.CAPTAIN_BUCKET,key=recordKey(record.fingerprint);
    const latest=await readStored(bucket,key);
    if(!latest||!valid(latest.value,record.fingerprint)||
       !(latest.value.status==="queued"||
         (latest.value.status==="running"&&
          Date.parse(latest.value.claimUntil)<=now))||
       latest.value.updatedAt!==record.updatedAt||
       latest.value.phase!==record.phase)return;
    const terminal=["lock-invalid-request","lock-invalid-response",
      "lock-unexpected-response"].includes(lockStatus);
    const {claimToken,claimUntil,...previous}=latest.value;
    const saved={...previous,status:terminal?"failed":"queued",
      updatedAt:stamp(now),nextAt:stamp(now+(terminal?0:LOCK_RETRY_MS)),
      lastOutcome:lockStatus};
    await replaceRecord(bucket,key,saved,latest.item.etag);
    return terminal;
  }catch{}
}
async function recordLockReleaseFailure(env,now,status){
  try{
    const bucket=env.CAPTAIN_BUCKET,key=recordKey(status.fingerprint);
    const latest=await readStored(bucket,key);
    if(!latest||!valid(latest.value,status.fingerprint)||
       latest.value.updatedAt!==stamp(now))return;
    await replaceRecord(bucket,key,{...latest.value,
      lockReleaseStatus:status.lockReleaseStatus,
      lockReleaseHttpStatus:status.lockReleaseHttpStatus||null},latest.item.etag);
  }catch{}
}

// Called only AFTER successful explicit admin approval AND binding, not on
// Scopely OAuth alone. Idempotent; never resets an existing completed run.
export async function enqueueGuestInitialSync(env,fp,key,now=Date.now(),{restart=false}={}){
  if(!FP.test(fp||"")||!KEY.test(key||"")||!Number.isFinite(now))
    return {status:"invalid-selection"};
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
    return {status:"storage-unavailable"};
  if(!await isApprovedBound(env,fp,key))
    return {status:"not-approved-and-bound"};
  const bucket=env.CAPTAIN_BUCKET,rkey=recordKey(fp);
  let previous;
  try{previous=await readStored(bucket,rkey);}
  catch{return {status:"storage-read-failed"};}
  if(previous&&!valid(previous.value,fp))return {status:"invalid-record"};
  const approvals=await readGuestApprovals(env);
  if(approvals.status==="invalid-registry")return {status:"invalid-approval-registry"};
  const approved=approvals.alliances.find(a=>a.fingerprint===fp&&
    a.allianceKey===key);
  if(!approved)return {status:"not-approved-and-bound"};
  if(approved.initialSyncStatus==="binding-changed")
    return {status:"binding-changed-requires-review"};
  if(previous?.value?.allianceKey!==undefined&&previous.value.allianceKey!==key)
    return {status:"binding-changed-requires-review"};
  if(previous){
    const record=previous.value;
    if(!restart)
      return {status:record.status,progress:publicState(record)};
    if(pending(record.status))
      return {status:"already-pending",progress:publicState(record)};
    if(record.status==="complete")
      return {status:"already-complete",progress:publicState(record)};
    if(!["failed","stopped"].includes(record.status))
      return {status:"not-restartable",progress:publicState(record)};
    const {claimToken,claimUntil,...saved}=record;
    const resumed={...saved,status:"queued",updatedAt:stamp(now),
      deadlineAt:stamp(now+DEADLINE_MS),nextAt:stamp(now),attempts:0,
      lastOutcome:"admin-restart"};
    try{
      const marked=await setGuestInitialSyncState(env,fp,key,"restart-requested");
      if(!["restart-requested","unchanged"].includes(marked.status))
        return {status:"storage-write-failed"};
      const replaced=await replaceRecord(bucket,rkey,resumed,previous.item.etag);
      if(replaced){
        let lifecycleMarker;
        try{lifecycleMarker=await setGuestInitialSyncState(env,fp,key,"pending");}
        catch{lifecycleMarker={status:"unavailable"};}
        return {status:"queued",progress:{...publicState(resumed),
          ...(lifecycleMarker&&!["pending","unchanged"].includes(lifecycleMarker.status)?
            {lifecycleMarkerStatus:lifecycleMarker.status}:{})}};
      }
      const latest=await read(bucket,rkey);
      return latest&&valid(latest,fp)?
        {status:latest.status,progress:publicState(latest)}:
        {status:"storage-conflict"};
    }catch{return {status:"storage-write-failed"};}
  }
  if(approved.initialSyncStatus==="complete")
    return {status:"already-complete",progress:{status:"complete",phase:"done"}};
  if(approved.initialSyncStatus!=="pending"&&!restart)
    return {status:approved.initialSyncStatus||"pending-registration"};
  if(approved.initialSyncStatus!=="pending"){
    const marked=await setGuestInitialSyncState(env,fp,key,"restart-requested");
    if(!["restart-requested","unchanged"].includes(marked.status))
      return {status:"storage-write-failed"};
  }
  const record=newRequest(fp,key,now);
  try{
    const created=await createRecord(bucket,rkey,record);
    if(created){
      if(approved.initialSyncStatus==="restart-requested"||restart){
        let lifecycleMarker;
        try{lifecycleMarker=await setGuestInitialSyncState(env,fp,key,"pending");}
        catch{lifecycleMarker={status:"unavailable"};}
        return {status:"queued",progress:{...publicState(record),
          ...(lifecycleMarker&&!["pending","unchanged"].includes(lifecycleMarker.status)?
            {lifecycleMarkerStatus:lifecycleMarker.status}:{})}};
      }
      return {status:"queued",progress:publicState(record)};
    }
    const latest=await read(bucket,rkey);
    if(!latest||!valid(latest,fp))return {status:"storage-conflict"};
    if(latest.allianceKey!==key)return {status:"binding-changed-requires-review"};
    return {status:latest.status,progress:publicState(latest)};
  }catch{return {status:"storage-write-failed"};}
}
export async function guestInitialSyncStatus(env,fp){
  if(!FP.test(fp||""))return {status:"invalid-selection"};
  try{
    const record=await read(env.CAPTAIN_BUCKET,recordKey(fp));
    if(record&&!valid(record,fp))return {status:"invalid-record"};
    if(record){
      const guest=await readGuestApprovals(env);
      const row=(guest.alliances||[]).find(a=>a.fingerprint===fp);
      if(row?.initialSyncStatus==="binding-changed")
        return {status:"binding-changed"};
      if(row?.initialSyncStatus==="restart-requested")
        return {...publicState(record),status:"restart-requested"};
      return publicState(record);
    }
    const [guest,losp]=await Promise.all([readGuestApprovals(env),readApproval(env)]);
    if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
      return {status:"invalid-approval-registry"};
    const row=(guest.alliances||[]).find(a=>a.fingerprint===fp&&
      KEY.test(a.allianceKey||""));
    const isLosp=(losp.alliances||[]).some(a=>a.fingerprint===fp);
    if(!row||isLosp)return {status:"not-started"};
    if(["complete","failed","stopped","binding-changed"]
      .includes(row.initialSyncStatus))
      return {status:row.initialSyncStatus,
        ...(row.initialSyncStatus==="complete"?{phase:"done"}:{})};
    if(row.initialSyncStatus==="restart-requested")
      return {status:"restart-requested"};
    return {status:"pending-registration"};
  }catch{return {status:"unavailable"};}
}

// Read fresh official AllianceCard for *this* approved alliance only.
// Current trophies are retained as CURRENT observations, not forged war-day
// history. Ranks feed the normal guest-season rolling reader when available.
// The public guest player directory is published from verified private Infos,
 // not by the Worker itself. A single wake-up saves waiting for the next
 // scheduled GitHub Actions slot. Never forward any names or roster data.
export async function dispatchInitialGuestDirectory(env,fetchGithub=fetch){
  if(env?.ROSTER_GITHUB_DISPATCH_ENABLED!=="true"||
     !env?.ROSTER_GITHUB_DISPATCH_TOKEN)
    return "not-configured";
  try{
    const response=await fetchGithub(DIRECTORY_DISPATCH,{
      method:"POST",headers:{
        Accept:"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28",
        "User-Agent":"LoSP-Roster-Service",
        Authorization:"Bearer "+env.ROSTER_GITHUB_DISPATCH_TOKEN,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({ref:"main"}),redirect:"manual"
    });
    return response.status===204?"dispatched":"github-unavailable";
  }catch{return "github-unavailable";}
}
export async function captureInitialGuestCard(env,fp,key,now,fetchImpl=fetch){
  const selected=await chooseAccount(env,fp,fetchImpl);
  if(selected.status!=="ok")return {status:selected.status};
  const card=await discoverAlliance(selected.token,fetchImpl);
  if(!card.ok||card.aid!==selected.aid)return {status:"alliance-changed"};
  if(!await isApprovedBound(env,fp,key))
    return {status:"approval-withdrawn"};
  const capture={version:1,source:"/player/v1/alliance/card",
    capturedAt:stamp(now),completeSessionScan:false,
    alliances:[{allianceFingerprint:fp,name:card.name,
      warRank:card.warRank,raidRank:card.raidRank,
      warTrophies:card.warTrophies,warLeague:card.warLeague,
      connectedSessions:1}]};
  await write(env.CAPTAIN_BUCKET,currentCardKey(fp),{
    version:1,fingerprint:fp,allianceKey:key,
    source:capture.source,capturedAt:capture.capturedAt,
    nameAtCapture:card.name,warTrophies:validCardInt(card.warTrophies)?card.warTrophies:null,
    warRank:validCardInt(card.warRank)?card.warRank:null,
    raidRank:validCardInt(card.raidRank)?card.raidRank:null
  });
  if(!validCardInt(card.warRank)||!validCardInt(card.raidRank))
    return {status:"ranks-unavailable"};
  const projected=await archiveGuestSeasonRankSample(env,capture,now);
  // The first trophy value is attached to the latest REAL grouped capture
  // day, while its own actual Scopely capture timestamp remains unchanged.
  // If no grouped source exists yet, a later R2-only phase retries it.
  let trophyStatus="not-collected";
  if(validCardInt(card.warTrophies)){
    try{
      const trophies=await archiveInitialGuestTrophies(env,{
        fingerprint:fp,allianceKey:key,nameAtCapture:card.name,
        warTrophies:card.warTrophies,capturedAt:capture.capturedAt
      },now);
      trophyStatus=trophies.status;
    }catch{trophyStatus="unavailable";}
  }
  return {status:["updated","unchanged"].includes(projected.status)?
    "captured":projected.status,trophyStatus};
}

// No second AllianceCard GET: retry only the authentic first card held in R2.
export async function archiveCachedInitialGuestTrophies(env,fp,key,now=Date.now()){
  if(!FP.test(fp||"")||!KEY.test(key||""))
    return {status:"invalid-selection"};
  try{
    const row=await read(env.CAPTAIN_BUCKET,currentCardKey(fp));
    if(row?.version!==1||row.fingerprint!==fp||row.allianceKey!==key||
       row.source!=="/player/v1/alliance/card")
      return {status:"awaiting-card"};
    return archiveInitialGuestTrophies(env,{
      fingerprint:fp,allianceKey:key,nameAtCapture:row.nameAtCapture,
      warTrophies:row.warTrophies,capturedAt:row.capturedAt
    },now);
  }catch{return {status:"unavailable"};}
}

// Resume on each existing minute tick until ALL initial sources exist.
// Collection windows for official rewards, trophy days and Sunday Evolution
// remain unchanged: these cannot be retroactively fabricated.
export async function runGuestInitialSyncTick(env,now=Date.now(),fetchImpl=fetch,deps={}){
  if(env?.ROSTER_AUTO_ENABLED!=="true"||
     env?.ROSTER_RETENTION_CONFIRMED!=="true"||
     env?.MEMBER_INFO_AUTO_ENABLED!=="true")
    return {status:"disabled",requests:0};
  if(!Number.isFinite(now))return {status:"invalid-time",requests:0};
  if(!captainConfigReady(env)||!env?.CAPTAIN_BUCKET?.get||
     !env?.CAPTAIN_BUCKET?.put||!env?.CAPTAIN_BUCKET?.list)
    return {status:"storage-unavailable",requests:0};
  try{
    const bucket=env.CAPTAIN_BUCKET;
    const reconciliation=await reconcileGuestInitialSyncRequests(env,now);
    const listing=await bucket.list({prefix:ROOT,limit:QUEUE_LIST_LIMIT});
    if(!listing||listing.truncated)return {status:"queue-too-large",requests:0};
    const states=[];
    for(const item of listing.objects||[]){
      const match=/^roster-batches\/v1\/guest-initial-sync\/([a-f0-9]{64})\.json$/.exec(item.key||"");
      if(!match)continue; // Exclude -card.json and other receipts.
      const rec=await read(bucket,item.key);
      if(!valid(rec,match[1]))return {status:"invalid-queue",requests:0};
      if(pending(rec.status))states.push(rec);
    }
    const due=states.filter(x=>Date.parse(x.nextAt)<=now)
      .sort((a,b)=>Date.parse(a.nextAt)-Date.parse(b.nextAt)||
        a.requestedAt.localeCompare(b.requestedAt))[0];
    if(!due){
      const status=states.length?"cooldown":
        ["idle","repaired"].includes(reconciliation.status)?
          "idle":"reconciliation-unavailable";
      return {status,requests:0,reconciliationStatus:reconciliation.status};
    }
    if(!env?.ROSTER_BATCH_LOCK?.idFromName||!env?.ROSTER_BATCH_LOCK?.get){
      await recordLockWait(env,due,"lock-unavailable",now);
      return {status:"lock-unavailable",phase:due.phase,
        lastOutcome:"lock-unavailable",requests:0,
        reconciliationStatus:reconciliation.status};
    }
    const result=await locking(env,async()=>{
      const latest=await read(bucket,recordKey(due.fingerprint));
      if(!valid(latest,due.fingerprint))return {status:"invalid-queue",requests:0};
      if(!pending(latest.status)||Date.parse(latest.nextAt)>now)
        return {status:"already-processed",requests:0};
      if(latest.status==="running"&&latest.claimUntil&&
         Date.parse(latest.claimUntil)>now)
        return {status:"already-processed",requests:0};
      if(Date.parse(latest.deadlineAt)<=now||latest.attempts>=MAX_ATTEMPTS){
        const {claimToken,claimUntil,...record}=latest;
        await write(bucket,recordKey(latest.fingerprint),{
          ...record,status:"failed",updatedAt:stamp(now),
          lastOutcome:"initial-sync-deadline-exceeded"});
        await setGuestInitialSyncState(env,latest.fingerprint,
          latest.allianceKey,"failed");
        return {status:"failed",requests:0};
      }
      if(!await isApprovedBound(env,latest.fingerprint,latest.allianceKey)){
        const {claimToken,claimUntil,...record}=latest;
        await write(bucket,recordKey(latest.fingerprint),{
          ...record,status:"stopped",updatedAt:stamp(now),
          lastOutcome:"approval-or-binding-withdrawn"});
        return {status:"stopped",requests:0};
      }
      const fp=latest.fingerprint,key=latest.allianceKey;
      const claimed={...latest,status:"running",claimToken:crypto.randomUUID(),
        claimUntil:stamp(now+LOCK_LEASE_MS),nextAt:stamp(now+LOCK_LEASE_MS),
        attempts:latest.attempts+1,updatedAt:stamp(now),
        lastOutcome:"collection-in-progress",lockReleaseStatus:null,
        lockReleaseHttpStatus:null};
      await write(bucket,recordKey(fp),claimed);
      let result={status:"unavailable",requests:0};
      try{
        if(latest.phase==="roster"){
          const window=currentCampaign(now);
          if(window&&window.campaign.endsWith("-am")&&
             new Date(now).getUTCHours()<2)
            result={status:"campaign-not-open",requests:0};
          else{
            const roster=deps.roster||runRosterAutoTick;
            const value=await roster(env,{scheduledTime:now,cron:ROSTER_CRON},
              fetchImpl,{manual:true,targetFingerprint:fp,bootstrap:true});
            result={status:value.status==="busy"?"roster-lock-busy":value.status,
              requests:value.requestsThisTick||0};
          }
        }else if(latest.phase==="infos"){
          const slot=currentCampaign(now);
          const hour=new Date(now).getUTCHours();
          // Initial catch-up must not create a receipt outside the verified
          // AM/PM capture windows. Keep the campaign and real timestamp intact.
          if((slot.campaign.endsWith("-am")&&(hour<2||hour>=4))||
             (slot.campaign.endsWith("-pm")&&(hour<14||hour>=16)))
            result={status:"campaign-not-open",requests:0};
          else{
            const info=deps.infos||runMemberInfoTick;
            const value=await info(env,fp,{campaign:slot.campaign,stamp:stamp(now)},
              fetchImpl,{maxCardsPerTick:8});
            result={status:value.status,requests:value.requests||0};
          }
        }else if(latest.phase==="ranks"){
          const ranks=deps.ranks||captureInitialGuestCard;
          result=await ranks(env,fp,key,now,fetchImpl);
        }else if(latest.phase==="arena"){
          const arena=deps.arena||archiveGuestInitialArena;
          const value=await arena(env,fp,key,now);
          result={status:value.status,requests:0};
        }else if(latest.phase==="trophies"){
          const trophies=deps.trophies||archiveCachedInitialGuestTrophies;
          result=await trophies(env,fp,key,now);
        }
      }catch{result={status:"unavailable",requests:0};}
      if(!await isApprovedBound(env,fp,key))
        result={status:"approval-or-binding-withdrawn",requests:result.requests||0};
      const done=(latest.phase==="ranks"&&result.status==="captured")||
        (latest.phase==="trophies"&&
          ["updated","already-recorded"].includes(result.status))||
        (latest.phase==="arena"&&
          ["updated","unchanged","already-reward-captured"].includes(result.status))||
        (["roster","infos"].includes(latest.phase)&&
          ["complete","partial-consent"].includes(result.status));
      const stages=["ranks","infos","roster","arena","trophies","done"];
      const next=done?stages[stages.indexOf(latest.phase)+1]:latest.phase;
      const fatal=["alliance-not-approved","approval-withdrawn",
        "approval-or-binding-withdrawn",
        "invalid-selection","invalid-approvals"].includes(result.status);
      const pause=done?1:result.status==="rate-limited"?60:
        result.status==="campaign-not-open"?5:
        ["unavailable","busy","roster-lock-busy","already-processed"].includes(result.status)?2:1;
      // Nonblocking: roster/rank/arena collection must never wait for GitHub.
      // Existing scheduled publishing remains the fallback if dispatch fails.
      const directoryDispatch=latest.phase==="infos"&&done?
        await dispatchInitialGuestDirectory(env,deps.githubFetch||fetch):null;
      const {claimToken,claimUntil,...record}=claimed;
      const saved={...record,status:fatal?"stopped":next==="done"?"complete":"queued",
        phase:next,updatedAt:stamp(now),
        nextAt:stamp(now+pause*60000),lastOutcome:result.status,
        ...(directoryDispatch?{directoryDispatch}:{})};
      await write(bucket,recordKey(fp),saved);
      const lifecycleMarker=saved.status==="complete"||saved.status==="failed"||
        saved.status==="stopped"?
        await setGuestInitialSyncState(env,fp,key,saved.status):null;
      return {status:saved.status,phase:saved.phase,lastOutcome:result.status,
        ...(lifecycleMarker&&! ["complete","failed","stopped","unchanged"].includes(lifecycleMarker.status)?
          {lifecycleMarkerStatus:lifecycleMarker.status}:{}),
        requests:result.requests||0};
    }).catch(async error=>{
      if(error?.lockReleaseStatus)
        await recordLockReleaseFailure(env,now,{...error,fingerprint:due.fingerprint});
      return {status:error?.code==="guest-sync-storage-write-failed"?
        "storage-write-failed":"unavailable",phase:due.phase,
        lastOutcome:"processing-error",requests:0,
        ...(error?.lockReleaseStatus?{lockReleaseStatus:error.lockReleaseStatus}:{}),
        ...(error?.lockReleaseHttpStatus?
          {lockReleaseHttpStatus:error.lockReleaseHttpStatus}:{})};
    });
    if(result.status.startsWith("lock-")&&result.status!=="lock-release-failed"){
      const terminal=await recordLockWait(env,due,result.status,now);
      if(terminal)await setGuestInitialSyncState(env,due.fingerprint,
        due.allianceKey,"failed");
      return {...result,phase:due.phase,lastOutcome:result.status,requests:0,
        reconciliationStatus:reconciliation.status};
    }
    if(result.lockReleaseStatus)
      await recordLockReleaseFailure(env,now,{...result,fingerprint:due.fingerprint});
    return {...result,reconciliationStatus:reconciliation.status};
  }catch(error){
    return {status:error?.code==="guest-sync-storage-write-failed"?
      "storage-write-failed":"unavailable",requests:0,
      ...(error?.lockReleaseStatus?{lockReleaseStatus:error.lockReleaseStatus}:{}),
      ...(error?.lockReleaseHttpStatus?
        {lockReleaseHttpStatus:error.lockReleaseHttpStatus}:{})};
  }
}

// R2-only admin status and explicit retry after any failed/expired run.
// No user-supplied fingerprint is ever passed directly to a provider.
export async function handleGuestInitialSync(request,env,now=Date.now()){
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||url.searchParams.getAll("fingerprint").length>1)
    return answer({status:"invalid-query"},400);
  const fp=url.searchParams.get("fingerprint");
  if(!FP.test(fp||""))return answer({status:"invalid-selection"},400);
  if(request.method==="GET")return answer(await guestInitialSyncStatus(env,fp));
  if(request.method!=="POST")return answer({status:"method-not-allowed"},405);
  if(request.headers.get("Origin")!==ORIGIN||
     !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("Content-Type")||""))
    return answer({status:"forbidden"},403);
  let body;
  try{
    const raw=await request.text();
    if(raw.length>80)throw Error("invalid");
    body=JSON.parse(raw);
    if(body?.action!=="restart"||Object.keys(body).length!==1)
      throw Error("invalid");
  }catch{return answer({status:"invalid-body"},400);}
  const registry=await readGuestApprovals(env);
  const selected=(registry.alliances||[]).find(a=>
    a.fingerprint===fp&&KEY.test(a.allianceKey||""));
  if(!selected)return answer({status:"not-approved-and-bound"},409);
  const result=await enqueueGuestInitialSync(env,fp,selected.allianceKey,now,
    {restart:true});
  return answer(result,result.status==="queued"?202:409);
}
