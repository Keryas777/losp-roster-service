import {accessJwt,accessFetch,ACCESS_OWNER} from "./event-planner/access-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {handleEventPlannerApi} from "../src/event-planner-api.js";
import {PersonalEventProgressCache} from "../src/personal-event-progress.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const accessFetcher=accessFetch();globalThis.fetch=accessFetcher;
const ID="a".repeat(43),COOKIE="__Host-losp_captain_session="+ID;
const ALL_SCOPES="openid m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act offline";
const event={id:"event-1",type:"milestone",milestone:{scoring:{methods:[]},brackets:[]}};
function setup(provider,scope=ALL_SCOPES){
  const values=new Map(),calls=[];
  const storage={get:async key=>values.get(key),put:async(key,value)=>values.set(key,value)};
  const object=new PersonalEventProgressCache({storage},{});
  const env={EVENT_PLANNER_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"planner-test.cloudflareaccess.com",CF_ACCESS_AUD:"a".repeat(32),MSF_ADMIN_EMAILS:ACCESS_OWNER,
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),CAPTAIN_BUCKET:{put(){},get(){},delete(){}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status:"active",scope,accessToken:"private-test-token"})})},
    PERSONAL_EVENT_CACHE:{idFromName:key=>key,get:()=>({fetch:request=>object.fetch(request,async(url,options)=>{calls.push({url:new URL(url),options});return provider(url,options,calls);})})}};
  const request=(path,origin=ORIGIN,cookie=COOKIE,access=true)=>new Request(ORIGIN+path,{headers:{...(access?{"Cf-Access-Jwt-Assertion":OWNER_JWT}:{}),...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})}});
  return {env,calls,request,values};
}
const payload=(data,meta={})=>Response.json({data,meta:{page:1,perPage:100,perTotal:Array.isArray(data)?data.length:undefined,asOf:"version-1",...meta}});

test("anonymous and cross-origin reads are denied before provider access",async()=>{
  const f=setup(()=>{throw Error("provider must not be reached");});
  const anonymous=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events",ORIGIN,null,false),f.env);
  assert.equal(anonymous.status,403);assert.equal(await anonymous.text(),"Forbidden");
  const cross=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events","https://attacker.example"),f.env);
  assert.equal(cross.status,403);assert.equal(f.calls.length,0);
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

test("event list follows Maddoxx's default first page and Scopely pagination metadata",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);assert.equal(parsed.pathname,"/player/v1/events");
    assert.equal(parsed.searchParams.get("lang"),"en");
    assert.equal(parsed.searchParams.get("eventInfo"),null);assert.equal(parsed.searchParams.get("objRewards"),null);
    if(f.calls.length===1){
      assert.equal(parsed.searchParams.get("page"),null);assert.equal(parsed.searchParams.get("perPage"),null);
      return payload(Array.from({length:2},(_,index)=>({...event,id:`event-${index}`})),{perPage:2,perTotal:3});
    }
    assert.equal(parsed.searchParams.get("page"),"2");assert.equal(parsed.searchParams.get("perPage"),"2");
    return payload([{...event,id:"event-2"}],{page:2,perPage:2,perTotal:3});
  });
  const first=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=en"),f.env,accessFetcher,10_000);
  const firstBody=await first.json();assert.equal(first.status,200);assert.equal(firstBody.data.length,3);assert.equal(firstBody.cache.hit,false);
  const second=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=en"),f.env,accessFetcher,10_001);
  assert.equal((await second.json()).cache.hit,true);assert.equal(f.calls.length,2);
  assert.equal(first.headers.get("cache-control"),"private, no-store, max-age=0");
});

test("event failures return a safe provider diagnostic without response text or credentials",async()=>{
  const f=setup(()=>Response.json({error:{code:"event-list-unavailable",message:"private account detail"}},{status:502}));
  const originalWarn=console.warn;console.warn=()=>{};
  try{
    const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=events&lang=en"),f.env);
    const body=await response.json(),serialized=JSON.stringify(body);
    assert.equal(response.status,502);assert.equal(body.diagnostic.endpoint,"/player/v1/events");
    assert.equal(body.diagnostic.httpStatus,502);assert.equal(body.diagnostic.providerCode,"event-list-unavailable");
    assert.equal(body.diagnostic.lang,"en");assert.equal(body.diagnostic.page,1);
    assert.doesNotMatch(serialized,/private account detail|private-test-token|Authorization|Bearer/);
  }finally{console.warn=originalWarn;}
});

test("nested event detail envelopes and the personal roster are unwrapped",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);
    if(parsed.pathname==="/player/v1/events/event-1")return Response.json({data:{data:event},meta:{asOf:"detail"}});
    if(parsed.pathname==="/player/v1/roster")return payload([{id:"CaptainAmerica",activeYellow:7}],{perTotal:1});
    return new Response("not found",{status:404});
  });
  const detail=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=detail&eventId=event-1&lang=en"),f.env);
  assert.equal((await detail.json()).data.id,"event-1");
  const roster=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=roster&lang=fr"),f.env);
  assert.equal((await roster.json()).data[0].id,"CaptainAmerica");
  assert.equal(f.calls.length,2);
});

test("inventory type is allowlisted and explicit missing items are not synthesized",async()=>{
  const f=setup(url=>{
    const parsed=new URL(url);assert.equal(parsed.pathname,"/player/v1/inventory");
    assert.equal(parsed.searchParams.get("itemType"),"CONSUMABLE");
    return payload([{item:"CONSUMABLE_GOLD",quantity:0}],{perTotal:1});
  });
  const response=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=inventory&itemType=CONSUMABLE"),f.env);
  const body=await response.json();assert.equal(body.data[0].quantity,0);
  const bad=await handleEventPlannerApi(f.request("/admin/api/event-planner?resource=inventory&itemType=PLAYER"),f.env);
  assert.equal(bad.status,400);assert.equal(f.calls.length,1);
});

test("inventory refresh paginates and reuses the last complete list on Scopely 344",async()=>{
  let call=0;
  const f=setup(async url=>{
    const parsed=new URL(url);assert.equal(parsed.searchParams.get("itemType"),"CONSUMABLE");
    if(call++===0){assert.equal(parsed.searchParams.get("page"),"1");assert.equal(parsed.searchParams.get("perPage"),"100");
      return payload([{item:"SC",quantity:25}],{perTotal:1,asOf:"inventory-v1"});}
    assert.equal(parsed.searchParams.get("since"),"inventory-v1");
    return new Response(null,{status:344});
  });
  const path="/admin/api/event-planner?resource=inventory&itemType=CONSUMABLE";
  const first=await handleEventPlannerApi(f.request(path),f.env,accessFetcher,10_000);
  assert.equal((await first.json()).data[0].quantity,25);
  const second=await handleEventPlannerApi(f.request(path+"&refresh=1"),f.env,accessFetcher,310_001);
  const body=await second.json();
  assert.equal(second.status,200);assert.equal(body.data[0].item,"SC");assert.equal(body.upstream.unchanged,true);
  assert.equal(call,2);
});
