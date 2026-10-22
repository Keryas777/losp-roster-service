// Optional private archive for /player families NOT handled by roster microbatches.
// One admin-initiated family/account at a time; no cron, no public data, no writes to MSF.
// Provider JSON envelopes are preserved without rewriting unknown fields.
import {CAPTAIN_PREFIX,captainConfigReady} from "./captain-vault.js";
import {tokenForKey} from "./admin-data-api.js";
import {API_KEY} from "./player-card.js";

export const PLAYER_EXTRA_FAMILIES=Object.freeze({
  "personal-squads": {path:"/player/v1/squads",scope:"m3p.f.pr.ros",kind:"object"},
  "personal-inventory": {path:"/player/v1/inventory",scope:"m3p.f.pr.inv",kind:"array"},
  "personal-wishlist": {path:"/player/v1/itemWishlist",scope:"m3p.f.pr.inv",kind:"array"},
  "personal-events": {path:"/player/v1/events",scope:"m3p.f.pr.act",kind:"array"},
  "shared-member-squads": {path:"/player/v1/squads/member/",scope:"m3p.f.ar.ros",kind:"array",shared:true,single:true}
});
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const ROOT="https://api.marvelstrikeforce.com";
const PREFIX="roster-batches/v1/player-extras/";
const SESSION=/^[a-f0-9]{64}$/;
const MEMBER=/^[A-Za-z0-9:_-]{1,256}$/;
const MAX_PAGES=8,PER_PAGE=100,MAX_BYTES=2_000_000;
const AGE_MS=7*86_400_000, COOLDOWN_MS=10*60_000;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const json=(v,status=200)=>Response.json(v,{status,headers:HEADERS});
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const options={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const hex=async value=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,"0")).join("");
const resourceKey=(session,resource,target)=>PREFIX+session+"/"+resource+"/"+target+"/";
const codeReason=status=>status===429?"rate-limited":status===403||status===464?
  "not-authorized":status===401?"expired-oauth":status===472?"too-large":
  status===404?"not-found":"provider-error";

async function providerGet(path,token,fetchImpl){
  try{
    const response=await fetchImpl(ROOT+path,{method:"GET",cache:"no-store",
      redirect:"manual",signal:AbortSignal.timeout(12000),headers:{
        "Authorization":"Bearer "+token,"x-api-key":API_KEY,
        "User-Agent":"APIClient/1.0 (Server)","Accept":"application/json"
      }});
    if(!response.ok)return {error:codeReason(response.status),httpStatus:response.status};
    if(Number(response.headers.get("content-length")||0)>MAX_BYTES)
      return {error:"too-large",httpStatus:response.status};
    const raw=await response.text();
    if(raw.length>MAX_BYTES)return {error:"too-large",httpStatus:response.status};
    const payload=JSON.parse(raw);
    return object(payload)&&Object.hasOwn(payload,"data")&&object(payload.meta)?
      {payload,httpStatus:response.status}:{error:"invalid-provider-response"};
  }catch{return {error:"provider-unavailable"};}
}
async function membership(token,member,fetchImpl){
  const result=await providerGet("/player/v1/alliance/members",token,fetchImpl);
  if(result.error)return {error:result.error};
  const list=result.payload.data;
  if(!Array.isArray(list)||list.length>100||
    list.filter(x=>x?.isSelf===true).length!==1 ||
    list.some(x=>!MEMBER.test(x?.id)||list.filter(y=>y?.id===x.id).length!==1))
    return {error:"invalid-membership"};
  const match=list.find(x=>x.id===member&&x.isSelf!==true);
  return match?.card?.rosterShare===true?{ok:true}:{error:"not-currently-shared"};
}
async function lock(env,fingerprint,holder,action){
  const binding=env?.ROSTER_BATCH_LOCK;
  if(!binding?.get||!binding?.idFromName)return "lock-unavailable";
  const stub=binding.get(binding.idFromName(fingerprint));
  try{
    const res=await stub.fetch(new Request("https://player-extras-lock.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,holder,fingerprint})
    }));
    return res.ok?(await res.json()).status:res.status===409?"busy":"lock-unavailable";
  }catch{return "lock-unavailable";}
}
async function recent(bucket,key,now){
  const obj=await bucket.get(key);
  if(!obj)return null;
  const value=JSON.parse(await obj.text());
  if(value?.version!==1||value.complete!==true||
    typeof value.capturedAt!=="string"||
    now-Date.parse(value.capturedAt)<0||
    now-Date.parse(value.capturedAt)>=AGE_MS)return null;
  return value;
}
async function purgeIfPresent(bucket,prefix){
  // A previously shared member can revoke sharing. Remove this feature's
  // snapshots on the next attempted access, not only its latest pointer.
  const listing=await bucket.list({prefix,limit:100});
  for(const obj of listing.objects||[])await bucket.delete(obj.key);
  // Never claim purged if provider revoked and pagination has leftovers.
  return listing.truncated!==true;
}
function pathFor(def,member,page){
  const base=def.path+(def.shared?encodeURIComponent(member):"");
  if(def.kind==="object"||def.single)return base;
  const params=new URLSearchParams({lang:"fr",page:String(page),perPage:String(PER_PAGE)});
  if(def.path==="/player/v1/events")params.set("eventInfo","full");
  return base+"?"+params.toString();
}
function validResponse(def,payload){
  return object(payload)&&object(payload.meta)&&
    (def.kind==="object"?object(payload.data)||Array.isArray(payload.data):
      Array.isArray(payload.data));
}

export async function handlePlayerExtraArchive(request,env,fetchImpl=fetch,now=Date.now()){
  if(!["GET","POST"].includes(request.method))return json({error:"method-not-allowed"},405);
  if(!captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK||
    !env?.CAPTAIN_BUCKET?.put||!env.CAPTAIN_BUCKET?.get)
    return json({error:"not-configured"},503);
  const url=new URL(request.url);
  if(url.origin!==ORIGIN)return json({error:"invalid-origin"},403);
  if(request.method==="GET"){
    const session=url.searchParams.get("session");
    if(!SESSION.test(session||"")||url.searchParams.size!==1)
      return json({error:"invalid-session"},400);
    try{
      const found={};
      for(const resource of Object.keys(PLAYER_EXTRA_FAMILIES).filter(id=>
        !PLAYER_EXTRA_FAMILIES[id].shared)){
        const base=resourceKey(session,resource,"self");
        const rec=await recent(env.CAPTAIN_BUCKET,base+"latest.json",now);
        const checks=rec&&env.CAPTAIN_BUCKET.head?
          await Promise.all(rec.pages.map(p=>env.CAPTAIN_BUCKET.head(p.key))):null;
        found[resource]=rec?{status:checks&&checks.some(x=>!x)?"missing-pages":
          "archived",capturedAt:rec.capturedAt,pages:rec.pages.length,
          entries:rec.total}: {status:"not-archived"};
      }
      const shared=await env.CAPTAIN_BUCKET.list({
        prefix:PREFIX+session+"/shared-member-squads/",limit:100});
      const sharedCount=(shared.objects||[]).filter(o=>
        o.key.endsWith("/latest.json")).length;
      return json({source:"private-r2-only",personal:found,
        sharedMemberSquads:{latestSnapshots:sharedCount,
          scanComplete:shared.truncated!==true},
        note:"No provider GET; status only, no player values"});
    }catch{return json({error:"archive-status-unavailable"},503);}
  }
  if(request.headers.get("Origin")!==ORIGIN||
    !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json") ||
    url.search)return json({error:"forbidden"},403);
  let body;
  try{
    const raw=await request.text();
    if(raw.length>450)return json({error:"invalid-request"},400);
    body=JSON.parse(raw);
    if(!object(body)||!SESSION.test(body.session)||
      !Object.hasOwn(PLAYER_EXTRA_FAMILIES,body.resource)||
      Object.keys(body).some(k=>!["session","resource","member"].includes(k)))
      return json({error:"invalid-request"},400);
  }catch{return json({error:"invalid-request"},400);}
  const def=PLAYER_EXTRA_FAMILIES[body.resource],member=body.member;
  if(def.shared?!MEMBER.test(member):
      (member!==undefined&&member!==null))
    return json({error:"invalid-target"},400);
  const target=def.shared?await hex(member):"self";
  const prefix=resourceKey(body.session,body.resource,target);
  const fingerprint=await hex(body.session+"|"+body.resource+"|"+target);
  const holder=crypto.randomUUID();
  const obtained=await lock(env,fingerprint,holder,"acquire");
  if(obtained!=="acquired")return json({error:obtained},409);
  try{
    const token=await tokenForKey(env,CAPTAIN_PREFIX+body.session);
    if(!token)return json({error:"session-unavailable"},503);
    if(def.shared){
      const before=await membership(token,member,fetchImpl);
      if(before.error){
        if(before.error==="not-currently-shared"){
          const purged=await purgeIfPresent(env.CAPTAIN_BUCKET,prefix);
          return json({error:before.error,purged},403);
        }
        return json({error:before.error},409);
      }
    }
    const previous=await recent(env.CAPTAIN_BUCKET,prefix+"latest.json",now);
    if(previous&&now-Date.parse(previous.capturedAt)<COOLDOWN_MS)
      return json({status:"recent-capture",resource:body.resource,
        capturedAt:previous.capturedAt,complete:true,pages:previous.pages.length,
        entries:previous.total});
    const runId=crypto.randomUUID(),capturedAt=new Date(now).toISOString();
    const pages=[],asOfs=new Set();
    let total=0,expected=null,complete=false;
    for(let page=1;page<=(def.kind==="object"||def.single?1:MAX_PAGES);page++){
      const path=pathFor(def,member,page),response=await providerGet(path,token,fetchImpl);
      if(response.error)return json({status:"incomplete",error:response.error,
        upstreamStatus:response.httpStatus||null,resource:body.resource,
        pagesSaved:pages.length},response.error==="rate-limited"?429:502);
      const payload=response.payload;
      if(!validResponse(def,payload))
        return json({error:"unexpected-response-shape",pagesSaved:pages.length},502);
      const meta=payload.meta;
      if(typeof meta.asOf==="string")asOfs.add(meta.asOf);
      if(asOfs.size>1)return json({error:"changed-during-pagination",pagesSaved:pages.length},409);
      const count=def.kind==="object"?1:payload.data.length;
      if(meta.page!==undefined&&def.kind==="array"&&meta.page!==page)
        return json({error:"inconsistent-page",pagesSaved:pages.length},409);
      if(meta.perTotal!==undefined){
        if(!Number.isSafeInteger(meta.perTotal)||meta.perTotal<0||
          (expected!==null&&meta.perTotal!==expected))
          return json({error:"inconsistent-total",pagesSaved:pages.length},409);
        expected=meta.perTotal;
      }
      const key=prefix+runId+"/page-"+page+".json";
      const source=JSON.stringify({version:1,resource:body.resource,scope:def.scope,
        capturedAt,expiresAt:new Date(now+AGE_MS).toISOString(),endpoint:path,
        httpStatus:response.httpStatus,providerResponse:payload});
      if(source.length>MAX_BYTES*1.2)
        return json({error:"snapshot-too-large",pagesSaved:pages.length},502);
      await env.CAPTAIN_BUCKET.put(key,source,options);
      pages.push({key,page,count});
      total+=count;
      if(def.kind==="object"||def.single||expected!==null&&total===expected||
        expected===null&&count<PER_PAGE){complete=true;break;}
      if(expected!==null&&total>expected||count===0)
        return json({error:"inconsistent-pagination",pagesSaved:pages.length},409);
    }
    if(def.shared){
      const after=await membership(token,member,fetchImpl);
      if(after.error){
        await purgeIfPresent(env.CAPTAIN_BUCKET,prefix);
        return json({error:"member-consent-changed",pagesSaved:0},409);
      }
    }
    if(!complete)return json({status:"incomplete",error:"page-budget",
      resource:body.resource,pagesSaved:pages.length,complete:false},409);
    const summary={version:1,complete:true,resource:body.resource,
      scope:def.scope,mode:def.shared?"shared-member":"oauth-personal",
      capturedAt,expiresAt:new Date(now+AGE_MS).toISOString(),
      total,pages,asOf:asOfs.size?[...asOfs][0]:null};
    // Publish latest ONLY after all verified pages were written.
    await env.CAPTAIN_BUCKET.put(prefix+runId+"/manifest.json",
      JSON.stringify(summary),options);
    await env.CAPTAIN_BUCKET.put(prefix+"latest.json",
      JSON.stringify(summary),options);
    return json({status:"archived",resource:body.resource,complete:true,
      capturedAt,pages:pages.length,entries:total,retention:"existing-7-days"});
  }catch{return json({error:"archive-unavailable"},503);}
  finally{await lock(env,fingerprint,holder,"release");}
}
