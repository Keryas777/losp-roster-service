// Wake GitHub as soon as every approved alliance has a fresh private R2
// AllianceCard. Independent of completion of any player's roster campaign.
import {trophyCardKey,BATCH_PREFIX} from "./private-roster-batches.js";

const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/pull-alliance-standings-r2.yml/dispatches";
const ROOT="roster-auto/v1/trophy-github-dispatch/";
const FP=/^[a-f0-9]{64}$/;
const iso=x=>typeof x==="string"?Date.parse(x):NaN;
export async function dispatchCompleteTrophyCards(env,slot,allianceFingerprints,fetchGithub=fetch){
  // Trophy samples are taken only on the morning AFTER Wednesday/Friday wars.
  if(!/^\d{4}-\d{2}-\d{2}$/.test(slot?.date||"")||
     slot?.campaign!==slot.date+"-am"||
     ![4,6].includes(new Date(slot.date+"T00:00:00Z").getUTCDay()))
    return "outside-trophy-day";
  if(env?.TROPHY_GITHUB_DISPATCH_ENABLED!=="true")return "disabled";
  const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN; // Reuse existing dedicated GitHub token.
  if(typeof token!=="string"||!token)return "not-configured";
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!Array.isArray(allianceFingerprints)||
     allianceFingerprints.length<1||allianceFingerprints.length>30||
     new Set(allianceFingerprints).size!==allianceFingerprints.length||
     allianceFingerprints.some(fp=>!FP.test(fp)))return "invalid-configuration";
  const dispatchedKey=ROOT+slot.date+".json";
  if(await bucket.get(dispatchedKey))return "already-dispatched";
  const from=Date.parse(slot.date+"T02:00:00Z");
  const until=Date.parse(slot.date+"T04:00:00Z");
  // Every marker is written only after its original AllianceCard source has
  // been archived under the existing private seven-day R2 lifecycle.
  for(const fp of allianceFingerprints){
    const obj=await bucket.get(trophyCardKey(fp,slot.campaign));
    if(!obj)return "awaiting-all";
    let marker;
    try{
      const raw=await obj.text();
      if(raw.length>2000)return "invalid-marker";
      marker=JSON.parse(raw);
    }catch{return "invalid-marker";}
    const sourcePrefix=BATCH_PREFIX+fp+"/";
    if(marker?.version!==1||marker.kind!=="trophy-card-ready"||
       marker.fingerprint!==fp||marker.campaign!==slot.campaign||
       !Number.isFinite(iso(marker.capturedAt))||
       iso(marker.capturedAt)<from||iso(marker.capturedAt)>=until||
       iso(marker.capturedAt)>Date.now()||
       typeof marker.sourceKey!=="string"||
       !marker.sourceKey.startsWith(sourcePrefix)||
       !/^roster-batches\/v1\/[a-f0-9]{64}\/[a-f0-9-]{36}\/provider-source\/[a-f0-9-]{36}\/alliance-card\.json$/.test(marker.sourceKey))
      return "invalid-marker";
  }
  let response;
  try{
    response=await fetchGithub(API,{
      method:"POST",
      headers:{"Accept":"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28",
        "User-Agent":"LoSP-Roster-Service",
        "Authorization":"Bearer "+token,
        "Content-Type":"application/json"},
      body:JSON.stringify({ref:"main",inputs:{
        date:slot.date,publish:"true",early:"true"
      }})
    });
  }catch{return "github-unavailable";}
  if(response.status!==204)return "github-unavailable";
  await bucket.put(dispatchedKey,JSON.stringify({version:1,day:slot.date,
    dispatchedAt:new Date().toISOString()}),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  return "dispatched";
}
