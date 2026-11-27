import {accessJwt,accessFetch,ACCESS_OWNER} from "./event-planner/access-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {handleEventPlannerApi} from "../src/event-planner-api.js";
import {PersonalEventProgressCache} from "../src/personal-event-progress.js";
import {captainSessionKey} from "../src/captain-vault.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const accessFetcher=accessFetch();globalThis.fetch=accessFetcher;
const ID="a".repeat(43),COOKIE="__Host-losp_captain_session="+ID;
const ALL_SCOPES="openid m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act offline";
const event={id:"event-1",type:"milestone",milestone:{scoring:{methods:[]},brackets:[]}};
function setup(provider,scope=ALL_SCOPES){
  const values=new Map(),rosterValues=new Map(),calls=[],r2Reads=[];
  const storage={get:async key=>values.get(key),put:async(key,value)=>values.set(key,value)};
  const object=new PersonalEventProgressCache({storage},{});let internalCalls=0;
  const env={EVENT_PLANNER_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"planner-test.cloudflareaccess.com",CF_ACCESS_AUD:"a".repeat(32),MSF_ADMIN_EMAILS:ACCESS_OWNER,
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),CAPTAIN_BUCKET:{put(){},get:async key=>{r2Reads.push(key);const raw=rosterValues.get(key);return raw?{size:raw.length,text:async()=>raw}:null;},delete(){}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status:"active",scope,accessToken:"private-test-token"})})},
    PERSONAL_EVENT_CACHE:{idFromName:key=>key,get:()=>({fetch:request=>{internalCalls++;return object.fetch(request,async(url,options)=>{calls.push({url:new URL(url),options});return provider(url,options,calls);});}})}};
  const request=(path,origin=ORIGIN,cookie=COOKIE,access=true)=>new Request(ORIGIN+path,{headers:{...(access?{"Cf-Access-Jwt-Assertion":OWNER_JWT}:{}),...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})}});
  return {env,calls,request,values,rosterValues,r2Reads,get internalCalls(){return internalCalls;}};
}
const payload=(data,meta={})=>Response.json({data,meta:{page:1,perPage:100,perTotal:Array.isArray(data)?data.length:undefined,asOf:"version-1",...meta}});

test("anonymous and cross-origin reads are denied before provider access",async()=>{
  const f=setup(()=>{throw Error("provider must not be reached");});
  const anonymous=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events",ORIGIN,null,false),f.env);
  assert.equal(anonymous.status,403);assert.equal(await anonymous.text(),"Forbidden");
  const cross=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events","https://attacker.example"),f.env);
  assert.equal(cross.status,403);assert.equal(f.calls.length,0);
});

test("status exposes an opaque per-session namespace without credentials",async()=>{
  const f=setup(()=>{throw Error("status must not query Scopely");});
  const first=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=status"),f.env);
  const firstBody=await first.json();
  assert.equal(first.status,200);assert.match(firstBody.storageNamespace,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(firstBody),new RegExp(ID));
  assert.doesNotMatch(JSON.stringify(firstBody),/private-test-token|Bearer|accessToken/i);
  const otherCookie="__Host-losp_captain_session="+"b".repeat(43);
  const second=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=status",ORIGIN,otherCookie),f.env);
  assert.notEqual((await second.json()).storageNamespace,firstBody.storageNamespace);
  assert.equal(f.calls.length,0);
});

test("missing roster scope is explicit and makes no Scopely request",async()=>{
  const f=setup(()=>{throw Error("provider must not be reached");},"openid m3p.f.pr.act");
  const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster"),f.env);
  assert.equal(response.status,403);assert.equal((await response.json()).requiredScope,"m3p.f.pr.ros");assert.equal(f.calls.length,0);
});

test("roster language is validated before an upstream call",async()=>{
  const f=setup(()=>{throw Error("provider must not be reached");});
  const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster&lang=none"),f.env);
  assert.equal(response.status,400);assert.equal(f.calls.length,0);
});

test("planner rejects English personal reads outside the authorized French scope",async()=>{
  const f=setup(()=>{throw Error("English reads are outside this validation's authorization");});
  for(const path of [
    "/admin/api/event-planner?resource=events&lang=en",
    "/admin/api/event-planner?resource=detail&eventId=event-1&lang=en",
    "/admin/api/event-planner?resource=inventory&itemType=ISOITEM&lang=en"
  ]){
    const response=await handleEventPlannerApi(f.request(path),f.env);
    assert.equal(response.status,400);
  }
  assert.equal(f.calls.length,0);
});

async function seedScheduledRoster(f,now,{guest=false,missingHint=false,missingSelf=false}={}){
  const fp=guest?"c".repeat(64):"b".repeat(64),key=await captainSessionKey(ID);
  const hash=key.slice("oauth-captains/v1/".length),runId="11111111-2222-4333-8444-555555555555";
  const capturedAt=new Date(now-120_000).toISOString(),expiresAt=new Date(now+3_600_000).toISOString();
  const root=`roster-batches/v1/${fp}/`;
  f.rosterValues.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:guest?[]:[{fingerprint:fp,name:"Synthetic LoSP"}]}));
  f.rosterValues.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:guest?[{fingerprint:fp,allianceKey:"guest-test"}]:[]}));
  f.rosterValues.set("roster-batches/v1/connected-alliances/sessions/"+hash,JSON.stringify({version:1,
    fingerprint:fp,name:guest?"Synthetic guest":"Synthetic LoSP",observedAt:new Date(now-60_000).toISOString()}));
  f.rosterValues.set(`roster-session-hint/v1/${fp}.json`,JSON.stringify({version:1,key:missingHint?await captainSessionKey("b".repeat(43)):key}));
  f.rosterValues.set(root+"latest-complete.json",JSON.stringify({version:1,fingerprint:fp,runId,
    membershipDigest:"d".repeat(64),total:1,coMembers:0,observedMembers:1,includesPersonal:true,
    coverage:"all-members",notSharedCount:0,capturedAt,expiresAt}));
  if(!missingSelf)f.rosterValues.set(root+runId+"/member-self.json",JSON.stringify({version:1,
    kind:"private-staged-personal-roster",allianceFingerprint:fp,runId,memberIndex:"self",
    name:"Synthetic Captain",volatileMemberId:"fixture-member-id",capturedAt:new Date(now-180_000).toISOString(),
    expiresAt,asOf:"synthetic-roster-version",characters:[{id:"CaptainAmerica",power:123456,
      level:90,gearTier:19,activeYellow:7,activeRed:4,iso8:{active:"raider",raider:5}}]}));
  return {fp,key,root,runId};
}

test("planner reads only the latest scheduled private self roster for LoSP and guest approvals",async()=>{
  for(const guest of [false,true]){
    const f=setup(()=>{throw Error("scheduled roster reads must not call Scopely");});
    const now=Date.now(),fixture=await seedScheduledRoster(f,now,{guest});
    const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster&lang=fr"),f.env,accessFetcher,now);
    const body=await response.json();
    assert.equal(response.status,200);assert.equal(body.resource,"roster");
    assert.equal(body.retrievedAt,new Date(now-180_000).toISOString());
    assert.equal(body.upstream.calls,0);assert.equal(body.upstream.asOf,"synthetic-roster-version");
    assert.equal(body.data[0].id,"CaptainAmerica");assert.equal(body.data[0].gearTier,19);
    assert.equal(body.data[0].iso8.raider,5);
    assert.ok(f.r2Reads.includes(fixture.root+fixture.runId+"/member-self.json"));
    assert.equal(f.r2Reads.some(key=>/member-(?:0|1|2)\.json$/.test(key)),false);
    assert.equal(f.calls.length,0);assert.equal(f.internalCalls,0);
  }
});

test("roster resolver fails closed when the scheduled-account link or self snapshot is absent",async()=>{
  for(const failure of ["hint","self"]){
    const f=setup(()=>{throw Error("no collection is permitted");}),now=Date.now();
    await seedScheduledRoster(f,now,{missingHint:failure==="hint",missingSelf:failure==="self"});
    const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster&lang=fr"),f.env,accessFetcher,now);
    assert.equal(response.status,404);assert.equal((await response.json()).error,"roster-unavailable");
    assert.equal(f.calls.length,0);assert.equal(f.internalCalls,0);
  }
});

test("admin diagnostics read only the already valid inventory cache and expose no data to the player page",async()=>{
  const f=setup(()=>{throw Error("cache-only diagnostics must not call Scopely");}),now=Date.now();
  await seedScheduledRoster(f,now);
  f.values.set("planner:inventory:ISOITEM",{expiresAt:now+60_000,response:{status:"ok",resource:"inventory",
    retrievedAt:new Date(now-30_000).toISOString(),upstream:{asOf:"inventory-version"},
    data:[{item:"ISOITEM_BLUE_SUPPORT_HEALTH_6",quantity:4}]}});
  const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=diagnostics"),f.env,accessFetcher,now);
  const body=await response.json();assert.equal(response.status,200);
  assert.equal(body.roster.characterCount,1);
  assert.equal(body.inventories.find(row=>row.itemType==="ISOITEM").rows[0].id,"ISOITEM_BLUE_SUPPORT_HEALTH_6");
  assert.equal(f.calls.length,0);assert.equal(f.internalCalls,2);
});

test("event list follows Maddoxx's default first page and Scopely pagination metadata",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);assert.equal(parsed.pathname,"/player/v1/events");
    assert.equal(parsed.searchParams.get("lang"),"fr");
    assert.equal(parsed.searchParams.get("eventInfo"),null);assert.equal(parsed.searchParams.get("objRewards"),null);
    if(f.calls.length===1){
      assert.equal(parsed.searchParams.get("page"),null);assert.equal(parsed.searchParams.get("perPage"),null);
      return payload(Array.from({length:2},(_,index)=>({...event,id:`event-${index}`})),{perPage:2,perTotal:3});
    }
    assert.equal(parsed.searchParams.get("page"),"2");assert.equal(parsed.searchParams.get("perPage"),"2");
    return payload([{...event,id:"event-2"}],{page:2,perPage:2,perTotal:3});
  });
  const first=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=fr"),f.env,accessFetcher,10_000);
  const firstBody=await first.json();assert.equal(first.status,200);assert.equal(firstBody.data.length,3);assert.equal(firstBody.cache.hit,false);
  const second=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=fr"),f.env,accessFetcher,10_001);
  assert.equal((await second.json()).cache.hit,true);assert.equal(f.calls.length,2);
  assert.equal(first.headers.get("cache-control"),"private, no-store, max-age=0");
});

test("event failures return a safe provider diagnostic without response text or credentials",async()=>{
  const f=setup(()=>Response.json({error:{code:"event-list-unavailable",message:"private account detail"}},{status:502}));
  const originalWarn=console.warn;console.warn=()=>{};
  try{
    const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=fr"),f.env);
    const body=await response.json(),serialized=JSON.stringify(body);
    assert.equal(response.status,502);assert.equal(body.diagnostic.endpoint,"/player/v1/events");
    assert.equal(body.diagnostic.httpStatus,502);assert.equal(body.diagnostic.providerCode,"event-list-unavailable");
    assert.equal(body.diagnostic.lang,"fr");assert.equal(body.diagnostic.page,1);
    assert.doesNotMatch(serialized,/private account detail|private-test-token|Authorization|Bearer/);
  }finally{console.warn=originalWarn;}
});

test("nested event detail envelopes and the scheduled personal roster are unwrapped",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);
    if(parsed.pathname==="/player/v1/events/event-1")return Response.json({data:{data:event},meta:{asOf:"detail"}});
    return new Response("not found",{status:404});
  });
  const detail=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=detail&eventId=event-1&lang=fr"),f.env);
  assert.equal((await detail.json()).data.id,"event-1");
  const now=Date.now();
  const fixture=await seedScheduledRoster(f,now);
  const roster=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster&lang=fr"),f.env,accessFetcher,now);
  const body=await roster.json();
  assert.equal(body.data[0].id,"CaptainAmerica");
  assert.equal(body.retrievedAt,new Date(now-180_000).toISOString());
  assert.equal(body.upstream.calls,0);
  assert.ok(f.r2Reads.includes(fixture.root+fixture.runId+"/member-self.json"));
  assert.equal(f.calls.length,1,"only the previously selected event detail may contact Scopely");
  assert.equal(f.internalCalls,1,"scheduled roster comes directly from R2, without a second cache or collection");
});

test("inventory type is allowlisted and explicit missing items are not synthesized",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);assert.equal(parsed.pathname,"/player/v1/inventory");
    assert.equal(parsed.searchParams.get("itemType"),"CONSUMABLE");
    return payload([{item:"CONSUMABLE_GOLD",quantity:0}],{perTotal:1});
  });
  const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=inventory&itemType=CONSUMABLE&lang=fr"),f.env);
  const body=await response.json();assert.equal(body.data[0].quantity,0);
  assert.equal(f.calls[0].url.searchParams.get("lang"),"fr");
  const bad=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=inventory&itemType=PLAYER"),f.env);
  assert.equal(bad.status,400);assert.equal(f.calls.length,1);
});

test("inventory refresh paginates and reuses the last complete list on Scopely 344",async()=>{
  let call=0;
  const f=setup(async url=>{
    const parsed=new URL(url);assert.equal(parsed.searchParams.get("itemType"),"CONSUMABLE");assert.equal(parsed.searchParams.get("lang"),"fr");
    if(call++===0){assert.equal(parsed.searchParams.get("page"),"1");assert.equal(parsed.searchParams.get("perPage"),"100");
      return payload([{item:"SC",quantity:25}],{perTotal:1,asOf:"inventory-v1"});}
    assert.equal(parsed.searchParams.get("since"),"inventory-v1");
    return new Response(null,{status:344});
  });
  const path="/admin/api/event-planner?resource=inventory&itemType=CONSUMABLE&lang=fr";
  const first=await handleEventPlannerApi(f.request(path),f.env,accessFetcher,10_000);
  assert.equal((await first.json()).data[0].quantity,25);
  const second=await handleEventPlannerApi(f.request(path+"&refresh=1"),f.env,accessFetcher,310_001);
  const body=await second.json();
  assert.equal(second.status,200);assert.equal(body.data[0].item,"SC");assert.equal(body.upstream.unchanged,true);
  assert.equal(call,2);
});
