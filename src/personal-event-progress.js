// On-demand personal event progression. No scheduled work and no public archive.
import {captainConfigReady} from "./captain-vault.js";
import {captainSessionKey} from "./captain-vault.js";
import {API_KEY} from "./player-card.js";

const ROOT="https://api.marvelstrikeforce.com";
const COOKIE="__Host-losp_captain_session";
const COOKIE_RX=/^[A-Za-z0-9_-]{43}$/;
const EVENT_SCOPE="m3p.f.pr.act";
const MAX_PAGES=8, PER_PAGE=100, MAX_BYTES=2_000_000, CACHE_MS=300_000;
const HEADERS={"Cache-Control":"private, no-store, max-age=0",
  "CDN-Cache-Control":"no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
  "Vary":"Cookie"};
const json=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const scopes=value=>typeof value==="string"?new Set(value.trim().split(/\s+/)):new Set();

function cookieId(request){
  const rows=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim())
    .filter(x=>x.startsWith(COOKIE+"="));
  if(rows.length!==1)return null;
  const value=rows[0].slice(COOKIE.length+1);
  return COOKIE_RX.test(value)?value:null;
}

async function coordinate(env,key){
  const binding=env?.CAPTAIN_REFRESH_COORDINATOR;
  if(!binding?.idFromName||!binding?.get)return {status:"unavailable"};
  const stub=binding.get(binding.idFromName(key));
  try{
    const response=await stub.fetch(new Request("https://captain-coordinator.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"access",key})
    }));
    return response.ok?response.json():{status:"unavailable"};
  }catch{return {status:"unavailable"};}
}

export async function getPersonalEventGrant(request,env,requiredScope=EVENT_SCOPE){
  if(!captainConfigReady(env))return {error:"not-configured",status:503};
  const id=cookieId(request);
  if(!id)return {error:"not-connected",status:401};
  let grant;
  try{grant=await coordinate(env,await captainSessionKey(id));}
  catch{return {error:"authorization-unavailable",status:503};}
  if(grant.status!=="active"||typeof grant.accessToken!=="string")
    return {error:grant.status==="revoked"||grant.status==="absent"?"consent-revoked":"authorization-unavailable",
      status:grant.status==="revoked"||grant.status==="absent"?401:503};
  if(requiredScope&&!scopes(grant.scope).has(requiredScope))
    return {error:"scope-insufficient",requiredScope,status:403};
  return {accessToken:grant.accessToken,scope:grant.scope};
}

export function numericProgressFacts(event){
  const facts=[];
  const kind=event?.milestone?.isGlobal===true||event?.milestone?.type==="global"?"global":
    event?.milestone?.type==="alliance"?"collective":
    event?.milestone?.type==="solo"?"individual":"unknown";
  const brackets=event?.milestone?.brackets;
  if(Array.isArray(brackets))brackets.forEach((bracket,index)=>{
    const value=bracket?.objective?.progress;
    facts.push({kind:"objective-progress",scope:kind,bracketId:bracket?.id??null,
      path:`milestone.brackets[${index}].objective.progress`,
      value:typeof value==="number"&&Number.isFinite(value)?value:null,
      state:typeof value==="number"&&Number.isFinite(value)?"available":"unknown"});
  });
  const capped=event?.milestone?.scoring?.cappedScorings;
  if(Array.isArray(capped))capped.forEach((row,index)=>{
    const value=row?.soFar;
    facts.push({kind:"capped-scoring",scope:kind,index,
      path:`milestone.scoring.cappedScorings[${index}].soFar`,
      cap:typeof row?.cap==="number"&&Number.isFinite(row.cap)?row.cap:null,
      value:typeof value==="number"&&Number.isFinite(value)?value:null,
      state:typeof value==="number"&&Number.isFinite(value)?"available":"unknown"});
  });
  return facts;
}

function validateProvider(payload,page){
  if(!isObject(payload)||!isObject(payload.meta)||!Array.isArray(payload.data))
    return "invalid-provider-response";
  if(payload.meta.page!==undefined&&payload.meta.page!==page)return "inconsistent-page";
  if(payload.meta.perTotal!==undefined&&(!Number.isSafeInteger(payload.meta.perTotal)||payload.meta.perTotal<0))
    return "invalid-total";
  return null;
}

async function fetchEvents(token,fetchImpl=fetch,eventId=null){
  const events=[],calls=[];
  let expected=null,asOf=null;
  for(let page=1;page<=(eventId?1:MAX_PAGES);page++){
    const params=new URLSearchParams({lang:"fr",objRewards:"full"});
    if(!eventId){params.set("page",String(page));params.set("perPage",String(PER_PAGE));params.set("eventInfo","full");}
    const endpoint=eventId?"/player/v1/events/"+encodeURIComponent(eventId)+"?"+params.toString():
      "/player/v1/events?"+params.toString();
    let response;
    try{
      response=await fetchImpl(ROOT+endpoint,{method:"GET",cache:"no-store",redirect:"manual",
        signal:AbortSignal.timeout(12000),headers:{Authorization:"Bearer "+token,
          "x-api-key":API_KEY,"User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"}});
    }catch{return {error:"provider-unavailable",calls:calls.length};}
    calls.push({endpoint,status:response.status});
    if(!response.ok)return {error:response.status===429?"rate-limited":
      response.status===401?"expired-oauth":response.status===403||response.status===464?
      "scope-or-access-denied":"provider-error",upstreamStatus:response.status,calls:calls.length};
    if(Number(response.headers.get("content-length")||0)>MAX_BYTES)
      return {error:"response-too-large",upstreamStatus:response.status,calls:calls.length};
    let payload,raw;
    try{raw=await response.text();if(raw.length>MAX_BYTES)return {error:"response-too-large",upstreamStatus:response.status,calls:calls.length};payload=JSON.parse(raw);}
    catch{return {error:"invalid-provider-response",upstreamStatus:response.status,calls:calls.length};}
    const detailData=eventId&&isObject(payload)&&isObject(payload.meta)&&isObject(payload.data);
    const invalid=detailData?null:validateProvider(payload,page);
    if(invalid)return {error:invalid,upstreamStatus:response.status,calls:calls.length};
    if(payload.meta.perTotal!==undefined){
      if(expected!==null&&expected!==payload.meta.perTotal)
        return {error:"inconsistent-total",upstreamStatus:response.status,calls:calls.length};
      expected=payload.meta.perTotal;
    }
    if(payload.meta.asOf!==undefined){
      if(typeof payload.meta.asOf!=="string"||(asOf!==null&&asOf!==payload.meta.asOf))
        return {error:"changed-during-pagination",upstreamStatus:response.status,calls:calls.length};
      asOf=payload.meta.asOf;
    }
    if(eventId){events.push(payload.data);return {events,calls,asOf};}
    events.push(...payload.data);
    if(expected!==null&&events.length>expected)
      return {error:"inconsistent-total",upstreamStatus:response.status,calls:calls.length};
    if((expected!==null&&events.length===expected)||(expected===null&&payload.data.length<PER_PAGE))
      return {events,calls,asOf};
    if(payload.data.length===0)return {error:"incomplete-pagination",upstreamStatus:response.status,calls:calls.length};
  }
  return {error:"page-budget-exceeded",calls:calls.length};
}

// Cookie session is checked and its current grant refreshed before each cache
// read. The private DO stores only the response for at most five minutes.
export async function handlePersonalEventProgress(request,env,fetchImpl=fetch,now=Date.now()){
  if(request.method!=="GET")return json({error:"method-not-allowed"},405);
  if(!captainConfigReady(env)||!env?.PERSONAL_EVENT_CACHE?.idFromName||!env?.PERSONAL_EVENT_CACHE?.get)
    return json({error:"not-configured"},503);
  const url=new URL(request.url);
  if(url.origin!=="https://losp-roster-service.deliriousfan7.workers.dev"||
      request.headers.get("Origin")&&request.headers.get("Origin")!=="https://losp-roster-service.deliriousfan7.workers.dev")
    return json({error:"forbidden"},403);
  const force=url.searchParams.get("refresh")==="1";
  const eventId=url.searchParams.get("eventId");
  if([...url.searchParams.keys()].some(k=>!(["refresh","eventId"].includes(k)))||
    url.searchParams.size>(Number(force)+Number(eventId!==null))||
    eventId!==null&&!/^[A-Za-z0-9_-]{1,128}$/.test(eventId))
    return json({error:"invalid-request"},400);
  const grant=await getPersonalEventGrant(request,env,EVENT_SCOPE);
  if(grant.error)return json({error:grant.error,...(grant.requiredScope?{requiredScope:grant.requiredScope}:{})},grant.status);
  const key=await captainSessionKey(cookieId(request));
  try{
    const stub=env.PERSONAL_EVENT_CACHE.get(env.PERSONAL_EVENT_CACHE.idFromName(key));
    const internal=await stub.fetch(new Request("https://personal-event-cache.internal/progress",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:grant.accessToken,refresh:force,requestedAt:now,
        ...(eventId?{eventId}:{}),
        fetchUrl:ROOT,eventScope:EVENT_SCOPE})
    }));
    const payload=await internal.json();
    return json(payload,internal.status);
  }catch{return json({error:"service-unavailable"},503);}
}

export class PersonalEventProgressCache {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.inflight=new Map();}
  async fetch(request,fetchImpl=fetch){
    if(request.method!=="POST"||new URL(request.url).pathname!=="/progress")
      return json({error:"not-found"},404);
    let input;
    try{input=await request.json();}catch{return json({error:"invalid-request"},400);}
    if(!isObject(input)||typeof input.token!=="string"||!input.token||
      input.eventScope!==EVENT_SCOPE||typeof input.refresh!=="boolean"||
      input.eventId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId))
      return json({error:"invalid-request"},400);
    const slot="progress:"+(input.eventId||"list");
    if(this.inflight.has(slot))return (await this.inflight.get(slot)).clone();
    const task=this.load(input,fetchImpl,slot);
    this.inflight.set(slot,task);
    try{return (await task).clone();}finally{this.inflight.delete(slot);}
  }
  async load(input,fetchImpl,slot){
    const now=Number.isSafeInteger(input.requestedAt)?input.requestedAt:Date.now();
    let cached=null;
    try{cached=await this.ctx.storage.get(slot);}catch{return json({error:"cache-unavailable"},503);}
    if(cached&&Number.isSafeInteger(cached.expiresAt)&&cached.expiresAt>now&&!input.refresh){
      return json({...cached.response,cache:{hit:true,expiresAt:new Date(cached.expiresAt).toISOString()}});
    }
    if(input.refresh){
      let last=0;try{last=(await this.ctx.storage.get("lastManualRefresh"))||0;}catch{}
      if(now-last<10_000)return json({error:"refresh-too-soon",retryAfterSeconds:Math.ceil((10_000-(now-last))/1000)},429);
      try{await this.ctx.storage.put("lastManualRefresh",now);}catch{return json({error:"cache-unavailable"},503);}
    }
    const result=await fetchEvents(input.token,fetchImpl,input.eventId||null);
    if(result.error)return json({error:result.error,upstreamStatus:result.upstreamStatus||null,
      calls:result.calls||0,cache:{hit:false}} ,result.error==="rate-limited"?429:502);
    const retrievedAt=new Date(now).toISOString(),expiresAt=now+CACHE_MS;
    const response={status:"ok",schemaVersion:1,source:"scopely-player-events",
      retrievedAt,cache:{hit:false,expiresAt:new Date(expiresAt).toISOString()},
      upstream:{endpoint:input.eventId?"/player/v1/events/{eventId}":"/player/v1/events",
        calls:result.calls.length,pages:result.calls.length,
        asOf:result.asOf??null},
      ...(input.eventId?{eventId:input.eventId}:{}),
      events:result.events.map(event=>({...event,
        progressFacts:numericProgressFacts(event)}))};
    try{
      await this.ctx.storage.put(slot,{expiresAt,response});
      await this.scheduleCleanup();
    }catch{return json({error:"cache-write-failed",calls:result.calls.length},503);}
    return json(response);
  }
  async scheduleCleanup(){
    const entries=await this.ctx.storage.list({prefix:"progress:"});
    const next=[...entries.values()].map(row=>row?.expiresAt)
      .filter(value=>Number.isSafeInteger(value)&&value>Date.now()).sort((a,b)=>a-b)[0];
    if(next)await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm(){
    const now=Date.now(),entries=await this.ctx.storage.list({prefix:"progress:"});
    for(const [key,row] of entries){
      if(!Number.isSafeInteger(row?.expiresAt)||row.expiresAt<=now)
        await this.ctx.storage.delete(key);
    }
    await this.scheduleCleanup();
  }
}
