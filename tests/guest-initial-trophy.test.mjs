import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {archiveInitialGuestTrophies,publicTrophyHistory}
  from "../src/public-trophy-history.js";
import {archiveCachedInitialGuestTrophies}
  from "../src/guest-initial-sync.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const FP="a".repeat(64),LOSP="b".repeat(64);
const KEY="questionable-propriety",DATE="2026-11-07";
const GROUP_AT="2026-11-07T02:25:00Z";
const OBSERVED_AT="2026-11-08T10:43:00Z";
const NOW=Date.parse(OBSERVED_AT);
const UUID="12345678-1234-4234-8234-123456789abc";
const HISTORY="roster-batches/v1/trophy-history/rolling.json";
const RAW="roster-batches/v1/guest-initial-sync/"+FP+"-card.json";
const url="https://losp-roster-service.deliriousfan7.workers.dev/api/public/trophy-history";

function fixture({withGroup=true}={}){
  const records=new Map(),writes=[];
  records.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:LOSP,name:"Zeus"}]}));
  records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY}]}));
  if(withGroup)records.set(HISTORY,JSON.stringify({version:1,
    kind:"connected-alliance-trophy-history",ids:{[LOSP]:UUID},
    updatedAt:GROUP_AT,snapshots:[{collectionDayUtc:DATE,
      capturedAt:GROUP_AT,complete:true,expected:1,
      alliances:[{publicId:UUID,nameAtCapture:"Zeus",
        capturedAt:GROUP_AT,warTrophies:3000}]}]}));
  const bucket={
    get:async k=>records.has(k)?{text:async()=>records.get(k),
      size:records.get(k).length}:null,
    put:async(k,data)=>{writes.push(k);records.set(k,data);}
  };
  const observation={
    fingerprint:FP,allianceKey:KEY,nameAtCapture:"Questionable Propriety",
    capturedAt:OBSERVED_AT,warTrophies:2710
  };
  return {records,writes,env:{CAPTAIN_BUCKET:bucket},observation};
}

test("first guest trophies are grouped on last actual common day, but keep actual observation time",async()=>{
  const f=fixture();
  const result=await archiveInitialGuestTrophies(f.env,f.observation,NOW);
  assert.equal(result.status,"updated");
  assert.equal(result.collectionDayUtc,DATE);
  assert.equal(result.actualCapturedAt,OBSERVED_AT);
  const archived=JSON.parse(f.records.get(HISTORY));
  assert.equal(archived.snapshots.length,1);
  const snap=archived.snapshots[0];
  assert.equal(snap.collectionDayUtc,DATE);
  assert.equal(snap.capturedAt,GROUP_AT);
  assert.equal(snap.alliances.length,2);
  assert.equal(snap.complete,false);
  assert.equal(snap.expected,2);
  const original=snap.alliances.find(a=>a.publicId===UUID);
  assert.deepEqual(original,{publicId:UUID,nameAtCapture:"Zeus",
    capturedAt:GROUP_AT,warTrophies:3000});
  const guest=snap.alliances.find(a=>a.publicId!==UUID);
  assert.equal(guest.warTrophies,2710);
  assert.equal(guest.capturedAt,OBSERVED_AT);
  assert.equal(guest.attribution,"initial-sync-later-observation");
  const visible=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.equal(visible.snapshots.length,1);
  assert.equal(visible.snapshots[0].collectionDayUtc,DATE);
  assert.equal(visible.snapshots[0].capturedAt,GROUP_AT);
  assert.equal(visible.snapshots[0].alliances.find(a=>a.allianceKey===KEY).warTrophies,2710);
  assert.equal(visible.snapshots[0].alliances.find(a=>a.allianceKey===KEY).capturedAt,OBSERVED_AT);
  assert.doesNotMatch(JSON.stringify(visible),/a{64}|b{64}|oauth|token/);
});

test("repeat cannot replace a previous grouped point or alter other alliances",async()=>{
  const f=fixture();
  assert.equal((await archiveInitialGuestTrophies(f.env,f.observation,NOW)).status,"updated");
  const original=f.records.get(HISTORY);
  const second=await archiveInitialGuestTrophies(f.env,{
    ...f.observation,warTrophies:9999
  },NOW);
  assert.equal(second.status,"already-recorded");
  assert.equal(f.records.get(HISTORY),original);
  assert.equal(f.writes.length,1);
});

test("no real grouped collection, revoked guest, invalid or future samples fail closed",async()=>{
  const f=fixture({withGroup:false});
  assert.equal((await archiveInitialGuestTrophies(f.env,f.observation,NOW)).status,
    "awaiting-grouped-capture");
  assert.equal(f.writes.length,0);
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  assert.equal((await archiveInitialGuestTrophies(f.env,f.observation,NOW)).status,
    "not-approved-and-bound");
  assert.equal((await archiveInitialGuestTrophies(f.env,{
    ...f.observation,capturedAt:"2026-11-09T00:00:00Z"
  },NOW)).status,"invalid-observation");
  assert.equal(f.writes.length,0);
});

test("retry uses cached Scopely first card, never another provider request",async()=>{
  const f=fixture();
  f.records.set(RAW,JSON.stringify({version:1,fingerprint:FP,
    allianceKey:KEY,source:"/player/v1/alliance/card",
    nameAtCapture:f.observation.nameAtCapture,
    capturedAt:OBSERVED_AT,warTrophies:2710}));
  assert.equal((await archiveCachedInitialGuestTrophies(f.env,FP,KEY,NOW)).status,
    "updated");
  assert.equal((await archiveCachedInitialGuestTrophies(f.env,FP,KEY,NOW)).status,
    "already-recorded");
  assert.equal((await archiveCachedInitialGuestTrophies(f.env,FP,
    "endgame-revolution-red",NOW)).status,"awaiting-card");
});
