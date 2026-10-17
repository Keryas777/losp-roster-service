// Cloudflare Access is REQUIRED for global exploration. Browser cookies from
// Scopely are NOT administrator credentials. Never authorize on unverified headers.
// Diagnostic statuses never contain names, tokens, claim values or environment secrets.
const decoder=new TextDecoder();
const bytes=(s)=>{if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error("invalid base64");
  return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
};
const parsed=(s)=>JSON.parse(decoder.decode(bytes(s)));
const validDomain=(s)=>typeof s==="string"&&/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(s);
export function adminReady(env){
  return env?.MSF_ADMIN_ENABLED==="true"&&
    validDomain(env.CF_ACCESS_TEAM_DOMAIN)&&
    typeof env.CF_ACCESS_AUD==="string"&&/^[a-f0-9]{32,64}$/i.test(env.CF_ACCESS_AUD)&&
    typeof env.MSF_ADMIN_EMAILS==="string"&&env.MSF_ADMIN_EMAILS.trim().length>2;
}
let jwksCache={domain:"",until:0,keys:[]};
function getAccessToken(request){
  // Access commonly forwards this header. Some browser flows also supply
  // the same signed token through its official cookie.
  const headerToken=request.headers.get("Cf-Access-Jwt-Assertion");
  if(headerToken)return headerToken;
  const raw=request.headers.get("Cookie")||"";
  const cookies=raw.split(";").map(s=>s.trim()).filter(s=>s.startsWith("CF_Authorization="));
  return cookies.length===1?cookies[0].slice("CF_Authorization=".length):null;
}
export async function diagnoseAdminAuth(request,env,fetchImpl=fetch,now=Date.now()){
  if(!adminReady(env))return "config-invalid";
  const jwt=getAccessToken(request);
  if(!jwt)return "jwt-missing";
  if(jwt.length>10000)return "jwt-malformed";
  const parts=jwt.split(".");
  if(parts.length!==3)return "jwt-malformed";
  const nowSec=Math.floor(now/1000);
  let header,claims;
  try{
    header=parsed(parts[0]);
    claims=parsed(parts[1]);
  }catch{return "jwt-malformed";}
  if(header?.alg!=="RS256"||typeof header.kid!=="string"||!header.kid)
    return "jwt-header-invalid";
  if(typeof claims?.exp!=="number"||typeof claims.iat!=="number"||
     claims.exp<=nowSec||claims.iat>nowSec+60||
     typeof claims.nbf==="number"&&claims.nbf>nowSec)return "jwt-time-invalid";
  if(claims.iss!=="https://"+env.CF_ACCESS_TEAM_DOMAIN)return "jwt-issuer-mismatch";
  if(!Array.isArray(claims.aud)||!claims.aud.includes(env.CF_ACCESS_AUD))
    return "jwt-audience-mismatch";
  if(typeof claims.email!=="string")return "jwt-email-missing";
  const allowed=env.MSF_ADMIN_EMAILS.split(",").map(e=>e.trim().toLowerCase()).filter(Boolean);
  if(!allowed.includes(claims.email.trim().toLowerCase()))return "jwt-email-not-allowed";
  if(jwksCache.domain!==env.CF_ACCESS_TEAM_DOMAIN||jwksCache.until<=now){
    let jwks;
    try{
      const res=await fetchImpl("https://"+env.CF_ACCESS_TEAM_DOMAIN+"/cdn-cgi/access/certs",{
        method:"GET",signal:AbortSignal.timeout(7000),redirect:"error"
      });
      if(!res.ok)return "jwks-unavailable";
      jwks=await res.json();
    }catch{return "jwks-unavailable";}
    if(!Array.isArray(jwks?.keys)||jwks.keys.length>20)
      return "jwks-invalid";
    jwksCache={domain:env.CF_ACCESS_TEAM_DOMAIN,keys:jwks.keys,until:now+300000};
  }
  const jwk=jwksCache.keys.find(k=>k.kid===header.kid&&k.kty==="RSA"&&k.alg==="RS256");
  if(!jwk)return "jwks-key-not-found";
  try{
    const key=await crypto.subtle.importKey("jwk",jwk,{
      name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"
    },false,["verify"]);
    const valid=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,bytes(parts[2]),
      new TextEncoder().encode(parts[0]+"."+parts[1]));
    return valid?"ok":"jwt-signature-invalid";
  }catch{return "jwt-verification-error";}
}
export async function authenticateAdmin(request,env,fetchImpl=fetch,now=Date.now()){
  return (await diagnoseAdminAuth(request,env,fetchImpl,now))==="ok";
}
