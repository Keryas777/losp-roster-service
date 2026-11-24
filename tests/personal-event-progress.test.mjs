import {test} from "node:test";
import assert from "node:assert/strict";
import {handlePersonalEventProgress,PersonalEventProgressCache,numericProgressFacts} from "../src/personal-event-progress.js";
import {accessJwt,accessFetch,ACCESS_OWNER,ACCESS_DOMAIN,ACCESS_AUD} from "./event-planner/access-fixtures.mjs";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const accessFetcher=accessFetch();globalThis.fetch=accessFetcher;
const cookie="__Host-losp_captain_session="+"a".repeat(43);
const scope="openid m3p.f.pr.pro m3p.f.pr.act offline";
const envBase=()=>({EVENT_PLANNER_ENABLED:"true",MSF_ADMIN_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,
  CF_ACCESS_TEAM_DOMAIN:ACCESS_DOMAIN,CF_ACCESS_AUD:ACCESS_AUD,MSF_ADMIN_EMAILS:ACCESS_OWNER,
  CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
  CAPTAIN_BUCKET:{put(){},get(){},delete(){}},
  CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({
    status:"active",scope,accessToken:"private-token"})})}});
function harness(provider){
  const state=new Map(),calls=[],instances=new Map();
  const env=envBase();env.PERSONAL_EVENT_CACHE={idFromName:key=>key,get:key=>({fetch:req=>{
    if(!instances.has(key))instances.set(key,new PersonalEventProgressCache({storage:{
      get:async k=>state.get(key+"|"+k),put:async(k,v)=>state.set(key+"|"+k,v),
      list:async()=>new Map([...state.entries()].filter(([name])=>name.startsWith(key+"|progress:")).map(([name,value])=>[name.slice(key.length+1),value])),
      setAlarm:async value=>state.set(key+"|alarm",value),deleteAlarm:async()=>state.delete(key+"|alarm"),
      delete:async k=>state.delete(key+"|"+k)}},{}));
    return instances.get(key).fetch(req,async(url,options)=>{calls.push({url,options,identity:key});return provider(url,options,calls);});
  }})};
  const request=(path="/captain/api/events",method="GET",headers={},id="a".repeat(43))=>new Request(ORIGIN+path,{method,headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT,Cookie:"__Host-losp_captain_session="+id,...headers}});
  return {env,calls,state,request};
}
const payload=(data,meta={})=>Response.json({data,meta:{page:1,perTotal:data.length,asOf:"stable",...meta}});
const event={id:"e1",type:"milestone",milestone:{brackets:[{id:"default",objective:{progress:4}}],scoring:{cappedScorings:[{cap:10,soFar:6},{cap:5}]}}};

test("no Scopely session returns explicit not-connected without provider call",async()=>{
  const f=harness(()=>{throw Error("must not call provider");});
  const res=await handlePersonalEventProgress(new Request(ORIGIN+"/captain/api/events",{headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT}}),f.env);
  assert.equal(res.status,401);assert.equal((await res.json()).error,"not-connected");
});
test("Discord-only or insufficient OAuth scope is rejected before any event GET",async()=>{
  const f=harness(()=>{throw Error("must not call provider");});
  f.env.CAPTAIN_REFRESH_COORDINATOR.get=()=>({fetch:async()=>Response.json({status:"active",scope:"openid",accessToken:"x"})});
  const res=await handlePersonalEventProgress(f.request(),f.env);
  assert.equal(res.status,403);assert.equal((await res.json()).error,"scope-insufficient");assert.equal(f.calls.length,0);
});
test("revoked Scopely consent is rejected before reading a warm private cache",async()=>{
  const f=harness(()=>{throw Error("revoked consent must not reach provider");});
  f.env.CAPTAIN_REFRESH_COORDINATOR.get=()=>({fetch:async()=>Response.json({status:"revoked"})});
  const res=await handlePersonalEventProgress(f.request(),f.env);
  assert.equal(res.status,401);assert.equal((await res.json()).error,"consent-revoked");
  assert.equal(f.calls.length,0);
});
test("event list requests full French data with pagination and reports numeric facts only when present",async()=>{
  const f=harness(url=>{
    const page=Number(new URL(url).searchParams.get("page"));
    assert.equal(new URL(url).searchParams.get("eventInfo"),"full");
    assert.equal(new URL(url).searchParams.get("objRewards"),"full");
    return page===1?payload(Array.from({length:100},(_,i)=>({id:"e"+i})),{perTotal:101}):
      payload([event],{page:2,perTotal:101});
  });
  const res=await handlePersonalEventProgress(f.request(),f.env,fetch,1000);
  const body=await res.json();
  assert.equal(res.status,200);assert.equal(body.events.length,101);
  assert.equal(body.upstream.calls,2);assert.equal(f.calls.length,2);
  assert.deepEqual(body.events.at(-1).progressFacts.map(x=>x.value),[4,6,null]);
  assert.equal(body.events.at(-1).progressFacts.at(-1).state,"unknown");
  assert.equal(res.headers.get("cache-control"),"private, no-store, max-age=0");
});
test("event detail is fetched only on explicit eventId; player targeting is rejected",async()=>{
  const f=harness(url=>{
    const parsed=new URL(url);
    assert.equal(parsed.pathname,"/player/v1/events/e1");
    assert.equal(parsed.searchParams.get("lang"),"fr");
    return Response.json({data:event,meta:{asOf:"detail"}});
  });
  const detail=await handlePersonalEventProgress(f.request("/captain/api/events?eventId=e1"),f.env,fetch,5000);
  const body=await detail.json();assert.equal(body.eventId,"e1");assert.equal(body.events.length,1);assert.equal(f.calls.length,1);
  const blocked=await handlePersonalEventProgress(f.request("/captain/api/events?playerId=other"),f.env,fetch,5001);
  assert.equal(blocked.status,400);assert.equal(f.calls.length,1);
});
test("successful response is cached for 300 seconds, expires without stale fallback",async()=>{
  let fail=false;const f=harness(()=>fail?new Response(null,{status:503}):payload([event]));
  const first=await (await handlePersonalEventProgress(f.request(),f.env,fetch,10_000)).json();
  const second=await (await handlePersonalEventProgress(f.request(),f.env,fetch,10_001)).json();
  assert.equal(first.cache.hit,false);assert.equal(second.cache.hit,true);assert.equal(f.calls.length,1);
  fail=true;
  const expired=await handlePersonalEventProgress(f.request(),f.env,fetch,310_000);
  assert.equal(expired.status,502);assert.equal((await expired.json()).error,"provider-error");
  assert.equal(f.calls.length,2);
});
test("simultaneous requests to one cache object share a single provider fetch",async()=>{
  let resolve;const wait=new Promise(r=>resolve=r);const f=harness(async()=>{await wait;return payload([event]);});
  const a=handlePersonalEventProgress(f.request(),f.env,fetch,1000);
  const b=handlePersonalEventProgress(f.request(),f.env,fetch,1000);
  await new Promise(r=>setTimeout(r,0));resolve();
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(ra.status,200);assert.equal(rb.status,200);assert.equal(f.calls.length,1);
});
test("separate authorized player sessions use separate private cache objects",async()=>{
  const f=harness(async(url,options)=>{
    await new Promise(r=>setTimeout(r,2));
    return payload([{id:new URL(url).searchParams.get("page")==="1"?"event":"other"}]);
  });
  const [a,b]=await Promise.all([
    handlePersonalEventProgress(f.request(undefined,"GET",{},"a".repeat(43)),f.env,fetch,1000),
    handlePersonalEventProgress(f.request(undefined,"GET",{},"b".repeat(43)),f.env,fetch,1000)
  ]);
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].identity,f.calls[1].identity);
});
test("429 is explicit and never converted to empty progress",async()=>{
  const f=harness(()=>new Response("",{status:429}));
  const res=await handlePersonalEventProgress(f.request(),f.env,fetch,1000);
  assert.equal(res.status,429);assert.equal((await res.json()).error,"rate-limited");
});
test("manual refresh uses a short anti-abuse guard, not a per-minute collection cap",async()=>{
  const f=harness(()=>payload([event]));
  const first=await handlePersonalEventProgress(f.request("/captain/api/events?refresh=1"),f.env,fetch,20_000);
  const blocked=await handlePersonalEventProgress(f.request("/captain/api/events?refresh=1"),f.env,fetch,20_001);
  const allowed=await handlePersonalEventProgress(f.request("/captain/api/events?refresh=1"),f.env,fetch,30_001);
  assert.equal(first.status,200);assert.equal(blocked.status,429);assert.equal(allowed.status,200);
  assert.equal(f.calls.length,2);
});
test("missing personal progress remains unknown rather than zero or completed",()=>{
  assert.deepEqual(numericProgressFacts({id:"x",milestone:{brackets:[{id:"d",objective:{}}]}}),[
    {kind:"objective-progress",scope:"unknown",bracketId:"d",path:"milestone.brackets[0].objective.progress",value:null,state:"unknown"}
  ]);
});
test("Durable Object alarm removes expired private payloads",async()=>{
  const values=new Map([["progress:list",{expiresAt:Date.now()-1,response:{events:[{private:true}]}}]]);
  const storage={list:async()=>new Map(values),delete:async key=>values.delete(key),
    setAlarm:async value=>values.set("alarm",value),deleteAlarm:async()=>values.delete("alarm")};
  const cache=new PersonalEventProgressCache({storage},{});
  await cache.alarm();
  assert.equal(values.has("progress:list"),false);
  assert.equal(values.has("alarm"),false);
});
