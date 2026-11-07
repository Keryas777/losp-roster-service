import test from "node:test";
import assert from "node:assert/strict";
import {archiveGuestInitialArena,mergeArenaHistory}
  from "../src/public-arena-history.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const FP="c".repeat(64),KEY="questionable-propriety";
const NOW=Date.parse("2026-11-08T13:20:00Z");
const STORE_KEY="roster-batches/v1/guest-arena-history/rolling.json";
const INFO_KEY="roster-batches/v1/"+FP+"/campaigns/2026-11-08-am-infos.json";
function fixture(){
  const store=new Map();
  store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY}]}));
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:"d".repeat(64),name:"Zeus"}]}));
  store.set(INFO_KEY,JSON.stringify({
    version:1,kind:"alliance-infos-campaign",allianceFingerprint:FP,
    campaign:"2026-11-08-am",allianceName:"Questionable Propriety",
    capturedAt:"2026-11-08T13:15:00Z",expiresAt:"2026-11-15T13:15:00Z",
    rows:[{name:"QP Captain",latestArena:23},{name:"No Rank"}]
  }));
  return {store,env:{CAPTAIN_BUCKET:{
    get:async key=>store.has(key)?{text:async()=>store.get(key),
      size:store.get(key).length}:null,
    put:async(key,data)=>{store.set(key,data);}
  }}};
}
test("arrival creates an actual source-dated private Arena baseline",async()=>{
  const f=fixture();
  const first=await archiveGuestInitialArena(f.env,FP,KEY,NOW);
  assert.equal(first.status,"updated");
  assert.equal(first.players,1);
  const saved=JSON.parse(f.store.get(STORE_KEY));
  const snap=saved.snapshots[0];
  assert.equal(snap.sourceKind,"onboarding");
  assert.equal(snap.attribution,"onboarding-current-observation");
  assert.equal(snap.date,"2026-11-08");
  assert.equal(snap.players[0].allianceKey,KEY);
  assert.equal(snap.players[0].arenaRank,23);
  assert.doesNotMatch(JSON.stringify(saved),/c{64}|d{64}|oauth|token/);
  assert.equal((await archiveGuestInitialArena(f.env,FP,KEY,NOW)).status,"unchanged");
});
test("same-date real daily reward replaces onboarding, never invents yesterday",()=>{
  const saved={snapshots:[{date:"2026-11-08",sourceKind:"onboarding",
    players:[{name:"QP Captain",arenaRank:23}]}]};
  const reward={date:"2026-11-08",sourceKind:"reward",
    players:[{name:"QP Captain",arenaRank:18}]};
  const result=mergeArenaHistory(saved,[reward],"2026-11-08");
  assert.equal(result.snapshots.length,1);
  assert.equal(result.snapshots[0].sourceKind,"reward");
  assert.equal(result.snapshots[0].players[0].arenaRank,18);
});
test("a revoked guest cannot get a new Arena observation",async()=>{
  const f=fixture();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  assert.equal((await archiveGuestInitialArena(f.env,FP,KEY,NOW)).status,
    "not-approved-and-bound");
  assert.equal(f.store.has(STORE_KEY),false);
});
