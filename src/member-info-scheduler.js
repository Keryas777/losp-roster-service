// Independent AM/PM member-info micro-campaigns on the EXISTING every-minute
// Cloudflare trigger. Separate invocation from roster cron: never adds GETs
// to a roster tick or violates its 50-subrequest Worker ceiling.
import {readApproval} from "./roster-sync-preflight.js";
import {captainConfigReady} from "./captain-vault.js";
import {runMemberInfoTick} from "./member-info-campaign.js";

export async function runMemberInfoAutoTick(env,scheduledTime,fetchImpl=fetch){
  if(env?.MEMBER_INFO_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env))return {status:"storage-unavailable"};
  if(!Number.isFinite(scheduledTime))return {status:"invalid-time"};
  const date=new Date(scheduledTime);
  const hour=date.getUTCHours(),minute=date.getUTCMinutes();
  if(!([2,3,14,15].includes(hour)))return {status:"outside-window"};
  const period=hour<12?"am":"pm";
  const campaign=date.toISOString().slice(0,10)+"-"+period;
  const stamp=date.toISOString().slice(0,16)+"Z";
  const slot={campaign,stamp};
  try{
    const approval=await readApproval(env);
    if(approval.status!=="configured"||!approval.alliances.length)
      return {status:"no-approved-alliances"};
    const alliances=approval.alliances.map(a=>a.fingerprint).sort();
    if(new Set(alliances).size!==alliances.length)return {status:"invalid-approvals"};
    const tick=(hour-(period==="am"?2:14))*60+minute;
    const fp=alliances[tick%alliances.length];
    const result=await runMemberInfoTick(env,fp,slot,fetchImpl);
    // No IDs, names, member lists or tokens in observability.
    return {status:result.status,requests:result.requests||0,
      ...(result.total?{members:result.total}:{})};
  }catch{return {status:"unavailable"};}
}
