import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {archiveGuestSeasonRankSample,publicGuestSeasonRanks}
  from "../src/public-guest-season-ranks.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const day="2026-11-09",NOW=Date.parse(day+"T03:15:00.000Z");
const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const url=origin+"/api/public/guest-season-ranks";
const fp=s=>createHash("sha256").update(s).digest("hex");
const marines=fp("marines"),red=fp("endgame-red"),orange=fp("endgame-orange");
const publicId="83937048-ec30-47d3-8b56-cca351fca34b";
function fixture(){
  const store=new Map(),ops=[];
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:marines},{fingerprint:red,allianceKey:"endgame-revolution-red"},
    {fingerprint:orange,allianceKey:"endgame-revolution-orange"}]}));
  store.set("roster-batches/v1/trophy-history/rolling.json",JSON.stringify({
    version:1,kind:"connected-alliance-trophy-history",ids:{[marines]:publicId},
    snapshots:[]}));
  const bucket={get:async k=>{
    ops.push(["get",k]);return store.has(k)?{text:async()=>store.get(k),
      size:store.get(k).length}:null;},
    put:async(k,v)=>{
      ops.push(["put",k]);assert.ok(k.startsWith("roster-batches/v1/"));
      store.set(k,v);}
  };
  return {store,ops,env:{CAPTAIN_BUCKET:bucket}};
}
const sample=()=>({version:1,source:"/player/v1/alliance/card",
  capturedAt:day+"T03:15:00.000Z",completeSessionScan:true,
  alliances:[
    {allianceFingerprint:marines,name:"MΛЯIΠΣƨ",warRank:111,raidRank:77},
    {allianceFingerprint:red,name:"ENDGAME R-évolution",warRank:444,raidRank:222},
    {allianceFingerprint:orange,name:"ENDGAME R-évolution",warRank:555,raidRank:333}
  ]});
test("Monday capture publishes guest ranks without fingerprints or provider calls",async()=>{
  const f=fixture();
  assert.deepEqual(await archiveGuestSeasonRankSample(f.env,sample(),NOW),
    {status:"updated",observed:3});
  const response=await publicGuestSeasonRanks(new Request(url),f.env,NOW);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.kind,"connected-guest-season-ranks");
  assert.equal(body.snapshots.length,1);
  const rows=body.snapshots[0].alliances;
  assert.equal(rows.length,3);
  assert.deepEqual(rows.filter(x=>x.nameAtCapture==="ENDGAME R-évolution")
    .map(x=>[x.allianceKey,x.warRank,x.raidRank]).sort(),[
      ["endgame-revolution-orange",555,333],
      ["endgame-revolution-red",444,222]
    ].sort());
  assert.equal(rows.find(x=>x.publicId===publicId).warRank,111);
  assert.ok(rows.every(x=>x.warTrophies===undefined));
  const json=JSON.stringify(body);
  for(const privateItem of [marines,red,orange,"roster-batches","allianceFingerprint"]){
    assert.ok(!json.includes(privateItem),privateItem);
  }
  assert.ok(f.ops.every(([action])=>["get","put"].includes(action)));
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal((await archiveGuestSeasonRankSample(f.env,sample(),NOW)).status,"unchanged");
});
test("only Monday 03:15, no synthetic season or unrelated captures",async()=>{
  const f=fixture();
  const before=sample();
  assert.equal((await archiveGuestSeasonRankSample(f.env,before,
    NOW+12*3600000)).status,"outside-window");
  assert.equal((await archiveGuestSeasonRankSample(f.env,before,
    NOW+7*86400000)).status,"invalid-capture");
  assert.equal(f.ops.length,0);
  before.alliances[0].raidRank=null;
  assert.equal((await archiveGuestSeasonRankSample(f.env,before,NOW)).observed,2);
  const result=await(await publicGuestSeasonRanks(new Request(url),f.env,NOW)).json();
  assert.equal(result.snapshots[0].alliances.length,2);
});
test("revocation and unbinding hide data on the next GET",async()=>{
  const f=fixture();
  await archiveGuestSeasonRankSample(f.env,sample(),NOW);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:marines},{fingerprint:orange}]}));
  const result=await(await publicGuestSeasonRanks(new Request(url),f.env,NOW)).json();
  assert.deepEqual(result.snapshots[0].alliances.map(x=>x.nameAtCapture),
    ["MΛЯIΠΣƨ"]);
  assert.equal(result.snapshots[0].alliances[0].publicId,publicId);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const empty=await(await publicGuestSeasonRanks(new Request(url),f.env,NOW)).json();
  assert.equal(empty.snapshots.length,0);
  assert.equal((await publicGuestSeasonRanks(new Request(url+"?fingerprint="+red),
    f.env,NOW)).status,400);
});
test("expired rank samples are not returned; R2 rolling always respects 22+7 days",async()=>{
  const f=fixture();
  await archiveGuestSeasonRankSample(f.env,sample(),NOW);
  const later=await(await publicGuestSeasonRanks(new Request(url),f.env,
    NOW+23*86400000)).json();
  assert.equal(later.snapshots.length,0);
});
