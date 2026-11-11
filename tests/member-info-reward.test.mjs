import {test} from "node:test";
import assert from "node:assert/strict";
import {rewardWindow,runRewardInfoAutoTick} from "../src/member-info-reward.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";

const t=s=>Date.parse(s);
const fp1="1".repeat(64),fp2="2".repeat(64),fp3="3".repeat(64);
const fixture=()=>{
  const store=new Map();
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:fp3,name:"Kronos"},
      {fingerprint:fp1,name:"Zeus"},{fingerprint:fp2,name:"Athéna"}]
  }));
  const bucket={
    get:async key=>store.has(key)?{text:async()=>store.get(key)}:null,
    put:async(key,value)=>store.set(key,value),
    delete:async key=>store.delete(key)
  };
  const env={
    MEMBER_INFO_REWARD_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    CAPTAIN_BUCKET:bucket,CAPTAIN_REFRESH_COORDINATOR:{idFromName:k=>k}
  };
  return {env,store};
};
test("reward cutoff: 16:00 UTC must never be sampled; 16:01 UTC is the first slot",()=>{
  assert.equal(rewardWindow(t("2026-11-02T16:00:00Z")),null);
  assert.deepEqual(rewardWindow(t("2026-11-02T16:01:00Z")),{
    day:"2026-11-02",tick:0,stamp:"2026-11-02T16:01Z"
  });
  assert.equal(rewardWindow(t("2026-11-02T16:31:00Z")),null);
});
test("16:01 UTC stays fixed in summer and winter regardless of DST",()=>{
  assert.equal(rewardWindow(t("2026-07-02T16:00:00Z")),null);
  assert.deepEqual(rewardWindow(t("2026-07-02T16:01:00Z")),{
    day:"2026-07-02",tick:0,stamp:"2026-07-02T16:01Z"
  });
  assert.deepEqual(rewardWindow(t("2026-07-02T16:06:00Z")).tick,5);
});
test("independent round-robin samples approved alliances with no extra cron",async()=>{
  const f=fixture(),calls=[];
  const collector=async(_env,fp,slot)=>{
    calls.push({fp,day:slot.day,tick:slot.tick});
    return {status:"complete",requests:0};
  };
  for(let minute=1;minute<=6;minute++){
    const hh=String(minute).padStart(2,"0");
    const out=await runRewardInfoAutoTick(f.env,t("2026-11-02T16:"+hh+":00Z"),
      async()=>{throw Error("No direct provider calls in scheduler")},collector);
    assert.equal(out.status,"complete");
  }
  assert.deepEqual(calls.map(x=>x.fp),[fp1,fp2,fp3,fp1,fp2,fp3]);
  assert.ok(calls.every(x=>x.day==="2026-11-02"));
});
test("opt-in and time guards make no calls outside the post-reward window",async()=>{
  const f=fixture();
  let calls=0;
  const collect=async()=>{calls++;return {status:"complete"};};
  assert.equal((await runRewardInfoAutoTick(f.env,
    t("2026-11-02T16:00:00Z"),fetch,collect)).status,"outside-window");
  f.env.MEMBER_INFO_REWARD_ENABLED="false";
  assert.equal((await runRewardInfoAutoTick(f.env,
    t("2026-11-02T16:01:00Z"),fetch,collect)).status,"disabled");
  assert.equal(calls,0);
});
test("failing retention guard never triggers another request",async()=>{
  const f=fixture();
  f.env.ROSTER_RETENTION_CONFIRMED="false";
  const result=await runRewardInfoAutoTick(f.env,
    t("2026-11-02T16:01:00Z"),async()=>{throw Error("must not fetch");});
  assert.equal(result.status,"retention-not-confirmed");
});

test("automatic reward-time scheduling includes guests but keeps existing LoSP order",async()=>{
 const f=fixture(),guest="4".repeat(64),sampled=[];
 f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
   alliances:[{fingerprint:guest}]}));
 for(let i=1;i<=4;i++){
   const minute=String(i).padStart(2,"0");
   await runRewardInfoAutoTick(f.env,t("2026-11-02T16:"+minute+":00Z"),
     async()=>{throw Error("No provider access in injected collector");},
     async(_env,fp)=>{sampled.push(fp);return {status:"complete",requests:0};});
 }
 assert.deepEqual(sampled,[fp1,fp2,fp3,guest]);
});

