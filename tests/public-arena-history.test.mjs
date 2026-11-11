import test from "node:test";
import assert from "node:assert/strict";
import {buildArenaHistory,mergeArenaHistory,archiveArenaHistory,
  archiveArenaHistoryWhenReady,publicArenaHistory,publicArenaSnapshot} from "../src/public-arena-history.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";

const fp1="1".repeat(64),fp2="2".repeat(64);
const now=Date.parse("2026-11-01T19:17:00Z");
function fixture(){
  const store=new Map(),puts=[];
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:fp1,name:"Zeus"},{fingerprint:fp2,name:"Kronos"}]}));
  const env={CAPTAIN_BUCKET:{
    get:async key=>store.has(key)?{text:async()=>store.get(key),size:store.get(key).length}:null,
    put:async(key,value)=>{puts.push(key);store.set(key,value);}
  }};
  return {env,store,puts};
}
function add(store,fp,kind,rank,stamp){
  const campaign="2026-11-01-"+kind;
  const body={version:1,kind:kind==="am"?"alliance-infos-campaign":"alliance-infos-reward",
    campaign,allianceFingerprint:fp,allianceName:fp===fp1?"LoSP Zeus":"LoSP Kronos",
    capturedAt:stamp,expiresAt:"2026-11-08T19:00:00Z",
    rows:[{name:fp===fp1?"Keryas I":"Bob",latestArena:rank},
          {name:"Sans rang"}],
    ...(kind==="reward"?{observedAt:[{name:fp===fp1?"Keryas I":"Bob",at:stamp}]}:{})
  };
  store.set("roster-batches/v1/"+fp+"/campaigns/"+campaign+"-infos.json",
    JSON.stringify(body));
}
test("31 Oct backdate keeps real 1 Nov AM source; 1 Nov reward is distinct",async()=>{
  const f=fixture();
  for(const fp of [fp1,fp2]){
    add(f.store,fp,"am",fp===fp1?35:9,"2026-11-01T03:30:00Z");
    add(f.store,fp,"reward",fp===fp1?37:7,"2026-11-01T17:59:00Z");
  }
  const result=await buildArenaHistory(f.env,now);
  assert.deepEqual(result.snapshots.map(s=>s.date),["2026-10-31","2026-11-01"]);
  assert.equal(result.snapshots[0].attribution,"backdated-from-first-next-day-collection");
  assert.equal(result.snapshots[0].sourceDay,"2026-11-01");
  assert.equal(result.snapshots[1].sourceKind,"reward");
  assert.deepEqual(result.snapshots[0].players.map(p=>p.arenaRank),[35,9]);
  assert.deepEqual(result.snapshots[1].players.map(p=>p.arenaRank),[37,7]);
  assert.ok(result.snapshots[1].players.every(p=>p.observedAt));
  assert.ok(result.snapshots[0].players.every(p=>!p.observedAt));
  assert.doesNotMatch(JSON.stringify(result),/1{64}|2{64}|aid|token/);
});
test("never synthesize a complete day from incomplete alliance receipts",async()=>{
  const f=fixture();
  for(const fp of [fp1,fp2])add(f.store,fp,"am",10,"2026-11-01T03:30:00Z");
  add(f.store,fp1,"reward",5,"2026-11-01T18:30:00Z");
  const result=await buildArenaHistory(f.env,now);
  assert.deepEqual(result.snapshots.map(s=>s.date),["2026-10-31"]);
});
test("history is immutable per date and pruned to 30 dates",()=>{
  const item=(date,rank)=>({date,players:[{name:"A",arenaRank:rank}]});
  const saved={snapshots:[item("2026-10-30",2),item("2026-10-31",5)]};
  const result=mergeArenaHistory(saved,[item("2026-10-31",99),
    item("2026-11-29",6)],"2026-11-29");
  assert.deepEqual(result.snapshots.map(s=>s.date),["2026-10-31","2026-11-29"]);
  assert.equal(result.snapshots[0].players[0].arenaRank,5);
});
test("archives on existing cron at 20:17 Paris; endpoint is read-only",async()=>{
  const f=fixture();
  for(const fp of [fp1,fp2]){
    add(f.store,fp,"am",5,"2026-11-01T03:30:00Z");
    add(f.store,fp,"reward",4,"2026-11-01T18:55:00Z");
  }
  assert.equal((await archiveArenaHistory(f.env,
    Date.parse("2026-11-01T19:16:00Z"))).status,"outside-window");
  assert.equal(f.puts.length,0);
  const result=await archiveArenaHistory(f.env,now);
  assert.equal(result.status,"updated");
  assert.equal(result.snapshots,2);
  assert.equal(f.puts.length,1);
  assert.equal(f.puts[0],"roster-batches/v1/arena-history/rolling.json");
  const response=await publicArenaHistory(new Request("https://service.test/api/public/arena-history"),f.env,now);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"*");
  assert.equal(f.puts.length,1);
});

test("guest Arena points are archived privately, never merged into the public LoSP endpoint",async()=>{
 const f=fixture(),guest="3".repeat(64);
 f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
   alliances:[{fingerprint:guest}]}));
 for(const fp of [fp1,fp2,guest]){
   add(f.store,fp,"am",11,"2026-11-01T03:30:00Z");
   add(f.store,fp,"reward",12,"2026-11-01T18:55:00Z");
 }
 const result=await archiveArenaHistory(f.env,now);
 assert.equal(result.status,"updated");
 assert.equal(result.guestStatus,"updated");
 assert.ok(f.store.has("roster-batches/v1/guest-arena-history/rolling.json"));
 assert.equal(f.puts.length,2);
 const response=await publicArenaHistory(
   new Request("https://service.test/api/public/arena-history"),f.env,now);
 const publicData=await response.json();
 assert.equal(response.status,200);
 assert.ok(publicData.snapshots.every(s=>s.players.length===2),
   "Only the two LoSP alliances must appear publicly");
 const privateData=JSON.parse(f.store.get(
   "roster-batches/v1/guest-arena-history/rolling.json"));
 assert.ok(privateData.snapshots.every(s=>s.players.length===1));
});


function addRewardDay(store,fp,day,rank,time){
  store.set("roster-batches/v1/"+fp+"/campaigns/"+day+"-reward-infos.json",
    JSON.stringify({version:1,kind:"alliance-infos-reward",
      campaign:day+"-reward",allianceFingerprint:fp,
      allianceName:fp===fp1?"LoSP Zeus":fp===fp2?"LoSP Kronos":"MARINES",
      capturedAt:time,expiresAt:"2026-11-12T17:00:00Z",
      rows:[{name:"Player "+fp[0],latestArena:rank}],
      observedAt:[{name:"Player "+fp[0],at:time}]}));
}
const day5="2026-11-05";
const t5=s=>Date.parse(day5+"T"+s+"Z");

test("quiet 17:08 tick archives both scopes with real same-day receipts, no Scopely",async()=>{
  const f=fixture(),guest="3".repeat(64);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest,allianceKey:"marines"}]}));
  for(const [fp,rank] of [[fp1,9],[fp2,10],[guest,11]])
    addRewardDay(f.store,fp,day5,rank,day5+"T16:05:00Z");
  const result=await archiveArenaHistoryWhenReady(f.env,t5("16:08:00"));
  assert.equal(result.status,"updated");
  assert.equal(result.guestStatus,"updated");
  assert.equal(f.puts.length,2);
  const losp=JSON.parse(f.store.get("roster-batches/v1/arena-history/rolling.json"));
  const privateGuest=JSON.parse(f.store.get("roster-batches/v1/guest-arena-history/rolling.json"));
  assert.deepEqual(losp.snapshots.map(s=>s.date),[day5]);
  assert.equal(losp.snapshots[0].players.length,2);
  assert.equal(losp.snapshots[0].players.every(x=>x.alliance!=="MARINES"),true);
  assert.deepEqual(privateGuest.snapshots.map(s=>s.date),[day5]);
  assert.deepEqual(privateGuest.snapshots[0].players.map(x=>x.alliance),["MARINES"]);
  const publicRes=await publicArenaHistory(
    new Request("https://service.test/api/public/arena-history"),f.env,t5("16:08:00"));
  assert.equal(publicRes.status,200);
  assert.doesNotMatch(await publicRes.text(),/MARINES|3{64}/);
  const second=await archiveArenaHistoryWhenReady(f.env,t5("16:09:00"));
  assert.equal(second.status,"unchanged");
  assert.equal(second.guestStatus,"unchanged");
  assert.equal(f.puts.length,2,"Repeated quiet ticks cannot duplicate writes");
});

test("missing guest does not block the six-LoSP equivalent; guest self-recovers on next tick",async()=>{
  const f=fixture(),guest="3".repeat(64);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest}]}));
  for(const fp of [fp1,fp2])
    addRewardDay(f.store,fp,day5,14,day5+"T16:06:00Z");
  const partial=await archiveArenaHistoryWhenReady(f.env,t5("16:08:00"));
  assert.equal(partial.status,"updated");
  assert.equal(partial.guestStatus,"awaiting-receipts");
  assert.deepEqual(f.puts,["roster-batches/v1/arena-history/rolling.json"]);
  addRewardDay(f.store,guest,day5,15,day5+"T16:09:00Z");
  const repaired=await archiveArenaHistoryWhenReady(f.env,t5("16:10:00"));
  assert.equal(repaired.status,"unchanged");
  assert.equal(repaired.guestStatus,"updated");
  assert.equal(f.puts.length,2);
});

test("incomplete LoSP source remains pending until valid and never invents a point",async()=>{
  const f=fixture();
  addRewardDay(f.store,fp1,day5,50,day5+"T16:05:00Z");
  const incomplete=await archiveArenaHistoryWhenReady(f.env,t5("16:08:00"));
  assert.equal(incomplete.status,"awaiting-receipts");
  assert.deepEqual(f.puts,[]);
  const publicRes=await publicArenaHistory(
    new Request("https://service.test/api/public/arena-history"),f.env,t5("16:08:00"));
  assert.deepEqual((await publicRes.json()).snapshots,[]);
  addRewardDay(f.store,fp2,day5,51,day5+"T16:09:00Z");
  assert.equal((await archiveArenaHistoryWhenReady(f.env,t5("16:10:00"))).status,
    "updated");
  assert.equal(f.puts.length,1);
});
test("UTC time gates begin at 16:01 and keep retrying through the end of the day",async()=>{
  const f=fixture();
  for(const fp of [fp1,fp2])
    addRewardDay(f.store,fp,day5,21,day5+"T16:01:00Z");
  assert.equal((await archiveArenaHistoryWhenReady(f.env,t5("16:00:00"))).status,
    "outside-window");
  assert.deepEqual(f.puts,[]);
  const ready=await archiveArenaHistoryWhenReady(f.env,t5("16:01:00"));
  assert.ok(["updated","unchanged"].includes(ready.status));
  assert.equal(f.puts.length,1);
  assert.notEqual((await archiveArenaHistoryWhenReady(f.env,t5("23:59:00"))).status,
    "outside-window");
  assert.ok(["updated","unchanged"].includes((await archiveArenaHistory(f.env,t5("19:17:00"))).status));
  assert.equal((await archiveArenaHistory(f.env,t5("19:18:00"))).status,
    "outside-window");
});

test("public GitHub projection includes every approved alliance using only rank fields",async()=>{
  const f=fixture(),guest="3".repeat(64);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest,allianceKey:"marines"}]}));
  for(const fp of [fp1,fp2,guest]){
    add(f.store,fp,"reward",fp===guest?12:8,"2026-11-01T16:01:00Z");
    const key="roster-batches/v1/"+fp+"/campaigns/2026-11-01-reward-infos.json";
    const receipt=JSON.parse(f.store.get(key));
    receipt.rows[0].aid="private-provider-id";
    f.store.set(key,JSON.stringify(receipt));
  }
  const response=await publicArenaSnapshot(
    new Request("https://service.test/api/public/arena-snapshot?date=2026-11-01"),
    f.env,now);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.status,"complete");
  assert.equal(body.snapshot.alliancesExpected,3);
  assert.equal(body.snapshot.alliancesComplete,3);
  assert.equal(body.snapshot.players.length,3);
  assert.equal(body.snapshot.players.find(p=>p.allianceKey==="marines").arenaRank,12);
  assert.ok(body.snapshot.players.every(p=>/^p_[a-f0-9]{64}$/.test(p.playerId)));
  assert.doesNotMatch(JSON.stringify(body),/private-provider-id|fingerprint|expiresAt|rosterShare/);
});
test("public GitHub projection stays explicitly incomplete when any approved alliance is missing",async()=>{
  const f=fixture();
  add(f.store,fp1,"reward",8,"2026-11-01T16:01:00Z");
  const response=await publicArenaSnapshot(
    new Request("https://service.test/api/public/arena-snapshot?date=2026-11-01"),
    f.env,now);
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{status:"incomplete",date:"2026-11-01",
    alliancesExpected:2,alliancesComplete:1});
});
