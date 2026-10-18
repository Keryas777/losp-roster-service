import {
  CAPTAIN_PREFIX,CAPTAIN_COOKIE_AGE,newCaptainSessionId,
  captainSessionKey,captainConfigReady,validCaptainKey
} from "./captain-vault.js";
import { collectAllianceRosterSample } from "./roster-collector.js";
import { renderLiveRosterViewer } from "./roster-viewer.js";
import { discoverAlliance, readAllianceCoverage } from "./alliance-coverage.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const COOKIE="__Host-losp_captain_session";
const COOKIE_RX=/^[A-Za-z0-9_-]{43}$/;
const attributes="; Path=/; Secure; HttpOnly; SameSite=Lax";
// Sliding cookie: refresh only after a verified, active session. Never extend
// cookies after revocation, invalid_grant or temporary refresh errors.
function renewBrowserCookie(response,id){
  const headers=new Headers(response.headers);
  headers.append("Set-Cookie",COOKIE+"="+id+"; Max-Age="+CAPTAIN_COOKIE_AGE+attributes);
  return new Response(response.body,{status:response.status,headers});
}
function response(data,status=200){
  return Response.json(data,{status,headers:{
    "Cache-Control":"no-store","Referrer-Policy":"no-referrer",
    "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"
  }});
}
function readCookie(request){
  const raw=request.headers.get("Cookie") || "";
  const matches=raw.split(";").map(s=>s.trim())
    .filter(s=>s.startsWith(COOKIE+"=")).map(s=>s.slice(COOKIE.length+1));
  return matches.length===1 && COOKIE_RX.test(matches[0]) ? matches[0] : null;
}
async function coordinate(env,key,action,record){
  if(!captainConfigReady(env) || !validCaptainKey(key))throw Error("Captain sessions disabled");
  const id=env.CAPTAIN_REFRESH_COORDINATOR.idFromName(key);
  const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(id);
  const result=await stub.fetch(new Request("https://captain-coordinator.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,key,...(record?{record}:{})})
  }));
  if(!result.ok)throw Error("Captain coordinator not available");
  return result.json();
}
export async function saveCaptainConsent(res,token,env,request){
  if(!captainConfigReady(env))throw Error("Captain storage not available");
  // Explicit new consent supersedes the old browser's grant. Revoke before
  // minting the replacement so old credentials cannot keep auto-renewing.
  const previous=readCookie(request);
  if(previous){
    const result=await coordinate(env,await captainSessionKey(previous),"logout");
    if(result.status!=="disconnected")throw Error("Old consent could not be revoked");
  }
  const id=newCaptainSessionId(),key=await captainSessionKey(id);
  const stored=await coordinate(env,key,"store",{
    accessToken:token.access_token,refreshToken:token.refresh_token,
    expiresIn:token.expires_in,scope:token.scope
  });
  if(stored.status!=="stored")throw Error("Captain grant was not persisted");
  const headers=new Headers(res.headers);
  headers.append("Set-Cookie",COOKIE+"="+id+"; Max-Age="+CAPTAIN_COOKIE_AGE+attributes);
  return new Response(res.body,{status:res.status,headers});
}
export async function handleCaptainSession(request,env){
  if(request.method!=="GET")return response({status:"method-not-allowed"},405);
  if(!captainConfigReady(env))return response({status:"not-configured"},503);
  const id=readCookie(request);
  if(!id)return response({status:"disconnected"});
  try{
    const s=await coordinate(env,await captainSessionKey(id),"status");
    const result=response({status:s.status==="active"?"connected":
      ["absent","revoked","reconnect-required"].includes(s.status)?"disconnected":"temporarily-unavailable"});
    return s.status==="active"?renewBrowserCookie(result,id):result;
  }catch{return response({status:"temporarily-unavailable"},503);}
}
export async function handleCaptainLogout(request,env){
  if(request.method!=="POST")return response({status:"method-not-allowed"},405);
  // SameSite=Lax is insufficient as sole CSRF defense.
  if(request.headers.get("Origin")!==ORIGIN) return response({status:"forbidden"},403);
  if(!captainConfigReady(env))return response({status:"not-configured"},503);
  const id=readCookie(request);
  if(id){
    try{
      const s=await coordinate(env,await captainSessionKey(id),"logout");
      if(s.status!=="disconnected")return response({status:"temporarily-unavailable"},503);
    }catch{return response({status:"temporarily-unavailable"},503);}
  }
  const acceptsHtml=(request.headers.get("Accept")||"").includes("text/html");
  const res=acceptsHtml
    ? new Response(null,{status:303,headers:{
        Location:ORIGIN+"/captain","Cache-Control":"no-store",
        "Referrer-Policy":"no-referrer"
      }})
    : response({status:"disconnected"});
  res.headers.append("Set-Cookie",COOKIE+"=; Max-Age=0"+attributes);
  return res;
}

export async function handleCaptainLanding(request,env){
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  if(!captainConfigReady(env))return response({status:"not-configured"},503);
  const status=await handleCaptainSession(request,env);
  let connected=false,temporary=false;
  if(status.ok){
    const body=await status.json();
    connected=body.status==="connected";
    temporary=body.status==="temporarily-unavailable";
  } else {
    temporary=true;
  }
  const html='<!doctype html><html lang="fr"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="referrer" content="no-referrer"><title>Connexion capitaine — LoSP</title>'+
    '<link rel="stylesheet" href="/style.css"></head><body><main>'+
    '<h1>Connexion du capitaine</h1>'+
    (connected?'<p>Autorisation Scopely maintenue automatiquement.</p>'+
      '<p><a href="/captain/rosters">Consulter les rosters partagés</a></p>'+
      '<p><a href="/captain/coverage">Vérifier la couverture de mon alliance</a></p>'+
      '<form method="post" action="/logout"><button type="submit">Révoquer ma connexion LoSP</button></form>':
      temporary ? '<p>Le renouvellement est temporairement indisponible. Votre autorisation n’a pas été supprimée.</p>'+
        '<p><a href="/captain">Réessayer plus tard</a></p>' :
        '<p>Aucune session active dans ce navigateur.</p>'+
        '<p><a href="/login/captain">Autoriser à nouveau LoSP</a></p>')+
    '<p>Aucun jeton OAuth n’est exposé au navigateur.</p></main></body></html>';
  const landing=new Response(html,{headers:{
    "Content-Type":"text/html; charset=utf-8",
    "Cache-Control":"no-store","Referrer-Policy":"no-referrer",
    "X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY",
    "Content-Security-Policy":"default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  }});
  // Forward only the verified session cookie, never OAuth or authorization data.
  if(connected && readCookie(request)){
    return renewBrowserCookie(landing,readCookie(request));
  }
  return landing;
}
export async function handleCaptainRosters(request,env,fetchImpl=fetch){
  if(request.method!=="GET")return response({status:"method-not-allowed"},405);
  if(!captainConfigReady(env))return response({status:"not-configured"},503);
  const id=readCookie(request);
  if(!id)return Response.redirect(ORIGIN+"/captain",303);
  try{
    const grant=await coordinate(env,await captainSessionKey(id),"access");
    if(grant.status!=="active" || typeof grant.accessToken!=="string"){
      return Response.redirect(ORIGIN+"/captain",303);
    }
    // Always read the CURRENT alliance from the account's own Scopely token.
    // Never reuse members or roster IDs from a former alliance.
    const report=await collectAllianceRosterSample(grant.accessToken,fetchImpl,{
      maxMembers:3,charInfo:true,requireCurrentMembership:true
    });
    if(report.status==="current-membership-unverified"){
      return response({status:"current-alliance-unverified"},403);
    }
    // Temporary Scopely failures must not present old data or force re-consent.
    const rendered=renderLiveRosterViewer(report);
    return renewBrowserCookie(rendered,id);
  }catch{return response({status:"temporarily-unavailable"},503);}
}
// Ephemeral, account-scoped diagnostic. Reads only the current alliance;
// never enumerates other captains or returns provider IDs, tokens or rosters.
export async function handleCaptainCoverage(request,env,fetchImpl=fetch){
  if(request.method!=="GET")return response({status:"method-not-allowed"},405);
  if(!captainConfigReady(env))return response({status:"not-configured"},503);
  const id=readCookie(request);
  if(!id)return Response.redirect(ORIGIN+"/captain",303);
  try{
    const access=await coordinate(env,await captainSessionKey(id),"access");
    if(access.status!=="active" || typeof access.accessToken!=="string"){
      if(["absent","revoked","reconnect-required"].includes(access.status))
        return Response.redirect(ORIGIN+"/captain",303);
      return response({status:"temporarily-unavailable"},503);
    }
    const card=await discoverAlliance(access.accessToken,fetchImpl);
    const coverage=card.ok
      ? await readAllianceCoverage(access.accessToken,fetchImpl)
      : {ok:false,status:"alliance-unavailable"};
    if(!card.ok || !coverage.ok)
      return response({status:"alliance-unavailable"},503);
    const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>
      ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
    const html='<!doctype html><html lang="fr"><head><meta charset="utf-8">'+
      '<meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<meta name="referrer" content="no-referrer">'+
      '<title>Couverture d\'alliance — LoSP</title>'+
      '<link rel="stylesheet" href="/style.css"></head><body><main>'+
      '<h1>Couverture de mon alliance</h1>'+
      '<h2>'+escapeHtml(card.name)+'</h2>'+
      '<p>Membres actuels : <strong>'+coverage.members+'</strong></p>'+
      '<p>Rosters partagés : <strong>'+coverage.shared+'</strong></p>'+
      '<p>Partage non activé : <strong>'+coverage.notShared+'</strong></p>'+
      '<p>Cette lecture est effectuée en direct depuis Scopely. '+
      'Aucun roster n\'est enregistré sur cette page.</p>'+
      '<p><a href="/captain">Retour à l\'espace capitaine</a></p>'+
      '</main></body></html>';
    const result=new Response(html,{headers:{
      "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",
      "Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
      "X-Robots-Tag":"noindex","X-Frame-Options":"DENY",
      "Content-Security-Policy":"default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }});
    return renewBrowserCookie(result,id);
  }catch{return response({status:"temporarily-unavailable"},503);}
}
export async function renewCaptainGrants(env){
  if(!captainConfigReady(env))return {status:"disabled",checked:0};
  let cursor,checked=0,failed=0,rotated=0,more=true;
  // Capped per run; refresh only the encrypted token material, never rosters.
  for(let page=0;page<8 && more;page++){
    const batch=await env.CAPTAIN_BUCKET.list({
      prefix:CAPTAIN_PREFIX,limit:100,...(cursor?{cursor}:{})
    });
    for(const item of batch.objects||[]){
      if(!validCaptainKey(item.key))continue;
      checked++;
      try{
        const s=await coordinate(env,item.key,"refresh");
        if(s.status==="retry-later")failed++;
        if(s.rotated===true && s.status==="active")rotated++;
      }catch{failed++;}
    }
    more=!!batch.truncated && !!batch.cursor;
    cursor=batch.cursor;
  }
  return {status:failed?"partial":"ok",checked,failed,rotated};
}
