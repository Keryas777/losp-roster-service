import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {archiveGuestSeasonRankSample,publicGuestSeasonRanks,
  publishVerifiedGuestSeasonRanks}
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
test("real rank samples work on any day; old or malformed sources are rejected",async()=>{
  const f=fixture(),before=sample();
  assert.equal((await archiveGuestSeasonRankSample(f.env,before,
    NOW+7*86400000)).status,"invalid-capture");
  assert.equal(f.ops.length,0);
  before.alliances[0].raidRank=null;
  assert.equal((await archiveGuestSeasonRankSample(f.env,before,NOW)).observed,2);
  const result=await(await publicGuestSeasonRanks(new Request(url),f.env,NOW)).json();
  assert.equal(result.snapshots[0].alliances.length,2);
  const afternoon=sample();
  afternoon.capturedAt="2026-11-09T15:15:00.000Z";
  assert.equal((await archiveGuestSeasonRankSample(f.env,afternoon,
    Date.parse(afternoon.capturedAt))).status,"updated");
  const latest=await(await publicGuestSeasonRanks(new Request(url),f.env,
    Date.parse(afternoon.capturedAt))).json();
  assert.equal(latest.snapshots.length,1);
  assert.equal(latest.snapshots[0].alliances.length,3);
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

const manualAt="2026-11-05T15:15:00.000Z";
function freshGuestCapture(f){
  f.store.set("roster-batches/v1/guest-season-ranks/latest.json",
    JSON.stringify({version:1,source:"/player/v1/alliance/card",
      capturedAt:manualAt,completeSessionScan:true,
      connectedAlliances:3,alliances:sample().alliances}));
}
function backfillRequest(allianceFingerprint=marines,seasonId="2026-10-11/2026-10-25",
  capturedAt=manualAt,confirmation="verified-in-game"){
  return new Request(origin+"/admin/api/guest-season-rank-backfill",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({allianceFingerprint,seasonId,
      sourceCapturedAt:capturedAt,confirmation})
  });
}
test("one-off MARINES ranks from a real November 5 source belong to October 11–25",async()=>{
  const f=fixture();freshGuestCapture(f);
  const now=Date.parse(manualAt)+20000;
  const response=await publishVerifiedGuestSeasonRanks(backfillRequest(),f.env,now);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(result,{status:"recorded",
    seasonId:"2026-10-11/2026-10-25",capturedAt:manualAt,
    warRank:111,raidRank:77});
  const projection=await(await publicGuestSeasonRanks(new Request(url),f.env,now)).json();
  assert.equal(projection.snapshots.length,1);
  assert.equal(projection.snapshots[0].collectionDayUtc,"2026-11-05");
  assert.deepEqual(projection.snapshots[0].alliances.map(a=>({
    seasonId:a.manualSeasonId,confirmation:a.seasonConfirmation,
    warRank:a.warRank,raidRank:a.raidRank})),[
    {seasonId:"2026-10-11/2026-10-25",
      confirmation:"admin-in-game",warRank:111,raidRank:77}
  ]);
  for(const secret of [marines,red,orange,"roster-batches","fingerprint"]){
    assert.ok(!JSON.stringify(projection).includes(secret));
  }
  const again=await publishVerifiedGuestSeasonRanks(backfillRequest(),f.env,now+1000);
  assert.equal((await again.json()).status,"unchanged");
  assert.equal(f.ops.filter(([type,key])=>type==="put"&&
    key==="roster-batches/v1/guest-season-ranks/rolling.json").length,1);
});
test("manual qualification requires current, approved, linked and observed rank",async()=>{
  const f=fixture();freshGuestCapture(f);
  const now=Date.parse(manualAt)+20000;
  const rejected=[
    [backfillRequest(marines,"2026-11-08/2026-11-22"),409],
    [backfillRequest(marines,"2026-10-11/2026-10-25",
      "2026-11-04T15:15:00.000Z"),409],
    [backfillRequest(marines,"2026-10-11/2026-10-25",
      manualAt,"not-confirmed"),400],
    [backfillRequest(fp("not-approved")),403]
  ];
  for(const [request,code] of rejected){
    assert.equal((await publishVerifiedGuestSeasonRanks(request,f.env,now)).status,code);
  }
  assert.equal((await publishVerifiedGuestSeasonRanks(backfillRequest(),f.env,
    now+25*3600000)).status,409,"stale source must not be relabelled");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:marines}]}));
  f.store.delete("roster-batches/v1/trophy-history/rolling.json");
  assert.equal((await publishVerifiedGuestSeasonRanks(backfillRequest(),f.env,
    now)).status,409,"missing public identity must not create unlinked data");
  assert.equal(f.ops.filter(([kind])=>kind==="put").length,0);
});
test("manual record remains when a new completed season is captured on Monday",async()=>{
  const f=fixture();freshGuestCapture(f);
  const now=Date.parse(manualAt)+20000;
  await publishVerifiedGuestSeasonRanks(backfillRequest(),f.env,now);
  const monday=await archiveGuestSeasonRankSample(f.env,sample(),NOW);
  assert.equal(monday.status,"updated");
  const report=await(await publicGuestSeasonRanks(new Request(url),f.env,NOW)).json();
  assert.deepEqual(report.snapshots.map(s=>s.collectionDayUtc),
    ["2026-11-05","2026-11-09"]);
  assert.equal(report.snapshots[0].alliances[0].manualSeasonId,
    "2026-10-11/2026-10-25");
  assert.equal(report.snapshots[1].alliances[0].manualSeasonId,undefined);
});
