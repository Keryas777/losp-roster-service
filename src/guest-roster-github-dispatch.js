// Guest roster publisher: uses the existing GitHub import workflow and
// completed private R2 receipts. No roster payloads or OAuth credentials
// are ever sent to the GitHub workflow dispatch API.
import {campaignCompleteKey} from "./private-roster-batches.js";
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";

const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/pull-rosters-r2.yml/dispatches";
const ROOT="roster-auto/v1/github-guest-dispatch/";
const FP=/^[a-f0-9]{64}$/;
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const stamp=v=>typeof v==="string"?Date.parse(v):NaN;

export function guestRosterDispatchReceiptValid(receipt,fp,slot,now=Date.now()){
  if(!FP.test(fp||"")||!/^\d{4}-\d{2}-\d{2}-(am|pm)$/.test(slot?.campaign||"")||
     slot.campaign!==slot.date+"-"+slot.campaign.slice(-2))return false;
  const period=slot.campaign.slice(-2);
  const start=Date.parse(slot.date+(period==="am"?"T02:00:00Z":"T14:00:00Z"));
  const end=Date.parse(slot.date+(period==="am"?"T04:00:00Z":"T16:00:00Z"));
  const recovered=receipt?.manualRecovery===true&&
    receipt?.progress?.manualRecovery===true;
  const until=recovered?
    (period==="am"?Date.parse(slot.date+"T14:00:00Z"):
      Date.parse(slot.date+"T00:00:00Z")+86400000):end;
  const p=receipt?.progress,m=receipt?.manifest;
  return receipt?.version===1&&receipt?.campaign===slot.campaign&&
    (receipt.manualRecovery===undefined||recovered)&&
    object(p)&&object(m)&&
    p.fingerprint===fp&&m.fingerprint===fp&&
    p.campaign===slot.campaign&&p.selfCompleted===true&&
    Number.isSafeInteger(p.completed)&&p.completed>=0&&
    p.completed===p.totalEligible&&
    m.runId===p.runId&&m.membershipDigest===p.membershipDigest&&
    m.coMembers===p.completed&&m.total===p.completed+1&&
    m.includesPersonal===true&&
    Number.isFinite(stamp(m.capturedAt))&&
    stamp(m.capturedAt)>=start&&stamp(m.capturedAt)<until&&
    stamp(m.expiresAt)>now;
}
async function ready(bucket,fp,slot){
  const item=await bucket.get(campaignCompleteKey(fp,slot.campaign));
  if(!item)return false;
  if(Number.isFinite(item.size)&&item.size>64000)return false;
  const raw=await item.text();
  if(raw.length>64000)return false;
  let record;
  try{record=JSON.parse(raw);}catch{return false;}
  return guestRosterDispatchReceiptValid(record,fp,slot);
}

export async function dispatchGuestRosterCampaigns(env,slot,fetchGithub=fetch){
  if(env?.ROSTER_GITHUB_DISPATCH_ENABLED!=="true")
    return {status:"disabled"};
  if(typeof env?.ROSTER_GITHUB_DISPATCH_TOKEN!=="string"||
     !env.ROSTER_GITHUB_DISPATCH_TOKEN)
    return {status:"not-configured"};
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!slot?.campaign||
     !Number.isInteger(slot.tick)||slot.tick<0)
    return {status:"invalid-configuration"};
  const [guests,losp]=await Promise.all([
    readGuestApprovals(env),readApproval(env)]);
  if(guests.status==="invalid-registry"||losp.status==="invalid-registry")
    return {status:"invalid-registry"};
  const owned=new Set((losp.alliances||[]).map(a=>a.fingerprint));
  const approved=(guests.alliances||[]).filter(a=>
    FP.test(a.fingerprint)&&KEY.test(a.allianceKey||"")&&
    !owned.has(a.fingerprint)).sort((a,b)=>a.allianceKey.localeCompare(b.allianceKey));
  if(!approved.length)return {status:"no-bound-guests"};
  // At most four read-only receipt checks and four dispatches per tick.
  // Rotate fairly, without hardcoding the number or names of alliances.
  const scanCount=Math.min(4,approved.length),start=(slot.tick*4)%approved.length;
  const selected=Array.from({length:scanCount},(_,i)=>
    approved[(start+i)%approved.length]);
  const result={status:"ok",selected:scanCount,dispatched:0,
    already:0,awaiting:0,failed:0};
  for(const row of selected){
    const marker=ROOT+slot.campaign+"/"+row.fingerprint+".json";
    try{
      if(await bucket.get(marker)){result.already++;continue;}
      if(!await ready(bucket,row.fingerprint,slot)){result.awaiting++;continue;}
      const response=await fetchGithub(API,{
        method:"POST",
        headers:{"Accept":"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28",
          "User-Agent":"LoSP-Roster-Service",
          "Authorization":"Bearer "+env.ROSTER_GITHUB_DISPATCH_TOKEN,
          "Content-Type":"application/json"},
        body:JSON.stringify({ref:"main",inputs:{
          date:slot.date,period:slot.campaign.slice(-2),
          guest_alliance:row.allianceKey,publish:"true",strict:"true"
        }})
      });
      if(response.status!==204){result.failed++;continue;}
      await bucket.put(marker,JSON.stringify({version:1,
        campaign:slot.campaign,allianceKey:row.allianceKey,
        dispatchedAt:new Date().toISOString()}),{
        httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
      });
      result.dispatched++;
    }catch{result.failed++;}
  }
  return result;
}
