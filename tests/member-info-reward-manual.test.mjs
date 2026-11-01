import {test} from "node:test";
import assert from "node:assert/strict";
import {handleRewardInfoManual,rewardManualStatus,runRewardInfoAutoTick}
  from "../src/member-info-reward.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {handleAdmin} from "../src/admin-routes.js";

const fp1="1".repeat(64),fp2="2".repeat(64),fp3="3".repeat(64);
const url="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/reward-infos-manual";
const at=s=>Date.parse(s);
function fixture(){
  const files=new Map(),calls=[];
  files.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:fp3,name:"Kronos"},{fingerprint:fp1,name:"Zeus"},
    {fingerprint:fp2,name:"Athéna"}
  ]}));
  const bucket={
    get:async key=>{
      calls.push({action:"get",key});
      return files.has(key)?{text:async()=>files.get(key)}:null;
    },
    put:async(key,value)=>{calls.push({action:"put",key});files.set(key,value);},
    delete:async key=>{calls.push({action:"delete",key});files.delete(key);}
  };
  const env={
    MEMBER_INFO_REWARD_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    CAPTAIN_BUCKET:bucket,
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:x=>x}
  };
  return {env,files,calls};
}
function post(body="{}",headers={}){
  return new Request(url,{method:"POST",headers:{
    Origin:new URL(url).origin,"Content-Type":"application/json",...headers
  },body});
}
function get(){return new Request(url);}

test("GET reads status from R2 only and does not start an API collection",async()=>{
  const f=fixture(),now=at("2026-11-01T17:42:00Z");
  const res=await handleRewardInfoManual(get(),f.env,now);
  assert.equal(res.status,200);
  const state=await res.json();
  assert.equal(state.day,"2026-11-01");
  assert.equal(state.status,"not-started");
  assert.equal(state.alliancesTotal,3);
  assert.equal(state.alliancesComplete,0);
  assert.ok(f.calls.every(c=>c.action==="get"));
});

test("manual POST registers one 45-minute private day-scoped intent",async()=>{
  const f=fixture(),now=at("2026-11-01T17:42:15Z");
  const res=await handleRewardInfoManual(post(),f.env,now);
  assert.equal(res.status,202);
  const value=await res.json();
  assert.equal(value.status,"running");
  assert.equal(value.startedAt,"2026-11-01T17:42:15.000Z");
  assert.equal(value.expiresAt,"2026-11-01T18:27:15.000Z");
  const marker="roster-batches/v1/reward-manual/2026-11-01.json";
  assert.equal(JSON.parse(f.files.get(marker)).day,"2026-11-01");
  const again=await handleRewardInfoManual(post(),f.env,now+10000);
  assert.equal(again.status,200);
  assert.equal((await again.json()).startedAt,value.startedAt);
  assert.equal(f.calls.filter(c=>c.action==="put").length,1,
    "repeated start must never multiply the collection");
});

test("existing cron resumes manual intent after 17:30, one approved alliance per minute",async()=>{
  const f=fixture();
  await handleRewardInfoManual(post(),f.env,at("2026-11-01T17:42:15Z"));
  const chosen=[];
  const collector=async(_env,fp,slot)=>{
    chosen.push({fp,day:slot.day,stamp:slot.stamp});
    return {status:"partial",requests:4};
  };
  const noApi=async()=>{throw Error("no API in test scheduler");};
  for(const h of ["17:43","17:44","17:45"]){
    const result=await runRewardInfoAutoTick(f.env,
      at("2026-11-01T"+h+":00Z"),noApi,collector);
    assert.equal(result.status,"partial");
  }
  assert.deepEqual(chosen.map(x=>x.fp),[fp1,fp2,fp3]);
  assert.ok(chosen.every(x=>x.day==="2026-11-01"));
  assert.equal((await runRewardInfoAutoTick(f.env,
    at("2026-11-01T18:28:00Z"),noApi,collector)).status,"outside-window");
});

test("request fails closed before 17:01 Paris, with no marker or provider call",async()=>{
  const f=fixture(),now=at("2026-11-01T15:59:00Z");
  const response=await handleRewardInfoManual(post(),f.env,now);
  assert.equal(response.status,409);
  assert.equal((await response.json()).status,"before-reward-cutoff");
  assert.equal(f.calls.filter(x=>x.action==="put").length,0);
});

test("POST rejects cross-origin, wrong content type and unexpected body",async()=>{
  const f=fixture(),now=at("2026-11-01T17:42:00Z");
  const malformed=[
    post("{}",{Origin:"https://evil.invalid"}),
    post("{}",{"Content-Type":"text/plain"}),
    post('{"day":"2026-11-02"}'),
    post('{"alliance":"Zeus"}'),
    post('[]')
  ];
  for(const req of malformed){
    const response=await handleRewardInfoManual(req,f.env,now);
    assert.ok([400,403].includes(response.status));
  }
  assert.equal(f.calls.length,0);
});

test("completed receipts are counted but credentials and private IDs are not returned",async()=>{
  const f=fixture(),now=at("2026-11-01T17:42:00Z");
  for(const fp of [fp1,fp2,fp3]){
    f.files.set("roster-batches/v1/"+fp+"/campaigns/2026-11-01-reward-infos.json",
      JSON.stringify({version:1,kind:"alliance-infos-reward",
        campaign:"2026-11-01-reward",allianceFingerprint:fp,
        expiresAt:"2026-11-08T17:42:00Z",
        rows:[{name:"SECRET_PLAYER",latestArena:5}]}));
  }
  const result=await rewardManualStatus(f.env,now);
  assert.equal(result.status,"complete");
  assert.equal(result.alliancesComplete,3);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_PLAYER/);
  const postResult=await handleRewardInfoManual(post(),f.env,now);
  assert.equal(postResult.status,200);
  assert.equal(f.calls.filter(c=>c.action==="put").length,0);
});

test("untrusted requester cannot start the admin action without Cloudflare Access",async()=>{
  const f=fixture();
  f.env.MSF_ADMIN_ENABLED="true";
  f.env.CF_ACCESS_TEAM_DOMAIN="private-losp.cloudflareaccess.com";
  f.env.CF_ACCESS_AUD="a".repeat(64);
  f.env.MSF_ADMIN_EMAILS="admin@example.test";
  const response=await handleAdmin(post(),f.env,
    async()=>{throw Error("must not call provider");});
  assert.equal(response.status,403);
  assert.ok(f.calls.every(c=>c.action!=="put"));
});
