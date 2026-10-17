import {
  CAPTAIN_MAX_AGE, validCaptainKey, getCaptainRecord, putCaptainRecord,
  deleteCaptainRecord
} from "./captain-vault.js";

// One Durable Object per opaque R2 key. The queue serializes all mutations and
// single-use refresh token rotations, including the cron job vs. browser requests.
// The DO stores no tokens permanently; its state is held only in encrypted R2.
const TOKEN_URL="https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const REVOKE_URL="https://hydra-public.prod.m3.scopelypv.com/oauth2/revoke";
const SOON=15*60000;
function safeResponse(obj,status=200){
  return Response.json(obj,{status,headers:{"Cache-Control":"no-store"}});
}
function isToken(s){return typeof s==="string" && s.length>0 && s.length<=16384;}
function validExpiry(value){return Number.isInteger(value) && value>=60 && value<=30*86400;}
function basicAuth(env){
  const id=env.SCOPELY_CLIENT_ID, secret=env.SCOPELY_CLIENT_SECRET;
  if(typeof id!=="string" || !id || typeof secret!=="string" || !secret) throw Error("OAuth secrets missing");
  return "Basic "+btoa(String.fromCharCode(...new TextEncoder().encode(id+":"+secret)));
}
async function tokenPost(env,url,params,fetchImpl){
  const res=await fetchImpl(url,{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(12000),
    headers:{Authorization:basicAuth(env),
      "Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
    body:new URLSearchParams(params).toString()
  });
  if(res.status>=300 && res.status<400)return {error:"redirect"};
  let data=null;
  try {data=await res.json();}catch{}
  return {res,data};
}
export class CaptainRefreshCoordinator {
  constructor(ctx,env){ this.ctx=ctx;this.env=env;this.queue=Promise.resolve(); }
  async fetch(request,fetchImpl=fetch){
    // Durable Object stub is private to the Worker. The only externally exposed
    // entrypoints are the Worker’s cookie-authenticated /session and /logout.
    if(request.method!=="POST")return safeResponse({status:"forbidden"},405);
    let payload;
    try{payload=await request.json();}catch{return safeResponse({status:"invalid"},400);}
    if(!validCaptainKey(payload?.key))return safeResponse({status:"invalid"},400);
    // The queue survives asynchronous I/O interleaving, unlike a bare DO fetch.
    const operation=()=>this.dispatch(payload,fetchImpl);
    const current=this.queue.then(operation,operation);
    this.queue=current.then(()=>undefined,()=>undefined);
    try{return await current;}catch{return safeResponse({status:"unavailable"},503);}
  }
  async dispatch(payload,fetchImpl){
    const {CAPTAIN_BUCKET:bucket,CAPTAIN_ENCRYPTION_KEY_HEX:key}=this.env;
    if(!bucket?.get || !bucket?.put || !bucket?.delete ||
       !/^[a-fA-F0-9]{64}$/.test(key||"")) return safeResponse({status:"unavailable"},503);
    const now=Date.now();
    if(payload.action==="store"){
      const value=payload.record;
      if(!value || !isToken(value.accessToken) || !isToken(value.refreshToken) ||
        !validExpiry(value.expiresIn) || typeof value.scope!=="string" ||
        !value.scope.split(/\s+/).includes("offline") ||
        !value.scope.split(/\s+/).includes("m3p.f.ar.ros"))
        return safeResponse({status:"invalid"},400);
      if(await getCaptainRecord(bucket,key,payload.key,now))
        return safeResponse({status:"exists"},409);
      const record={version:2,createdAt:now,expiresAt:now+CAPTAIN_MAX_AGE,
        accessExpiresAt:now+value.expiresIn*1000,accessToken:value.accessToken,
        refreshToken:value.refreshToken,scope:value.scope};
      await putCaptainRecord(bucket,key,payload.key,record);
      return safeResponse({status:"stored"});
    }
    const record=await getCaptainRecord(bucket,key,payload.key,now);
    if(payload.action==="logout"){
      if(record)await deleteCaptainRecord(bucket,payload.key);
      // Revoke after local deletion. A failed provider request cannot restore access.
      if(record){
        try{await tokenPost(this.env,REVOKE_URL,{
          token:record.refreshToken,token_type_hint:"refresh_token"
        },fetchImpl);}catch{}
      }
      return safeResponse({status:"disconnected"});
    }
    if(payload.action!=="status" && payload.action!=="refresh")
      return safeResponse({status:"invalid"},400);
    if(!record)return safeResponse({status:"absent"});
    if(record.accessExpiresAt>now+SOON)
      return safeResponse({status:"active",accessExpiresAt:record.accessExpiresAt});
    try {
      const {res,data,error}=await tokenPost(this.env,TOKEN_URL,{
        grant_type:"refresh_token",refresh_token:record.refreshToken
      },fetchImpl);
      if(error || !res)return safeResponse({status:"retry-later"},503);
      if(!res.ok){
        if(data?.error==="invalid_grant"){
          await deleteCaptainRecord(bucket,payload.key);
          return safeResponse({status:"revoked"});
        }
        return safeResponse({status:"retry-later"},503);
      }
      if(!isToken(data?.access_token) || !isToken(data?.refresh_token) ||
        !validExpiry(data?.expires_in) || String(data?.token_type).toLowerCase()!=="bearer"){
        // Provider might have rotated away the prior single-use token.
        // Do not silently keep reporting an unusable authorization.
        await deleteCaptainRecord(bucket,payload.key);
        return safeResponse({status:"reconnect-required"});
      }
      const issuedScope=typeof data.scope==="string" ? data.scope : record.scope;
      const scopes=new Set(issuedScope.trim().split(/\s+/));
      if(!scopes.has("offline") || !scopes.has("m3p.f.ar.ros")){
        await deleteCaptainRecord(bucket,payload.key);
        return safeResponse({status:"reconnect-required"});
      }
      await putCaptainRecord(bucket,key,payload.key,{
        version:2,createdAt:now,expiresAt:now+CAPTAIN_MAX_AGE,
        accessExpiresAt:now+data.expires_in*1000,accessToken:data.access_token,
        refreshToken:data.refresh_token,scope:issuedScope
      });
      return safeResponse({status:"active",accessExpiresAt:now+data.expires_in*1000});
    }catch{
      return safeResponse({status:"retry-later"},503);
    }
  }
}
