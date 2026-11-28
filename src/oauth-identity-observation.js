// Read-only OAuth identity telemetry. The JWT is never trusted or retained here.
// Verification stays disabled until a trusted issuer and signing-key source are
// confirmed independently of token contents.
const MAX_ID_TOKEN_LENGTH=20000;
const CANDIDATE_ALGORITHMS=new Set(["RS256","PS256","ES256"]);
const OBSERVATION_COOKIE="__Host-losp_oidc_observation";
const SESSION_COOKIE="__Host-losp_captain_session";
const SESSION_RX=/^[A-Za-z0-9_-]{43}$/;
const encoder=new TextEncoder();
const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const fromB64url=value=>Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")+
  "=".repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));

async function observationKey(env){
  const hex=env?.CAPTAIN_ENCRYPTION_KEY_HEX;
  if(typeof hex!=="string"||!(/^[a-fA-F0-9]{64}$/).test(hex))return null;
  const raw=Uint8Array.from(hex.match(/.{2}/g),byte=>parseInt(byte,16));
  const material=await crypto.subtle.importKey("raw",raw,"HKDF",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",
    salt:encoder.encode("LoSP OAuth observation cookie v1"),
    info:encoder.encode("diagnostics-only" )},material,
    {name:"HMAC",hash:"SHA-256",length:256},false,["sign","verify"]);
}

function decodePart(value){
  if(typeof value!=="string"||value.length>12000||!/^[A-Za-z0-9_-]+$/.test(value))return null;
  try{
    const base64=value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4);
    const binary=atob(base64);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,char=>char.charCodeAt(0))));
  }catch{return null;}
}

function result({received="no",format="not-applicable",algorithm=null,
  issuerPresent=false,subjectPresent=false,reason="id-token-not-returned"}={}){
  return {source:"oauth-response",idTokenReceived:received,format,
    identityAvailable:subjectPresent?"claims-present-unverified":"no",
    issuerPresent,subjectPresent,
    algorithm:typeof algorithm==="string"?algorithm.slice(0,32):null,
    algorithmCandidateAllowed:typeof algorithm==="string"&&CANDIDATE_ALGORITHMS.has(algorithm),
    signingKeys:"not-checked",cryptographicallyVerified:false,
    issuerAudienceTimeValid:false,stability:"not-verifiable",
    reason};
}

export function observeIdToken(token){
  if(token===undefined||token===null||token==="")return result();
  if(typeof token!=="string"||token.length>MAX_ID_TOKEN_LENGTH)
    return result({received:"yes",format:"malformed",reason:"id-token-format-invalid"});
  const parts=token.split(".");
  if(parts.length!==3||parts.some(part=>!part||part.length>12000||!/^[A-Za-z0-9_-]+$/.test(part)))
    return result({received:"yes",format:"malformed",reason:"id-token-format-invalid"});
  const header=decodePart(parts[0]),claims=decodePart(parts[1]);
  if(!header||!claims||typeof header!=="object"||Array.isArray(header)||
     typeof claims!=="object"||Array.isArray(claims))
    return result({received:"yes",format:"malformed",reason:"id-token-json-invalid"});
  const algorithm=typeof header.alg==="string"?header.alg:null;
  const issuerPresent=typeof claims.iss==="string"&&claims.iss.length>0;
  const subjectPresent=typeof claims.sub==="string"&&claims.sub.length>0;
  const reason=!algorithm||algorithm==="none"?"algorithm-not-acceptable":
    !CANDIDATE_ALGORITHMS.has(algorithm)?"algorithm-not-in-candidate-allowlist":
    !issuerPresent||!subjectPresent?"issuer-or-subject-claim-missing":
    "trusted-issuer-and-key-source-not-configured";
  return result({received:"yes",format:"jwt-shaped",algorithm,issuerPresent,
    subjectPresent,reason});
}

// Only fixed diagnostic fields may cross to the admin page. Claims and tokens
// never enter a response, a log, or storage.
export function safeOAuthObservation(observation){
  if(!observation||typeof observation!=="object")return null;
  return {
    source:observation.source==="refresh-response"?"refresh-response":"oauth-response",
    idTokenReceived:["yes","no"].includes(observation.idTokenReceived)?observation.idTokenReceived:"no",
    format:["jwt-shaped","malformed","not-applicable"].includes(observation.format)?observation.format:"malformed",
    identityAvailable:observation.identityAvailable==="claims-present-unverified"?"claims-present-unverified":"no",
    issuerPresent:observation.issuerPresent===true,
    subjectPresent:observation.subjectPresent===true,
    algorithm:typeof observation.algorithm==="string"?observation.algorithm.slice(0,32):null,
    algorithmCandidateAllowed:observation.algorithmCandidateAllowed===true,
    signingKeys:"not-checked",
    cryptographicallyVerified:false,
    issuerAudienceTimeValid:false,
    stability:"not-verifiable",
    reason:typeof observation.reason==="string"&&/^[a-z0-9-]{1,64}$/.test(observation.reason)
      ?observation.reason:"observation-invalid"
  };
}

async function sessionTag(key,sessionId){
  if(typeof sessionId!=="string"||!SESSION_RX.test(sessionId))return null;
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    encoder.encode("session-binding:"+sessionId))));
}

export async function attachOAuthObservationCookie(response,observation,env,sessionId){
  const safe=safeOAuthObservation(observation),key=await observationKey(env);
  const tag=key?await sessionTag(key,sessionId):null;
  if(!safe||!key||!tag)return response;
  const payload=b64url(encoder.encode(JSON.stringify({issuedAt:Date.now(),sessionTag:tag,observation:safe})));
  const signature=b64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(payload))));
  const headers=new Headers(response.headers);
  headers.append("Set-Cookie",OBSERVATION_COOKIE+"="+payload+"."+signature+
    "; Max-Age=900; Path=/; Secure; HttpOnly; SameSite=Strict");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export async function readOAuthObservationCookie(request,env){
  const values=(request.headers.get("Cookie")||"").split(";").map(value=>value.trim())
    .filter(value=>value.startsWith(OBSERVATION_COOKIE+"="))
    .map(value=>value.slice(OBSERVATION_COOKIE.length+1));
  if(values.length!==1||!/^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{40,64}$/.test(values[0]))return null;
  const [payload,signature]=values[0].split("."),key=await observationKey(env);
  if(!key)return null;
  try{
    const valid=await crypto.subtle.verify("HMAC",key,fromB64url(signature),encoder.encode(payload));
    if(!valid)return null;
    const decoded=JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    const sessionRows=(request.headers.get("Cookie")||"").split(";").map(value=>value.trim())
      .filter(value=>value.startsWith(SESSION_COOKIE+"="));
    if(sessionRows.length!==1)return null;
    const sessionId=sessionRows[0].slice(SESSION_COOKIE.length+1);
    const tag=await sessionTag(key,sessionId);
    if(!tag||tag!==decoded?.sessionTag)return null;
    if(!Number.isSafeInteger(decoded?.issuedAt)||Date.now()-decoded.issuedAt>900000||
       decoded.issuedAt>Date.now()+60000)return null;
    return safeOAuthObservation(decoded.observation);
  }catch{return null;}
}

export function clearOAuthObservationCookie(response){
  const headers=new Headers(response.headers);
  headers.append("Set-Cookie",OBSERVATION_COOKIE+"=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
