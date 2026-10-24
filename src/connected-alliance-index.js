// Private, connection-driven alliance directory for the authenticated admin.
// Never stores OAuth tokens, member IDs, rosters or persistent player identities.
// Alliance approval for collection remains EXPLICIT and separate.
import {CAPTAIN_PREFIX,captainConfigReady,getCaptainRecord} from "./captain-vault.js";
import {discoverAlliance,listCaptainSessionKeys} from "./alliance-coverage.js";
import {readApproval} from "./roster-sync-preflight.js";

// Under the existing seven-day R2 lifecycle; expired entries are rebuilt
// from still-valid OAuth grants when Admin is opened.
export const CONNECTED_ALLIANCE_PREFIX="roster-batches/v1/connected-alliances/sessions/";
const HEX=/^[a-f0-9]{64}$/;
const CACHE_HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const response=(data,status=200)=>Response.json(data,{status,headers:CACHE_HEADERS});
const keyFor=key=>CONNECTED_ALLIANCE_PREFIX+key.slice(CAPTAIN_PREFIX.length);
const sha=async value=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,"0")).join("");

function valid(item){
  return item?.version===1&&HEX.test(item.fingerprint)&&
    typeof item.name==="string"&&item.name.trim().length>0&&
    item.name.length<=90&&typeof item.observedAt==="string"&&
    Number.isFinite(Date.parse(item.observedAt));
}

export async function saveConnectedAlliance(env,sessionKey,card){
  if(!sessionKey.startsWith(CAPTAIN_PREFIX)||
     !HEX.test(sessionKey.slice(CAPTAIN_PREFIX.length))||
     !card?.ok||typeof card.aid!=="string"||
     typeof card.name!=="string"||!card.name.trim())
    return false;
  const value={version:1,fingerprint:await sha(card.aid),
    name:card.name.trim().slice(0,90),observedAt:new Date().toISOString()};
  await env.CAPTAIN_BUCKET.put(keyFor(sessionKey),JSON.stringify(value),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
  return true;
}

// A successful OAuth grant is already saved before this runs.
// A temporary Scopely/R2 failure never revokes consent or fakes an alliance.
export async function registerConnectedAlliance(env,sessionKey,token,fetchImpl=fetch){
  try{
    const card=await discoverAlliance(token,fetchImpl);
    return await saveConnectedAlliance(env,sessionKey,card);
  }catch{return false;}
}

export async function removeConnectedAlliance(env,sessionKey){
  try{await env.CAPTAIN_BUCKET.delete(keyFor(sessionKey));}catch{}
}

async function readIndexed(bucket,key){
  const object=await bucket.get(keyFor(key));
  if(!object)return null;
  if(Number.isSafeInteger(object.size)&&object.size>1024)return null;
  try{
    const raw=await object.text();
    if(raw.length>1024)return null;
    const value=JSON.parse(raw);
    return valid(value)?value:null;
  }catch{return null;}
}
async function accessGrant(env,key){
  const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(
    env.CAPTAIN_REFRESH_COORDINATOR.idFromName(key));
  const result=await stub.fetch(new Request("https://captain-coordinator.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"access",key})
  }));
  if(!result.ok)return null;
  const data=await result.json();
  return data.status==="active"&&typeof data.accessToken==="string"?
    data.accessToken:null;
}

// R2-only for previously registered sessions. Older sessions are backfilled
// once by reading ONLY their current /player/v1/alliance/card with their grant.
// Thus Hadès appears without forcing a fresh OAuth login.
export async function listConnectedAlliances(env,fetchImpl=fetch,now=Date.now()){
  if(!captainConfigReady(env)||!env.CAPTAIN_BUCKET?.list)
    return {status:"storage-unavailable"};
  const bucket=env.CAPTAIN_BUCKET;
  const keys=await listCaptainSessionKeys(bucket);
  const groups=new Map();
  let unresolved=0,connected=0;
  // Bound Scopely concurrency, never cap the number of OAuth sessions.
  let cursor=0;
  const worker=async()=>{
    while(cursor<keys.length){
      const key=keys[cursor++];
      try{
        const active=await getCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,key,now);
        if(!active)continue; // revoked/expired: no directory entry
        connected++;
        let item=await readIndexed(bucket,key);
        if(!item){
          const token=await accessGrant(env,key).catch(()=>null);
          if(token){
            await registerConnectedAlliance(env,key,token,fetchImpl);
            item=await readIndexed(bucket,key);
          }
        }
        if(!item){unresolved++;continue;}
        const existing=groups.get(item.fingerprint);
        if(existing){
          existing.captainConnections++;
          if(Date.parse(item.observedAt)>Date.parse(existing.observedAt)){
            existing.observedAt=item.observedAt;
            existing.name=item.name;
          }
        }else groups.set(item.fingerprint,{fingerprint:item.fingerprint,
          name:item.name,observedAt:item.observedAt,captainConnections:1});
      }catch{unresolved++;}
    }
  };
  await Promise.all(Array.from({length:Math.min(3,keys.length)},worker));
  const registry=await readApproval(env);
  const approved=new Set(registry.alliances.map(x=>x.fingerprint));
  const alliances=[...groups.values()].map(a=>({
    ...a,approved:approved.has(a.fingerprint)
  })).sort((a,b)=>a.name.localeCompare(b.name,"fr"));
  return {status:"ok",source:"private-r2-captain-consent",
    connectedSessions:connected,unresolvedSessions:unresolved,
    registryStatus:registry.status,alliances,
    complete:unresolved===0};
}
export async function handleConnectedAlliances(request,env,fetchImpl=fetch){
  if(request.method!=="GET")return response({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return response({error:"invalid-query"},400);
  try{
    const data=await listConnectedAlliances(env,fetchImpl);
    return response(data,data.status==="ok"?200:503);
  }catch{return response({status:"unavailable"},503);}
}
