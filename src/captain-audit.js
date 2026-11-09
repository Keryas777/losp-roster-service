// Private, append-only metadata journal. Never write OAuth credentials, names,
// cookies, scopes, provider payloads or raw exceptions.
export const AUDIT_PREFIX="oauth-audit/v1/";
const EVENTS=new Set(["created","renewed","revoked","failed","deleted"]);
const REASONS=new Set(["stored","refresh","invalid-grant","invalid-response","missing-scope","logout","replaced","provider-error","storage-error","revoke-error"]);
export async function auditCaptainEvent(env,sessionKey,event,reason=""){
  if(!env?.CAPTAIN_BUCKET?.put ||
    !/^oauth-captains\/v1\/[a-f0-9]{64}$/.test(sessionKey) ||
    !EVENTS.has(event) || (reason && !REASONS.has(reason)))return false;
  const now=Date.now();
  const nonce=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,"0")).join("");
  const key=AUDIT_PREFIX+new Date(now).toISOString().slice(0,10)+"/"+now+"-"+nonce+".json";
  try{
    await env.CAPTAIN_BUCKET.put(key,JSON.stringify({version:1,at:new Date(now).toISOString(),sessionKey,event,reason}));
    return true;
  }catch{return false;} // Audit must never revoke or block an already persisted consent.
}
