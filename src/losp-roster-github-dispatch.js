// Publish each approved LoSP alliance independently after its own complete R2 receipt.
// No roster payload, player identity or provider token is sent to GitHub.
import {campaignCompleteKey} from "./private-roster-batches.js";
import {readApproval} from "./roster-sync-preflight.js";
import {guestRosterDispatchReceiptValid} from "./guest-roster-github-dispatch.js";

const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/pull-rosters-r2.yml/dispatches";
const ROOT="roster-auto/v1/github-losp-dispatch/";
const FP=/^[a-f0-9]{64}$/;

export async function dispatchLoSPRosterCampaigns(env,slot,fetchGithub=fetch){
  if(env?.ROSTER_GITHUB_DISPATCH_ENABLED!=="true")return {status:"disabled"};
  if(typeof env?.ROSTER_GITHUB_DISPATCH_TOKEN!=="string"||
     !env.ROSTER_GITHUB_DISPATCH_TOKEN)return {status:"not-configured"};
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!Number.isInteger(slot?.tick)||
     slot.tick<0)return {status:"invalid-configuration"};
  const approval=await readApproval(env);
  if(approval.status!=="configured")return {status:"not-configured"};
  const approved=approval.alliances.filter(a=>FP.test(a.fingerprint))
    .sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
  if(!approved.length)return {status:"no-approved-alliances"};
  const selected=Array.from({length:Math.min(4,approved.length)},(_,i)=>
    approved[(slot.tick*4+i)%approved.length]);
  const result={status:"ok",dispatched:0,already:0,awaiting:0,failed:0};
  for(const row of selected){
    const marker=ROOT+slot.campaign+"/"+row.fingerprint+".json";
    try{
      if(await bucket.get(marker)){result.already++;continue;}
      const item=await bucket.get(campaignCompleteKey(row.fingerprint,slot.campaign));
      if(!item||item.size>64000){result.awaiting++;continue;}
      const raw=await item.text();
      if(raw.length>64000){result.awaiting++;continue;}
      const receipt=JSON.parse(raw);
      if(!guestRosterDispatchReceiptValid(receipt,row.fingerprint,slot)){
        result.awaiting++;continue;
      }
      const response=await fetchGithub(API,{
        method:"POST",
        headers:{"Accept":"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28",
          "User-Agent":"LoSP-Roster-Service",
          "Authorization":"Bearer "+env.ROSTER_GITHUB_DISPATCH_TOKEN,
          "Content-Type":"application/json"},
        body:JSON.stringify({ref:"main",inputs:{
          date:slot.date,period:slot.campaign.slice(-2),
          losp_fingerprint:row.fingerprint,publish:"true",strict:"true"
        }})
      });
      if(response.status!==204){result.failed++;continue;}
      await bucket.put(marker,JSON.stringify({version:1,campaign:slot.campaign,
        dispatchedAt:new Date().toISOString()}),{
        httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
      });
      result.dispatched++;
    }catch{result.failed++;}
  }
  return result;
}
