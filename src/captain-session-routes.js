import {
  CAPTAIN_PREFIX,CAPTAIN_COOKIE_AGE,newCaptainSessionId,
  captainSessionKey,captainConfigReady,validCaptainKey
} from "./captain-vault.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const COOKIE="__Host-losp_captain_session";
const COOKIE_RX=/^[A-Za-z0-9_-]{43}$/;
const attributes="; Path=/; Secure; HttpOnly; SameSite=Lax";
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
export async function saveCaptainConsent(res,token,env){
  if(!captainConfigReady(env))throw Error("Captain storage not available");
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
    return response({status:s.status==="active"?"connected":
      ["absent","revoked","reconnect-required"].includes(s.status)?"disconnected":"temporarily-unavailable"});
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
  const res=response({status:"disconnected"});
  res.headers.append("Set-Cookie",COOKIE+"=; Max-Age=0"+attributes);
  return res;
}
export async function renewCaptainGrants(env){
  if(!captainConfigReady(env))return {status:"disabled",checked:0};
  let cursor,checked=0,failed=0,more=true;
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
      }catch{failed++;}
    }
    more=!!batch.truncated && !!batch.cursor;
    cursor=batch.cursor;
  }
  return {status:failed?"partial":"ok",checked,failed};
}
