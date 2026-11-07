// One-time, consent-aware guest catch-up. Uses existing * * * * * cron,
// private 7-day R2 receipts and existing roster/Info collectors.
// One selected alliance and ONE bounded provider phase per invocation.
// A new approval+WebApp binding queues the catch-up; it never runs Scopely
// calls in an administrator's approval HTTP request.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {captainConfigReady} from "./captain-vault.js";
import {runRosterAutoTick,ROSTER_CRON,manualRosterWindow} from "./automatic-roster-scheduler.js";
import {runMemberInfoTick} from "./member-info-campaign.js";
import {chooseAccount} from "./private-roster-pilot.js";
import {discoverAlliance} from "./alliance-coverage.js";
import {archiveGuestSeasonRankSample} from "./public-guest-season-ranks.js";
import {archiveGuestInitialArena} from "./public-arena-history.js";

const ROOT="roster-batches/v1/guest-initial-sync/";
const FP=/^[a-f0-9]{64}$/;
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const LOCK="e".repeat(64);
const MAX_ATTEMPTS=160,DEADLINE_MS=48*60*60*1000;
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

async function read(bucket,key,max=3500){
  const item=await bucket.get(key);
  if(!item)return null;
  const value=await item.text();
  if(value.length>max)throw Error("oversized-onboarding-record");
  return JSON.parse(value);
}
async function write(bucket,key,data){
  await bucket.put(key,JSON.stringify(data),{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"}});
}
function valid(record,fp){
  return record?.version===1&&record.fingerprint===fp&&
    KEY.test(record.allianceKey||"")&&
    ["queued","running","complete","stopped","failed"].includes(record.status)&&
    ["roster","infos","ranks","arena","done"].includes(record.phase)&&
    Number.isFinite(Date.parse(record.requestedAt))&&
    Number.isFinite(Date.parse(record.updatedAt))&&
    Number.isFinite(Date.parse(record.deadlineAt))&&
    Number.isFinite(Date.parse(record.nextAt))&&
    Number.isSafeInteger(record.attempts)&&record.attempts>=0&&
    record.attempts<=MAX_ATTEMPTS&&
    (record.lastOutcome===null||
      (typeof record.lastOutcome==="string"&&record.lastOutcome.length<=72));
}
async function locking(env,fn){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.idFromName||!binding?.get)return {status:"lock-unavailable"};
  const holder=crypto.randomUUID();
  const stub=binding.get(binding.idFromName(LOCK));
  const invoke=async action=>{
    const res=await stub.fetch(new Request("https://guest-initial-lock.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,holder,fingerprint:LOCK})
    }));
    return res.ok&&(await res.json()).status===
      (action==="acquire"?"acquired":"released");
  };
  if(!await invoke("acquire"))return {status:"busy"};
  try{return await fn();}
  finally{try{await invoke("release");}catch{}}
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
    ...(record.directoryDispatch?{directoryDispatch:record.directoryDispatch}:{})};
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
  return locking(env,async()=>{
    const previous=await read(env.CAPTAIN_BUCKET,recordKey(fp));
    if(previous&&!valid(previous,fp))return {status:"invalid-record"};
    if(previous?.allianceKey!==undefined&&previous.allianceKey!==key)
      return {status:"binding-changed-requires-review"};
    if(previous&&!restart)return {status:previous.status,
      progress:publicState(previous)};
    const record={version:1,fingerprint:fp,allianceKey:key,
      status:"queued",phase:"infos",requestedAt:stamp(now),
      updatedAt:stamp(now),deadlineAt:stamp(now+DEADLINE_MS),
      nextAt:stamp(now),attempts:0,lastOutcome:null};
    await write(env.CAPTAIN_BUCKET,recordKey(fp),record);
    return {status:"queued",progress:publicState(record)};
  });
}
export async function guestInitialSyncStatus(env,fp){
  if(!FP.test(fp||""))return {status:"invalid-selection"};
  try{
    const record=await read(env.CAPTAIN_BUCKET,recordKey(fp));
    return record&&!valid(record,fp)?
      {status:"invalid-record"}:publicState(record);
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
    warTrophies:validCardInt(card.warTrophies)?card.warTrophies:null,
    warRank:validCardInt(card.warRank)?card.warRank:null,
    raidRank:validCardInt(card.raidRank)?card.raidRank:null
  });
  if(!validCardInt(card.warRank)||!validCardInt(card.raidRank))
    return {status:"ranks-unavailable"};
  const projected=await archiveGuestSeasonRankSample(env,capture,now);
  return {status:["updated","unchanged"].includes(projected.status)?
    "captured":projected.status};
}

const phaseOptions={
  roster: "roster",infos:"infos",ranks:"ranks",arena:"arena"
};
// Resume on each existing minute tick until ALL initial sources exist.
// Collection windows for official rewards, trophy days and Sunday Evolution
// remain unchanged: these cannot be retroactively fabricated.
export async function runGuestInitialSyncTick(env,now=Date.now(),fetchImpl=fetch,deps={}){
  if(env?.ROSTER_AUTO_ENABLED!=="true"||
     env?.ROSTER_RETENTION_CONFIRMED!=="true"||
     env?.MEMBER_INFO_AUTO_ENABLED!=="true"||
     !captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK?.get)
    return {status:"disabled",requests:0};
  if(!Number.isFinite(now))return {status:"invalid-time",requests:0};
  try{
    const bucket=env.CAPTAIN_BUCKET;
    const listing=await bucket.list({prefix:ROOT,limit:100});
    if(!listing||listing.truncated)return {status:"queue-too-large",requests:0};
    const states=[];
    for(const item of listing.objects||[]){
      const match=/^roster-batches\/v1\/guest-initial-sync\/([a-f0-9]{64})\.json$/.exec(item.key||"");
      if(!match)continue; // Exclude -card.json and other receipts.
      const rec=await read(bucket,item.key);
      if(!valid(rec,match[1]))return {status:"invalid-queue",requests:0};
      if(pending(rec.status))states.push(rec);
    }
    states.sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt));
    const due=states.find(x=>Date.parse(x.nextAt)<=now);
    if(!due)return {status:states.length?"cooldown":"idle",requests:0};
    return locking(env,async()=>{
      const latest=await read(bucket,recordKey(due.fingerprint));
      if(!valid(latest,due.fingerprint))return {status:"invalid-queue",requests:0};
      if(!pending(latest.status)||Date.parse(latest.nextAt)>now)
        return {status:"already-processed",requests:0};
      if(Date.parse(latest.deadlineAt)<=now||latest.attempts>=MAX_ATTEMPTS){
        await write(bucket,recordKey(latest.fingerprint),{
          ...latest,status:"failed",updatedAt:stamp(now),
          lastOutcome:"initial-sync-deadline-exceeded"});
        return {status:"failed",requests:0};
      }
      if(!await isApprovedBound(env,latest.fingerprint,latest.allianceKey)){
        await write(bucket,recordKey(latest.fingerprint),{
          ...latest,status:"stopped",updatedAt:stamp(now),
          lastOutcome:"approval-or-binding-withdrawn"});
        return {status:"stopped",requests:0};
      }
      const fp=latest.fingerprint,key=latest.allianceKey;
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
            result={status:value.status,requests:value.requestsThisTick||0};
          }
        }else if(latest.phase==="infos"){
          const info=deps.infos||runMemberInfoTick;
          const slot=currentCampaign(now);
          const value=await info(env,fp,{campaign:slot.campaign,stamp:stamp(now)},
            fetchImpl,{maxCardsPerTick:8});
          result={status:value.status,requests:value.requests||0};
        }else if(latest.phase==="ranks"){
          const ranks=deps.ranks||captureInitialGuestCard;
          result=await ranks(env,fp,key,now,fetchImpl);
        }else if(latest.phase==="arena"){
          const arena=deps.arena||archiveGuestInitialArena;
          const value=await arena(env,fp,key,now);
          result={status:value.status,requests:0};
        }
      }catch{result={status:"unavailable",requests:0};}
      const done=(latest.phase==="ranks"&&result.status==="captured")||
        (latest.phase==="arena"&&
          ["updated","unchanged","already-reward-captured"].includes(result.status))||
        (["roster","infos"].includes(latest.phase)&&
          ["complete","partial-consent"].includes(result.status));
      const stages=["infos","ranks","arena","roster","done"];
      const next=done?stages[stages.indexOf(latest.phase)+1]:latest.phase;
      const fatal=["alliance-not-approved","approval-withdrawn",
        "invalid-selection","invalid-approvals"].includes(result.status);
      const pause=done?0:result.status==="rate-limited"?60:
        result.status==="campaign-not-open"?5:
        ["unavailable","busy","already-processed"].includes(result.status)?2:1;
      // Nonblocking: roster/rank/arena collection must never wait for GitHub.
      // Existing scheduled publishing remains the fallback if dispatch fails.
      const directoryDispatch=latest.phase==="infos"&&done?
        await dispatchInitialGuestDirectory(env,deps.githubFetch||fetch):null;
      const saved={...latest,status:fatal?"failed":next==="done"?"complete":"queued",
        phase:next,attempts:latest.attempts+1,updatedAt:stamp(now),
        nextAt:stamp(now+pause*60000),lastOutcome:result.status,
        ...(directoryDispatch?{directoryDispatch}:{})};
      await write(bucket,recordKey(fp),saved);
      return {status:saved.status,phase:saved.phase,lastOutcome:result.status,
        requests:result.requests||0};
    });
  }catch{return {status:"unavailable",requests:0};}
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
