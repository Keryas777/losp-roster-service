// Cloudflare Access is REQUIRED for global exploration. Browser cookies from
// Scopely are NOT administrator credentials. Never authorize on unverified headers.
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
export async function authenticateAdmin(request,env,fetchImpl=fetch,now=Date.now()){
  if(!adminReady(env))return false;
  // Access normally forwards its JWT in this header. Some browser flows
  // deliver the same signed JWT through CF_Authorization instead.
  // A cookie alone is NEVER sufficient: all existing JWT checks still apply.
  const headerToken=request.headers.get("Cf-Access-Jwt-Assertion");
  let cookieToken=null;
  if(!headerToken){
    const raw=request.headers.get("Cookie")||"";
    const cookies=raw.split(";").map(s=>s.trim()).filter(s=>s.startsWith("CF_Authorization="));
    if(cookies.length===1)cookieToken=cookies[0].slice("CF_Authorization=".length);
  }
  const jwt=headerToken||cookieToken;
  if(!jwt||jwt.length>10000)return false;
  const parts=jwt.split(".");
  if(parts.length!==3)return false;
  try{
    const header=parsed(parts[0]),claims=parsed(parts[1]);
    if(header.alg!=="RS256" ||typeof header.kid!=="string"||!header.kid||
       typeof claims.exp!=="number"||typeof claims.iat!=="number"||
       typeof claims.nbf==="number"&&claims.nbf>Math.floor(now/1000)||
       claims.iat>Math.floor(now/1000)+60 || claims.exp<=Math.floor(now/1000)||
       claims.iss!=="https://"+env.CF_ACCESS_TEAM_DOMAIN||
       !Array.isArray(claims.aud)||!claims.aud.includes(env.CF_ACCESS_AUD)||
       typeof claims.email!=="string") return false;
    const allowed=env.MSF_ADMIN_EMAILS.split(",").map(e=>e.trim().toLowerCase()).filter(Boolean);
    if(!allowed.includes(claims.email.trim().toLowerCase()))return false;
    if(jwksCache.domain!==env.CF_ACCESS_TEAM_DOMAIN||jwksCache.until<=now){
      const res=await fetchImpl("https://"+env.CF_ACCESS_TEAM_DOMAIN+"/cdn-cgi/access/certs",{
        method:"GET",signal:AbortSignal.timeout(7000),redirect:"error"
      });
      if(!res.ok)return false;
      const jwks=await res.json();
      if(!Array.isArray(jwks.keys)||jwks.keys.length>20)return false;
      jwksCache={domain:env.CF_ACCESS_TEAM_DOMAIN,keys:jwks.keys,until:now+300000};
    }
    const jwk=jwksCache.keys.find(k=>k.kid===header.kid&&k.kty==="RSA"&&k.alg==="RS256");
    if(!jwk)return false;
    const key=await crypto.subtle.importKey("jwk",jwk,{
      name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"
    },false,["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,bytes(parts[2]),
      new TextEncoder().encode(parts[0]+"."+parts[1]));
  }catch{return false;}
}
