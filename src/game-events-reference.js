// Level-110 Command Center reference, explicitly selected by an admin.
// Only official event IDs derived from the authorized account may be public.
// No personal goals, progression, names, tokens, or raw /player payloads leave
// this module. Reuses the existing daily event Cron and R2 bucket.
import {CAPTAIN_PREFIX,getCaptainRecord} from "./captain-vault.js";
import {tokenForKey} from "./admin-data-api.js";
import {API_KEY} from "./player-card.js";
import {EVENTS_DIRTY_KEY} from "./game-events-daily-keys.js";

export const EVENT_REFERENCE_CONFIG_KEY="roster-batches/v1/events-reference/config.json";
const SID=/^[a-f0-9]{64}$/;
const ID=/^[a-f0-9]{24}$/;
const API="https://api.marvelstrikeforce.com";
const PER_PAGE=100,MAX_PAGES=8,MAX_BYTES=2_000_000;
const options={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const iso=now=>new Date(now).toISOString();
const read=async(bucket,key)=>{
  const object=await bucket.get(key);
  if(!object)return null;
  if(Number.isFinite(object.size)&&object.size>1500)throw Error("reference-config-oversized");
  return JSON.parse(await object.text());
};
const name=value=>String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[’‘]/g,"'").toLocaleLowerCase("fr").trim();
const live=(event,now)=>Number.isSafeInteger(event?.startTime)&&
  Number.isSafeInteger(event?.endTime)&&
  event.startTime*1000<=now&&event.endTime*1000>now;
const hints=(event,hint)=>Array.isArray(event?.locationHints)&&
  event.locationHints.includes(hint);
const pageCount=page=>{
  const n=page?.meta?.perTotal;
  if(!Number.isSafeInteger(n)||n<1||n>PER_PAGE*MAX_PAGES)
    throw Error("reference-invalid-total");
  return Math.ceil(n/PER_PAGE);
};
async function providerPage(token,page,fetchImpl){
  const query=new URLSearchParams({lang:"fr",page:String(page),
    perPage:String(PER_PAGE),eventInfo:"full"});
  const response=await fetchImpl(API+"/player/v1/events?"+query,{
    method:"GET",cache:"no-store",redirect:"manual",
    signal:AbortSignal.timeout(15000),headers:{
      Authorization:"Bearer "+token,"x-api-key":API_KEY,
      "User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"
    }
  });
  if(!response.ok)throw Error(response.status===429?
    "reference-provider-rate-limited":"reference-provider-unavailable");
  if(Number(response.headers.get("content-length")||0)>MAX_BYTES)
    throw Error("reference-page-too-large");
  const body=await response.text();
  if(new TextEncoder().encode(body).byteLength>MAX_BYTES)
    throw Error("reference-page-too-large");
  const value=JSON.parse(body);
  if(!Array.isArray(value?.data)||!value.meta)
    throw Error("reference-invalid-page");
  return value;
}
async function collectPersonalEvents(token,fetchImpl){
  const first=await providerPage(token,1,fetchImpl);
  const total=first.meta.perTotal,count=pageCount(first),events=[];
  for(let n=1;n<=count;n++){
    const page=n===1?first:await providerPage(token,n,fetchImpl);
    if(page.meta.page!==n||page.meta.perPage!==PER_PAGE||
      page.meta.perTotal!==total||page.data.length!==
        Math.min(PER_PAGE,total-(n-1)*PER_PAGE))
      throw Error("reference-incomplete-pagination");
    events.push(...page.data);
  }
  if(new Set(events.map(e=>e?.id)).size!==total||
    events.some(e=>!ID.test(e?.id||"")))
    throw Error("reference-duplicate-or-invalid-ids");
  return events;
}

export async function readEventReferenceConfig(bucket){
  const value=await read(bucket,EVENT_REFERENCE_CONFIG_KEY);
  if(value===null)return null;
  if(value.version!==1||!SID.test(value.session||"")||
    value.bracket!=="85_and_up"||
    !Number.isFinite(Date.parse(value.approvedAt||"")))
    throw Error("reference-invalid-config");
  return value;
}
export function selectLevel110Events(catalog,personal,now=Date.now()){
  if(!Array.isArray(catalog?.events)||!Array.isArray(personal))
    throw Error("reference-invalid-input");
  const publicById=new Map(catalog.events.map(e=>[e.id,e]));
  const selected=new Set(personal.filter(e=>live(e,now)).map(e=>e.id));
  const wrappers=personal.filter(e=>live(e,now)&&
    hints(e,"lohub_wrapper")&&publicById.has(e.id)&&
    e.milestone?.brackets?.some(b=>b.id==="85_and_up"));
  if(wrappers.length===0)throw Error("reference-missing-85-plus-wrapper");
  const groupNames=new Set(wrappers.map(e=>name(e.name)));
  const ids=catalog.events.filter(e=>live(e,now)&&selected.has(e.id)&&
    (hints(e,"lohub_wrapper")||hints(e,"lohub_feeder"))&&
    groupNames.has(name(e.name))).map(e=>e.id);
  const feederIds=ids.filter(id=>hints(publicById.get(id),"lohub_feeder"));
  if(feederIds.length===0)throw Error("reference-no-active-feeders");
  // The only public payload contains IDs of already-public game objects.
  return {source:"scopely-player-level110-reference",bracket:"85_and_up",
    observedAt:iso(now),eligibleEventIds:ids.sort()};
}
export async function attachLevel110Reference(catalog,env,fetchImpl=fetch,now=Date.now()){
  const config=await readEventReferenceConfig(env?.CAPTAIN_BUCKET);
  if(!config)return catalog; // Existing public catalogue remains unchanged until opt-in.
  const grant=await getCaptainRecord(env.CAPTAIN_BUCKET,
    env.CAPTAIN_ENCRYPTION_KEY_HEX,CAPTAIN_PREFIX+config.session,now);
  if(!grant?.scope?.split(/\s+/).includes("m3p.f.pr.act"))
    throw Error("reference-oauth-scope-unavailable");
  const token=await tokenForKey(env,CAPTAIN_PREFIX+config.session);
  if(!token)throw Error("reference-oauth-expired");
  const personal=await collectPersonalEvents(token,fetchImpl);
  return {...catalog,objectiveEligibility:selectLevel110Events(catalog,personal,now)};
}
export async function manageEventReference(request,env,fetchImpl=fetch,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  const headers={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex"};
  const answer=(data,status=200)=>Response.json(data,{status,headers});
  if(!bucket?.get||!bucket?.put||!bucket?.delete)
    return answer({error:"storage-unavailable"},503);
  if(request.method==="GET"){
    try{
      const config=await readEventReferenceConfig(bucket);
      return answer({configured:!!config,bracket:config?.bracket||null,
        selectedSession:config?.session||null,
        approvedAt:config?.approvedAt||null});
    }catch{return answer({error:"configuration-unavailable"},503);}
  }
  if(request.method!=="POST")return answer({error:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(request.headers.get("Origin")!==url.origin||url.search!=="")
    return answer({error:"invalid-origin"},403);
  let body;
  try{body=await request.json();}catch{return answer({error:"invalid-json"},400);}
  if(body?.action!=="select"&&body?.action!=="clear")
    return answer({error:"invalid-action"},400);
  if(body.action==="select"){
    const session=body.session;
    if(!SID.test(session||""))return answer({error:"invalid-session"},400);
    const grant=await getCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,
      CAPTAIN_PREFIX+session,now);
    if(!grant?.scope?.split(/\s+/).includes("m3p.f.pr.act"))
      return answer({error:"event-oauth-not-authorized"},403);
    const token=await tokenForKey(env,CAPTAIN_PREFIX+session);
    if(!token)return answer({error:"oauth-expired"},503);
    try{
      const response=await fetchImpl(API+"/player/v1/card",{
        method:"GET",cache:"no-store",redirect:"manual",
        signal:AbortSignal.timeout(12000),headers:{
          Authorization:"Bearer "+token,"x-api-key":API_KEY,
          "User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"
        }
      });
      if(!response.ok)return answer({error:"player-card-unavailable"},502);
      const card=(await response.json())?.data;
      if(!Number.isSafeInteger(card?.level?.completedTier)||
        card.level.completedTier!==110)
        return answer({error:"reference-player-not-level-110"},409);
    }catch{return answer({error:"player-card-unavailable"},502);}
    await bucket.put(EVENT_REFERENCE_CONFIG_KEY,JSON.stringify({
      version:1,session,bracket:"85_and_up",approvedAt:iso(now)
    }),options);
  }else{
    await bucket.delete(EVENT_REFERENCE_CONFIG_KEY);
  }
  // Force an immediate fresh atomic catalogue, so the old reference is
  // never accidentally left published after changing or revoking consent.
  await bucket.put(EVENTS_DIRTY_KEY,JSON.stringify({
    version:1,changedAt:iso(now)
  }),options);
  return answer({status:body.action==="select"?"selected":"cleared"});
}
