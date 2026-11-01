// Independent AM/PM member-info micro-campaigns on the EXISTING every-minute
// Cloudflare trigger. Separate invocation from roster cron: never adds GETs
// to a roster tick or violates its 50-subrequest Worker ceiling.
import {readApproval} from "./roster-sync-preflight.js";
import {captainConfigReady} from "./captain-vault.js";
import {runMemberInfoTick} from "./member-info-campaign.js";

// Reward standings are settled at 17:00 Europe/Paris. Start the PM
// member-card campaign one minute AFTER that boundary, regardless of DST.
// Existing AM UTC collection is unchanged. Uses the already-enabled
// every-minute Worker trigger, so no extra scheduled trigger is needed.
export function memberInfoWindow(scheduledTime){
  if(!Number.isFinite(scheduledTime))return null;
  const date=new Date(scheduledTime);
  const utcHour=date.getUTCHours(),utcMinute=date.getUTCMinutes();
  if(utcHour===2||utcHour===3){
    return {period:"am",tick:(utcHour-2)*60+utcMinute};
  }
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(date)
    .filter(p=>p.type==="hour"||p.type==="minute")
    .map(p=>[p.type,Number(p.value)]));
  const parisMinute=parts.hour*60+parts.minute;
  const start=17*60+1;
  // Exactly 120 one-minute slots: 17:01 through 19:00 French time.
  if(parisMinute<start||parisMinute>=start+120)return null;
  return {period:"pm",tick:parisMinute-start};
}

export async function runMemberInfoAutoTick(env,scheduledTime,fetchImpl=fetch){
  if(env?.MEMBER_INFO_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(env?.ROSTER_RETENTION_CONFIRMED!=="true")return {status:"retention-not-confirmed"};
  if(!captainConfigReady(env))return {status:"storage-unavailable"};
  if(!Number.isFinite(scheduledTime))return {status:"invalid-time"};
  const date=new Date(scheduledTime);
  const window=memberInfoWindow(scheduledTime);
  if(!window)return {status:"outside-window"};
  const {period,tick}=window;
  const campaign=date.toISOString().slice(0,10)+"-"+period;
  const stamp=date.toISOString().slice(0,16)+"Z";
  const slot={campaign,stamp};
  try{
    const approval=await readApproval(env);
    if(approval.status!=="configured"||!approval.alliances.length)
      return {status:"no-approved-alliances"};
    const alliances=approval.alliances.map(a=>a.fingerprint).sort();
    if(new Set(alliances).size!==alliances.length)return {status:"invalid-approvals"};
    const fp=alliances[tick%alliances.length];
    const result=await runMemberInfoTick(env,fp,slot,fetchImpl);
    // No IDs, names, member lists or tokens in observability.
    return {status:result.status,requests:result.requests||0,
      ...(result.total?{members:result.total}:{})};
  }catch{return {status:"unavailable"};}
}
