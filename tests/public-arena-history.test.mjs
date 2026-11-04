import test from "node:test";
import assert from "node:assert/strict";
import {buildArenaHistory,mergeArenaHistory,archiveArenaHistory,
  publicArenaHistory} from "../src/public-arena-history.js";
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

