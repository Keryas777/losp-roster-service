// Opt-in GitHub Actions wake-up after all approved R2 roster receipts exist.
// No player data, OAuth grants or provider tokens are sent to GitHub.
import {campaignCompleteKey} from "./private-roster-batches.js";

const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/pull-rosters-r2.yml/dispatches";
const ROOT="roster-auto/v1/github-dispatch/";
const FP=/^[a-f0-9]{64}$/;
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const stamp=x=>typeof x==="string"?Date.parse(x):NaN;
const markerKey=campaign=>ROOT+campaign+".json";
export async function dispatchCompleteRosterCampaign(env,slot,allianceFingerprints,fetchGithub=fetch){
  if(env?.ROSTER_GITHUB_DISPATCH_ENABLED!=="true")return "disabled";
  // Explicit secret required; never use an API token from the MSF game.
  const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(typeof token!=="string"||!token)return "not-configured";
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!Array.isArray(allianceFingerprints)||
     allianceFingerprints.length<1||allianceFingerprints.length>30||
     new Set(allianceFingerprints).size!==allianceFingerprints.length||
     allianceFingerprints.some(fp=>!FP.test(fp)))return "invalid-configuration";
  if(!/^\d{4}-\d{2}-\d{2}-(?:am|pm)$/.test(slot?.campaign)||
     slot.campaign!==slot.date+"-"+slot.campaign.slice(-2))
    return "invalid-campaign";
  const period=slot.campaign.endsWith("-am")?"am":"pm";
  const from=Date.parse(slot.date+(period==="am"?"T02:00:00Z":"T14:00:00Z"));
  const until=Date.parse(slot.date+(period==="am"?"T04:00:00Z":"T16:00:00Z"));
  if(!Number.isFinite(from)||!Number.isFinite(until))return "invalid-campaign";
  const marker=markerKey(slot.campaign);
  if(await bucket.get(marker))return "already-dispatched";
  // A receipt is written only AFTER authorized member + personal snapshots.
  // The importer will revalidate every physical R2 file before publication.
  for(const fp of allianceFingerprints){
    const object=await bucket.get(campaignCompleteKey(fp,slot.campaign));
    if(!object)return "awaiting-all";
    const raw=await object.text();
    if(raw.length>64000)return "invalid-receipt";
    let receipt;
    try{receipt=JSON.parse(raw);}catch{return "invalid-receipt";}
    const p=receipt?.progress,m=receipt?.manifest;
    if(receipt?.version!==1||receipt.campaign!==slot.campaign||
       !isObject(p)||!isObject(m)||p.fingerprint!==fp||
       m.fingerprint!==fp||p.campaign!==slot.campaign||
       p.selfCompleted!==true||!Number.isInteger(p.completed)||
       p.completed!==p.totalEligible||m.runId!==p.runId||
       m.membershipDigest!==p.membershipDigest||
       m.total!==p.completed+1||m.includesPersonal!==true||
       !Number.isFinite(stamp(m.capturedAt))||
       stamp(m.capturedAt)<from||stamp(m.capturedAt)>=until||
       !Number.isFinite(stamp(m.expiresAt))||stamp(m.expiresAt)<=Date.now())
      return "invalid-receipt";
  }
  const response=await fetchGithub(API,{
    method:"POST",
    headers:{"Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"LoSP-Roster-Service",
      "Authorization":"Bearer "+token,
      "Content-Type":"application/json"},
    body:JSON.stringify({ref:"main",inputs:{
      date:slot.date,period,publish:"true",strict:"true"
    }})
  });
  if(response.status!==204)return "github-unavailable";
  await bucket.put(marker,JSON.stringify({version:1,campaign:slot.campaign,
    dispatchedAt:new Date().toISOString()}),{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
  return "dispatched";
}
