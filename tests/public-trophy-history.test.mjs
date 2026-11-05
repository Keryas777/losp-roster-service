import test from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {BATCH_PREFIX,trophyCardKey} from "../src/private-roster-batches.js";
import {archiveTrophyHistory,publicTrophyHistory,readTrophyCard}
  from "../src/public-trophy-history.js";

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const day="2026-11-05",campaign=day+"-am";
const fp=s=>createHash("sha256").update(s).digest("hex");
const losp=fp("aid-zeus"),guest=fp("aid-marines");
const NOW=Date.parse(day+"T03:25:00Z");
function fixture(){
  const data=new Map(),ops=[];
  data.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:losp,name:"Zeus"}]}));
  data.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:guest}]}));
  const bucket={
    get:async k=>{ops.push(["get",k]);return data.has(k)?
      {text:async()=>data.get(k),size:data.get(k).length}:null;},
    put:async(k,v)=>{ops.push(["put",k]);data.set(k,v);}
  };
  return {data,ops,bucket,env:{CAPTAIN_BUCKET:bucket}};
}
function source(f,aid,name,trophies,time=day+"T02:08:00Z"){
  const key=BATCH_PREFIX+f+
    "/01234567-89ab-cdef-0123-456789abcdef/provider-source/"+
    "00000000-aaaa-4bbb-8ccc-111111111111/alliance-card.json";
  const marker={version:1,kind:"trophy-card-ready",fingerprint:f,
    campaign,capturedAt:time,sourceKey:key};
  const raw={version:1,kind:"private-provider-source",allianceFingerprint:f,
    endpoint:"/player/v1/alliance/card",httpStatus:200,capturedAt:time,
    providerResponse:{data:{id:aid+":v1",name,warTrophies:trophies,
      warRank:200,raidRank:50,secret:"NEVER_PUBLISH_PRIVATE"}}};
  return {key,marker,raw};
}
function add(f,entry,sourceFp){
  f.data.set(trophyCardKey(sourceFp,campaign),JSON.stringify(entry.marker));
  f.data.set(entry.key,JSON.stringify(entry.raw));
}
const url="https://losp-roster-service.deliriousfan7.workers.dev/api/public/trophy-history";
const slot={date:day,campaign};

test("publishes actual LoSP and connected, approved guest trophies without fingerprints",async()=>{
  const f=fixture();
  add(f,source(losp,"aid-zeus","Zeus",3010),losp);
  add(f,source(guest,"aid-marines","MARINES",2190),guest);
  const archived=await archiveTrophyHistory(f.env,slot,NOW);
  assert.deepEqual(archived,{status:"updated",observed:2,expected:2,complete:true});
  const res=await publicTrophyHistory(new Request(url),f.env,NOW);
  assert.equal(res.status,200);
  const publicData=await res.json();
  assert.equal(publicData.snapshots.length,1);
  assert.deepEqual(publicData.snapshots[0].alliances.map(a=>a.warTrophies)
    .sort((a,b)=>a-b),[2190,3010]);
  assert.deepEqual(publicData.snapshots[0].alliances.map(a=>a.nameAtCapture)
    .sort(),["MARINES","Zeus"]);
  assert.equal(publicData.snapshots[0].coverage.complete,true);
  const json=JSON.stringify(publicData);
  for(const privateString of [losp,guest,"aid-zeus","aid-marines",
    "NEVER_PUBLISH_PRIVATE","provider-source","accessToken"]){
    assert.ok(!json.includes(privateString),privateString);
  }
  assert.equal(res.headers.get("Access-Control-Allow-Origin"),"*");
  assert.equal(await archiveTrophyHistory(f.env,slot,NOW).then(r=>r.status),
    "unchanged");
});
test("missing guest card never blocks a real LoSP reading; later card completes it",async()=>{
  const f=fixture();
  add(f,source(losp,"aid-zeus","Zeus",3000),losp);
  const first=await archiveTrophyHistory(f.env,slot,NOW);
  assert.equal(first.status,"updated");
  assert.equal(first.complete,false);
  let response=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.equal(response.snapshots[0].alliances.length,1);
  add(f,source(guest,"aid-marines","MARINES",2250,day+"T02:15:00Z"),guest);
  const second=await archiveTrophyHistory(f.env,slot,NOW);
  assert.equal(second.complete,true);
  response=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.equal(response.snapshots[0].alliances.length,2);
  assert.equal(response.snapshots.length,1);
});
test("forged source identity or fake/stale marker cannot create trophy points",async()=>{
  const f=fixture();
  const forged=source(losp,"different-id","Zeus",7777);
  add(f,forged,losp);
  assert.equal(await readTrophyCard(f.bucket,losp,day,NOW),null);
  assert.equal((await archiveTrophyHistory(f.env,slot,NOW)).status,"awaiting-cards");
  forged.raw.providerResponse.data.id="aid-zeus:v1";
  forged.marker.capturedAt=day+"T04:01:00Z";
  add(f,forged,losp);
  assert.equal(await readTrophyCard(f.bucket,losp,day,NOW),null);
});
test("unapproved guest is excluded; no collection or private provider requests on GET",async()=>{
  const f=fixture();
  f.data.delete(GUEST_APPROVAL_KEY);
  add(f,source(losp,"aid-zeus","Zeus",3000),losp);
  add(f,source(guest,"aid-marines","MARINES",2200),guest);
  const report=await archiveTrophyHistory(f.env,slot,NOW);
  assert.equal(report.expected,1);
  assert.equal(report.observed,1);
  const before=f.ops.length;
  const payload=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.equal(payload.snapshots[0].alliances.length,1);
  assert.ok(f.ops.slice(before).every(([op])=>op==="get"));
  assert.equal((await publicTrophyHistory(new Request(url+"?fingerprint=foo"),f.env,NOW)).status,400);
  assert.equal((await publicTrophyHistory(new Request(url,{method:"POST"}),f.env,NOW)).status,405);
});

test("guest approval revocation hides earlier readings immediately without a cron",async()=>{
  const f=fixture();
  add(f,source(losp,"aid-zeus","Zeus",3000),losp);
  add(f,source(guest,"aid-marines","MARINES",2280),guest);
  assert.equal((await archiveTrophyHistory(f.env,slot,NOW)).observed,2);
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const response=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.deepEqual(response.snapshots[0].alliances.map(a=>a.nameAtCapture),["Zeus"]);
});
