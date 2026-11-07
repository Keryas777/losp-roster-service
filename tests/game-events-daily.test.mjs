import {test} from "node:test";
import assert from "node:assert/strict";
import {runGameDailyEventsTick,markGameEventsDirty,EVENTS_DIRTY_KEY} from "../src/game-events-daily.js";
import {dispatchGameEventsToGithub} from "../src/game-events-github-dispatch.js";
import {buildPublicEvents,DAILY_EVENTS_KEY,
  buildDailyPublicEvents} from "../src/public-events.js";

const NOW=Date.parse("2026-11-05T21:05:00Z");
const ROOT="game-archive/v1/";
const API="https://api.marvelstrikeforce.com";
const OAUTH="https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const data=Array.from({length:151},(_,i)=>({
  id:i.toString(16).padStart(24,"0"),name:"Event "+i,
  type:"milestone",startTime:1792000000,endTime:1802000000,
  milestone:{type:"solo",scoring:{
    methods:[{description:"Play War",points:5}]
  }}
}));
function page(n,lang="en",total=151){
  const from=(n-1)*100;
  return {data:data.slice(from,Math.min(from+100,total)).map(e=>lang==="fr"?{
    ...e,name:"Événement "+e.id,milestone:{...e.milestone,
      scoring:{methods:[{description:"Jouer en guerre",points:5}]}}
  }:e),meta:{page:n,perPage:100,perTotal:total,
    hashes:{events:"a".repeat(20)}}};
}
function fixture({failPage=null,rateLimit=false}={}){
  const objects=new Map(),calls=[];
  const bucket={
    get:async key=>{
      const content=objects.get(key);
      return content===undefined?null:{
        size:Buffer.byteLength(content),text:async()=>content
      };
    },
    put:async(key,body)=>{objects.set(key,body);},
    head:async key=>objects.has(key)?{}:null
  };
  const binding={idFromName:()=>({}),get:()=>({fetch:async request=>{
    const body=await request.json();
    return Response.json({status:body.action==="acquire"?
      "acquired":"released"});
  }})};
  const env={CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:binding,
    GAME_DIFF_ENABLED:"true",ROSTER_GITHUB_DISPATCH_TOKEN:"test-github-token",
    SCOPELY_CLIENT_ID:"test",
    SCOPELY_CLIENT_SECRET:"test"};
  const fetchImpl=async url=>{
    calls.push(url);
    if(url===OAUTH)return Response.json({access_token:"unit-token",
      token_type:"Bearer",expires_in:300});
    const parsed=new URL(url),n=Number(parsed.searchParams.get("page"));
    assert.equal(parsed.origin,new URL(API).origin);
    if((failPage&&n===failPage.page&&
         (parsed.searchParams.get("lang")||"en")===failPage.lang))
      return new Response(null,{status:503});
    if(rateLimit)return new Response(null,{status:429});
    return Response.json(page(n,parsed.searchParams.get("lang")||"en"));
  };
  return {objects,calls,bucket,env,fetchImpl};
}

test("daily builder rejects missing/duplicated pages and preserves English",()=>{
  const en=[page(1),page(2)];
  assert.throws(()=>buildDailyPublicEvents([en[0]],null,NOW));
  const duplicate=page(2);
  duplicate.data[0]={...duplicate.data[0],id:en[0].data[0].id};
  assert.throws(()=>buildDailyPublicEvents([en[0],duplicate],null,NOW),
    /duplicate/);
  const catalog=buildDailyPublicEvents(en,null,NOW);
  assert.equal(catalog.count,151);
  assert.equal(catalog.locale,"en");
  assert.equal(catalog.source,"verified-daily-game-events");
});

test("collects four pages, publishes one atomic verified R2 catalogue",async()=>{
  const f=fixture();
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    NOW-60000)).status,"not-due");
  assert.equal(f.calls.length,0);
  const result=await runGameDailyEventsTick(f.env,f.fetchImpl,NOW);
  assert.equal(result.status,"completed");
  assert.equal(result.count,151);
  assert.equal(result.pages,2);
  assert.equal(result.locale,"fr");
  assert.equal(f.calls.filter(x=>x.startsWith(API)).length,4);
  const published=await buildPublicEvents(f.env,NOW);
  assert.equal(published.total,151);
  assert.equal(published.locale,"fr");
  assert.equal(published.events[0].name,"Événement "+data[0].id);
  assert.equal(published.events[0].milestone.scoring.methods[0].points,5);
  assert.ok(f.objects.has(DAILY_EVENTS_KEY));
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    NOW+3600000)).status,"up-to-date");
  assert.equal(f.calls.filter(x=>x.startsWith(API)).length,4);
  assert.equal((await f.bucket.get(ROOT+"budget/2026-11-05.json"))!==null,true);
});

test("21:05 UTC collection still runs if the old 03:17 slot already completed",async()=>{
  const f=fixture();
  f.objects.set(ROOT+"events-daily/state.json",JSON.stringify({
    date:"2026-11-05",status:"completed",
    checkedAt:"2026-11-05T03:17:00.000Z",
    attemptAt:"2026-11-05T03:17:00.000Z"
  }));
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-05T20:59:00Z"))).status,"not-due");
  assert.equal(f.calls.length,0);
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,NOW)).status,
    "completed");
  assert.equal(f.calls.filter(url=>url.startsWith(API)).length,4);
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,NOW+60000))
    .status,"up-to-date");
});

test("03:17 UTC is no longer due and the next UTC day waits for 21:05",async()=>{
  const f=fixture();
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-05T03:17:00Z"))).status,"not-due");
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,NOW)).status,
    "completed");
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    NOW+24*3600000-60000)).status,"not-due");
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    NOW+24*3600000)).status,"completed");
  assert.equal(f.calls.filter(url=>url.startsWith(API)).length,8);
});

test("missed 21:05 UTC slot is recovered after midnight, without repeating it",async()=>{
  const f=fixture();
  const previousDate="2026-11-05";
  f.objects.set(ROOT+"events-daily/state.json",JSON.stringify({
    date:previousDate,status:"completed",
    checkedAt:previousDate+"T03:17:00.000Z",
    attemptAt:previousDate+"T03:17:00.000Z"
  }));
  const afterMidnight=Date.parse("2026-11-06T00:15:00Z");
  const result=await runGameDailyEventsTick(f.env,f.fetchImpl,afterMidnight);
  assert.equal(result.status,"completed");
  const state=JSON.parse(f.objects.get(ROOT+"events-daily/state.json"));
  assert.equal(state.date,previousDate);
  assert.equal(state.checkedAt,new Date(afterMidnight).toISOString());
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    afterMidnight+60000)).status,"up-to-date");
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-06T03:17:00Z"))).status,"not-due");
  assert.equal(f.calls.filter(url=>url.startsWith(API)).length,4);
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-06T21:05:00Z"))).status,"completed");
  assert.equal(f.calls.filter(url=>url.startsWith(API)).length,8);
});

test("the old 03:17 run is never moved to a second collection by grace window",async()=>{
  const f=fixture();
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-05T03:17:00Z"))).status,"not-due");
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    Date.parse("2026-11-05T21:04:00Z"))).status,"not-due");
  assert.equal(f.calls.length,0);
});

test("failed English page never overwrites a previously committed catalogue",async()=>{
  const f=fixture();
  const ok=await runGameDailyEventsTick(f.env,f.fetchImpl,NOW);
  assert.equal(ok.status,"completed");
  const original=f.objects.get(DAILY_EVENTS_KEY);
  const failed=fixture({failPage:{page:2,lang:"en"}});
  failed.objects.set(DAILY_EVENTS_KEY,original);
  const next=await runGameDailyEventsTick(failed.env,failed.fetchImpl,
    NOW+24*3600000);
  assert.equal(next.status,"failed");
  assert.equal(failed.objects.get(DAILY_EVENTS_KEY),original);
  // The last good R2 catalogue is still fresh for up to 48 hours.
  assert.equal((await buildPublicEvents(failed.env,NOW+24*3600000)).count,151);
  await assert.rejects(buildPublicEvents(failed.env,NOW+49*3600000),
    /stale-daily-catalog/);
  assert.equal((await runGameDailyEventsTick(failed.env,failed.fetchImpl,
    NOW+24*3600000+60000)).status,"cooldown");
});

test("French failure publishes full English catalogue, never mixed pages",async()=>{
  const f=fixture({failPage:{page:2,lang:"fr"}});
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,NOW)).status,
    "completed");
  const catalog=await buildPublicEvents(f.env,NOW);
  assert.equal(catalog.locale,"en");
  assert.equal(catalog.localizationStatus,"awaiting-daily-french-collection");
  assert.equal(catalog.events.length,151);
  assert.equal(catalog.events[0].name,"Event 0");
});

test("provider 429 does not publish and respects a one-hour cooldown",async()=>{
  const f=fixture({rateLimit:true});
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,NOW)).status,
    "failed");
  assert.equal(f.objects.has(DAILY_EVENTS_KEY),false);
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,
    NOW+30*60000)).status,"cooldown");
});

test("a differential event revision refreshes the R2 catalogue on the same day",async()=>{
  const f=fixture();
  const first=await runGameDailyEventsTick(f.env,f.fetchImpl,NOW);
  assert.equal(first.status,"completed");
  assert.equal(first.trigger,undefined); // Public status remains backward compatible.
  assert.equal(f.calls.filter(x=>x.startsWith(API)).length,4);
  const next=NOW+90*60000;
  await markGameEventsDirty(f.bucket,next);
  assert.equal(JSON.parse(f.objects.get(EVENTS_DIRTY_KEY)).changedAt,
    new Date(next).toISOString());
  const again=await runGameDailyEventsTick(f.env,f.fetchImpl,next+60000);
  assert.equal(again.status,"completed");
  assert.equal(f.calls.filter(x=>x.startsWith(API)).length,8);
  const state=JSON.parse(f.objects.get(ROOT+"events-daily/state.json"));
  assert.equal(state.trigger,"differential");
  assert.equal(state.dirtyAt,new Date(next).toISOString());
  assert.equal((await runGameDailyEventsTick(f.env,f.fetchImpl,next+120000)).status,
    "up-to-date");
});

test("verified daily and differential collections wake the GitHub JSON publisher exactly once",async()=>{
  const f=fixture();
  const github=[];
  const submit=async(url,options)=>{
    github.push({url,options});
    return new Response(null,{status:204});
  };
  assert.equal(await dispatchGameEventsToGithub(f.env,submit,NOW),"not-ready");
  await runGameDailyEventsTick(f.env,f.fetchImpl,NOW);
  assert.equal(await dispatchGameEventsToGithub(f.env,submit,NOW),
    "dispatched");
  assert.equal(await dispatchGameEventsToGithub(f.env,submit,NOW),
    "already-dispatched");
  assert.equal(github.length,1);
  assert.equal(JSON.parse(github[0].options.body).inputs.reason,"daily");
  assert.match(github[0].url,/publish-events-r2\.yml\/dispatches$/);
  await markGameEventsDirty(f.bucket,NOW+3600000);
  await runGameDailyEventsTick(f.env,f.fetchImpl,NOW+3600000+1000);
  assert.equal(await dispatchGameEventsToGithub(
    f.env,submit,NOW+3600000+1000),"dispatched");
  assert.equal(github.length,2);
  assert.equal(JSON.parse(github[1].options.body).inputs.reason,"differential");
});

test("failed GitHub dispatch is retryable without recollecting Scopely",async()=>{
  const f=fixture();
  await runGameDailyEventsTick(f.env,f.fetchImpl,NOW);
  const total=f.calls.filter(x=>x.startsWith(API)).length;
  const fail=async()=>new Response(null,{status:503});
  assert.equal(await dispatchGameEventsToGithub(f.env,fail,NOW),
    "github-unavailable");
  assert.equal(await dispatchGameEventsToGithub(f.env,async()=>new Response(
    null,{status:204}),NOW+1000),"dispatched");
  assert.equal(f.calls.filter(x=>x.startsWith(API)).length,total);
});
