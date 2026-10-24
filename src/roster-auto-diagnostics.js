// Private, minimal R2 telemetry for each approved alliance's automated roster
// microbatch. Contains only a hashed alliance key and bounded status metadata.
// Never persist tokens, player names, roster contents or provider error bodies.
const FP=/^[a-f0-9]{64}$/;
const OUTCOME=/^[a-z][a-z0-9-]{0,64}$/;
const CAMPAIGN=/^\d{4}-\d{2}-\d{2}-(?:am|pm)$/;
export const ROSTER_ATTEMPT_PREFIX="roster-auto/v1/last-attempt/";
export const ROSTER_COOLDOWN_PREFIX="roster-auto/v1/cooldown/";
export function rosterAttemptKey(fp){
  if(!FP.test(fp))throw Error("Invalid approved alliance");
  return ROSTER_ATTEMPT_PREFIX+fp+".json";
}
export function rosterCooldownKey(fp){
  if(!FP.test(fp))throw Error("Invalid approved alliance");
  return ROSTER_COOLDOWN_PREFIX+fp+".json";
}
const validTime=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
export function rosterAttemptRecord(slot,outcome,httpStatus,requests,retryAt=null){
  if(!CAMPAIGN.test(slot?.campaign)||!validTime(slot?.stamp)||
     !OUTCOME.test(outcome)||
     !Number.isSafeInteger(httpStatus)||httpStatus<200||httpStatus>599||
     !Number.isSafeInteger(requests)||requests<0||requests>24)
    throw Error("Invalid automatic roster attempt status");
  return {version:1,campaign:slot.campaign,at:slot.stamp,
    outcome,httpStatus,requests,
    ...(validTime(retryAt)?{retryAt}:{})};
}
export function verifiedRosterAttempt(value,now){
  if(!value||value.version!==1||!CAMPAIGN.test(value.campaign)||
     !validTime(value.at)||Date.parse(value.at)>now||
     !OUTCOME.test(value.outcome)||
     !Number.isSafeInteger(value.httpStatus)||
     value.httpStatus<200||value.httpStatus>599||
     !Number.isSafeInteger(value.requests)||value.requests<0||
     value.requests>24||
     (value.retryAt!==undefined&&!validTime(value.retryAt)))
    return null;
  return {campaign:value.campaign,at:value.at,outcome:value.outcome,
    httpStatus:value.httpStatus,requests:value.requests,
    retryAt:value.retryAt||null};
}
