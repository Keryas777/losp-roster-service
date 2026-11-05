// Small independent daily refresh for public /game/v1/events only.
// Reuses the current minute Cron, OAuth app token, R2, global /game budget
// and the SAME Durable Object lock as the general differential collector.
// Never reads /player, never exposes provider secrets, never writes browser files.
import {API_KEY} from "./player-card.js";
import {appToken,GAME_ARCHIVE_ROOT,GAME_ARCHIVE_DAILY_LIMIT} from "./game-catalog-archive.js";
import {buildDailyPublicEvents,DAILY_EVENTS_KEY} from "./public-events.js";

const ROOT=GAME_ARCHIVE_ROOT+"events-daily/";
const STATE=ROOT+"state.json";
const BUDGET=GAME_ARCHIVE_ROOT+"budget/";
const API="https://api.marvelstrikeforce.com";
const LOCK="e".repeat(64);
const PAGE_SIZE=100,MAX_PAGES=10,MAX_BYTES=1_500_000;
const UTC_SLOT=3*60+17,RETRY=15*60000;
const opts={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const read=async(bucket,key)=>{
  const obj=await bucket.get(key);
  return obj?JSON.parse(await obj.text()):null;
};
const write=(bucket,key,object)=>bucket.put(key,JSON.stringify(object),opts);
const iso=now=>new Date(now).toISOString();
const day=now=>iso(now).slice(0,10);
const digest=async text=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(text)))]
  .map(value=>value.toString(16).padStart(2,"0")).join("");

async function lock(env,holder,action){
  const binding=env.ROSTER_BATCH_LOCK;
  const response=await binding.get(binding.idFromName(LOCK)).fetch(
    new Request("https://daily-events-lock.internal/",{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,holder,fingerprint:LOCK})}));
  return response.ok&&(await response.json()).status===
    (action==="acquire"?"acquired":"released");
}

async function limitedJson(response){
  if(!response.body)throw Error("empty-event-page");
  const reader=response.body.getReader(),chunks=[];
  let bytes=0;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_BYTES)throw Error("oversized-event-page");
      chunks.push(part.value);
    }
  }catch(error){
    await reader.cancel().catch(()=>{});
    throw error;
  }
  const buffer=new Uint8Array(bytes);
  let pos=0;
  for(const chunk of chunks){buffer.set(chunk,pos);pos+=chunk.length;}
  const doc=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
  if(!doc||typeof doc!=="object"||Array.isArray(doc)||
     !Array.isArray(doc.data)||!doc.meta)throw Error("invalid-event-page");
  return doc;
}

function validBudget(value,date){
  return value?.date===date&&Number.isSafeInteger(value.used)&&
    value.used>=0&&value.used<=GAME_ARCHIVE_DAILY_LIMIT&&
    (value.diffUsed===undefined||Number.isSafeInteger(value.diffUsed)&&
      value.diffUsed>=0&&value.diffUsed<=GAME_ARCHIVE_DAILY_LIMIT);
}

async function providerPage(bucket,token,fetchImpl,now,page,lang){
  const today=day(now),key=BUDGET+today+".json";
  let budget=await read(bucket,key)||{date:today,used:0,diffUsed:0};
  if(!validBudget(budget,today))throw Error("invalid-game-budget");
  if(budget.used>=GAME_ARCHIVE_DAILY_LIMIT)throw Error("game-budget-exhausted");
  // Reserve the request BEFORE touching the provider; retries also count.
  budget={...budget,used:budget.used+1};
  await write(bucket,key,budget);
  const path="/game/v1/events?page="+page+"&perPage="+PAGE_SIZE+
    (lang==="fr"?"&lang=fr":"");
  const response=await fetchImpl(API+path,{method:"GET",cache:"no-store",
    redirect:"manual",signal:AbortSignal.timeout(15000),headers:{
      "x-api-key":API_KEY,Authorization:"Bearer "+token,
      "User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"
    }});
  if(response.status===429)throw Error("provider-rate-limited");
  if(!response.ok)throw Error("events-http-"+response.status);
  return limitedJson(response);
}

function pageCount(first){
  const total=first?.meta?.perTotal;
  if(first?.meta?.page!==1||first.meta.perPage!==PAGE_SIZE||
     !Number.isSafeInteger(total)||total<1||total>MAX_PAGES*PAGE_SIZE)
    throw Error("invalid-events-total");
  return Math.ceil(total/PAGE_SIZE);
}

// A failed collection leaves the last fully verified R2 object untouched.
// The daily key is replaced atomically after all EN pages pass validation.
export async function runGameDailyEventsTick(env,fetchImpl=fetch,now=Date.now()){
  if(env?.GAME_DIFF_ENABLED!=="true")return {status:"disabled"};
  if(!env?.CAPTAIN_BUCKET?.get||!env.CAPTAIN_BUCKET.put||
     !env.ROSTER_BATCH_LOCK?.get)return {status:"storage-unavailable"};
  const date=day(now),clock=new Date(now);
  if(clock.getUTCHours()*60+clock.getUTCMinutes()<UTC_SLOT)
    return {status:"not-due"};
  const bucket=env.CAPTAIN_BUCKET;
  let holder=null,acquired=false;
  try{
    const current=await read(bucket,STATE);
    if(current?.date===date&&current.status==="completed")
      return {status:"up-to-date",checkedAt:current.checkedAt};
    if(current?.date===date&&Number.isFinite(Date.parse(current.attemptAt||""))&&
       now-Date.parse(current.attemptAt)<(current.retryAfterMs||RETRY))
      return {status:"cooldown"};
    holder=crypto.randomUUID();
    acquired=await lock(env,holder,"acquire");
    if(!acquired)return {status:"busy"};
    // Re-read after the lock: another Cron invocation may have completed.
    const state=await read(bucket,STATE);
    if(state?.date===date&&state.status==="completed")
      return {status:"up-to-date",checkedAt:state.checkedAt};
    if(state?.date===date&&Number.isFinite(Date.parse(state.attemptAt||""))&&
       now-Date.parse(state.attemptAt)<(state.retryAfterMs||RETRY))
      return {status:"cooldown"};
    await write(bucket,STATE,{date,status:"running",attemptAt:iso(now)});
    try{
      const token=await appToken(env,fetchImpl,now);
      if(!token)throw Error("app-oauth-unavailable");
      const english=[await providerPage(bucket,token,fetchImpl,now,1,"en")];
      const count=pageCount(english[0]);
      for(let page=2;page<=count;page++)
        english.push(await providerPage(bucket,token,fetchImpl,now,page,"en"));
      let french=null;
      try{
        const first=await providerPage(bucket,token,fetchImpl,now,1,"fr");
        if(pageCount(first)===count&&first.meta.perTotal===english[0].meta.perTotal){
          french=[first];
          for(let page=2;page<=count;page++)
            french.push(await providerPage(bucket,token,fetchImpl,now,page,"fr"));
        }
      }catch(error){
        if(error.message==="provider-rate-limited"||
           error.message==="game-budget-exhausted")throw error;
        // French is optional: keep the complete, verified English source.
        french=null;
      }
      const catalog=buildDailyPublicEvents(english,french,now);
      const previous=await read(bucket,DAILY_EVENTS_KEY);
      const changed=JSON.stringify(previous?.catalog?.events)!==
        JSON.stringify(catalog.events);
      catalog.lastChangedAt=changed?iso(now):
        previous?.catalog?.lastChangedAt||iso(now);
      const serialized=JSON.stringify(catalog);
      await write(bucket,DAILY_EVENTS_KEY,{version:1,
        sha256:await digest(serialized),catalog});
      // The state is marked completed ONLY after the atomic catalogue PUT.
      await write(bucket,STATE,{date,status:"completed",attemptAt:iso(now),
        checkedAt:iso(now),lastChangedAt:catalog.lastChangedAt,
        count:catalog.count,pages:catalog.pages,locale:catalog.locale});
      return {status:"completed",count:catalog.count,pages:catalog.pages,
        locale:catalog.locale,changed};
    }catch(error){
      const reason=String(error?.message||"events-daily-error");
      const retryAfterMs=reason==="provider-rate-limited"?60*60000:RETRY;
      await write(bucket,STATE,{date,status:"failed",attemptAt:iso(now),
        retryAfterMs,reason});
      return {status:"failed",reason};
    }
  }catch{return {status:"unavailable"};}
  finally{
    if(acquired)try{await lock(env,holder,"release");}catch{}
  }
}
