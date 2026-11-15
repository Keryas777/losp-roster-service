import test from "node:test";
import assert from "node:assert/strict";
import {selectLevel110Events,attachLevel110Reference,
  EVENT_REFERENCE_CONFIG_KEY,manageEventReference} from "../src/game-events-reference.js";
import {putCaptainRecord,CAPTAIN_PREFIX} from "../src/captain-vault.js";

const NOW=Math.floor(Date.now()/1000)*1000;
const day=86400;
const hex=n=>n.repeat(24);
const name="Briseur de volontés - Plan de bataille du mois 1";
const base={startTime:NOW/1000-day,endTime:NOW/1000+day,type:"milestone",name};
const wrapper={...base,id:hex("a"),locationHints:["lohub_wrapper"],
  milestone:{brackets:[{id:"85_and_up"}]}};
const raid={...base,id:hex("b"),locationHints:["lohub_feeder"]};
const war={...base,id:hex("c"),locationHints:["lohub_feeder"]};
const extra={...base,id:hex("d"),locationHints:["lohub_feeder"]};
const catalog={schemaVersion:1,status:"ok",events:[wrapper,raid,war,extra]};

test("only eligible public IDs are selected, not personal progression",()=>{
  const privateEvents=[
    {...wrapper,personalProgress:{name:"secret",value:7}},
    {...raid,milestone:{progress:{value:3}}},
    {...war,endTime:NOW/1000-day*2}, // expired, never public
    {...extra,id:hex("f"),privateData:{progress:4}}
  ];
  const result=selectLevel110Events(catalog,privateEvents,NOW);
  assert.deepEqual(result.eligibleEventIds,[wrapper.id,raid.id]);
  assert.equal(result.source,"scopely-player-level110-reference");
  assert.equal(result.bracket,"85_and_up");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("progress"));
});

test("refuses player without verified 85-and-up wrapper",()=>{
  const lower={...wrapper,milestone:{brackets:[{id:"65_and_up"}]}};
  assert.throws(()=>selectLevel110Events(catalog,[lower,raid],NOW),
    /reference-missing-85-plus-wrapper/);
});

test("refuses yesterday's daily goals when a current daily feeder exists",()=>{
  const yesterday={...raid,startTime:NOW/1000-day*2,endTime:NOW/1000-day};
  assert.throws(()=>selectLevel110Events(catalog,[wrapper,yesterday],NOW),
    /reference-no-active-feeders|reference-daily-not-yet-ready/);
});

test("reference is off by default; complete consented collection is public-IDs-only",async()=>{
  const sid="a".repeat(64),secret="ab".repeat(32),stored=new Map(),calls=[];
  const bucket={
    get:async key=>stored.has(key)?{size:stored.get(key).length,
      text:async()=>stored.get(key)}:null,
    put:async(key,value)=>stored.set(key,value),
    delete:async key=>stored.delete(key)
  };
  const fetchImpl=async(url)=>{
    calls.push(url);
    if(url.endsWith("/player/v1/card"))
      return Response.json({data:{level:{completedTier:110}},meta:{}});
    if(url.includes("/player/v1/events?"))
      return Response.json({data:[wrapper,raid],meta:{
        page:1,perPage:100,perTotal:2}});
    return Response.json({error:"unexpected"}, {status:404});
  };
  const coordinator={idFromName:()=>({}),get:()=>({fetch:async()=>Response.json({
    status:"active",accessToken:"test-access"
  })})};
  const env={CAPTAIN_BUCKET:bucket,CAPTAIN_ENCRYPTION_KEY_HEX:secret,
    CAPTAIN_REFRESH_COORDINATOR:coordinator};
  assert.equal(await attachLevel110Reference(catalog,env,fetchImpl,NOW),catalog);
  const realNow=Date.now();
  await putCaptainRecord(bucket,secret,CAPTAIN_PREFIX+sid,{
    version:2,createdAt:realNow-10000,expiresAt:realNow+5*86400000,
    accessToken:"test-access",refreshToken:"test-refresh",
    accessExpiresAt:realNow+3600000,
    scope:"offline m3p.f.ar.ros m3p.f.pr.act"
  });
  const req=new Request("https://example.com/admin/api/events-reference",{
    method:"POST",headers:{Origin:"https://example.com",
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"select",session:sid})
  });
  const selection=await manageEventReference(req,env,fetchImpl,realNow);
  assert.equal(selection.status,200);
  assert.equal(stored.has(EVENT_REFERENCE_CONFIG_KEY),true);
  const projected=await attachLevel110Reference(catalog,env,fetchImpl,realNow);
  assert.deepEqual(projected.objectiveEligibility.eligibleEventIds,[wrapper.id,raid.id]);
  assert.equal(projected.objectiveEligibility.bracket,"85_and_up");
  assert.ok(!JSON.stringify(projected.objectiveEligibility).includes("test-access"));
  assert.ok(stored.has("game-archive/v1/events-daily/dirty.json"));
  const del=await manageEventReference(new Request("https://example.com/admin/api/events-reference",{
    method:"POST",headers:{Origin:"https://example.com","Content-Type":"application/json"},
    body:JSON.stringify({action:"clear"})
  }),env,fetchImpl,realNow+1000);
  assert.equal(del.status,200);
  assert.equal(stored.has(EVENT_REFERENCE_CONFIG_KEY),false);
  assert.ok(calls.every(url=>url.includes("/player/v1/")));
});
