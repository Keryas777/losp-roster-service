import test from "node:test";
import assert from "node:assert/strict";
import {createHash,webcrypto} from "node:crypto";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {BATCH_PREFIX,trophyCardKey} from "../src/private-roster-batches.js";
import {archiveTrophyHistory,publicTrophyHistory,readTrophyCard,
  recoverPreviousSaturdayGuestTrophies}
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
    put:async(k,v)=>{ops.push(["put",k]);data.set(k,v);},
    list:async({prefix})=>({truncated:false,objects:[...data.keys()]
      .filter(key=>key.startsWith(prefix)).map(key=>({key}))})
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
  assert.ok(publicData.snapshots[0].alliances.every(a=>
    !Object.hasOwn(a,"allianceKey")),
    "unbound guests and LoSP must not receive an inferred key");
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

test("the current approved guest WebApp key is projected only after R2 binding",async()=>{
  const f=fixture();
  add(f,source(losp,"aid-zeus","Zeus",3010),losp);
  add(f,source(guest,"aid-marines","<color=red>MARINES</color>",2280),guest);
  assert.equal((await archiveTrophyHistory(f.env,slot,NOW)).status,"updated");
  const readPublic=async()=>(await (await publicTrophyHistory(
    new Request(url),f.env,NOW)).json()).snapshots[0].alliances;
  let rows=await readPublic();
  assert.equal(rows.find(a=>a.nameAtCapture.includes("MARINES")).allianceKey,undefined);
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest,allianceKey:"marines"}]}));
  const before=f.ops.length;
  rows=await readPublic();
  assert.equal(rows.find(a=>a.nameAtCapture.includes("MARINES")).allianceKey,"marines");
  assert.equal(rows.find(a=>a.nameAtCapture==="Zeus").allianceKey,undefined);
  assert.ok(f.ops.slice(before).every(([action])=>action==="get"),
    "projection must never write, collect or contact Scopely");
  const json=JSON.stringify(rows);
  assert.ok(!json.includes(guest),"no fingerprint in public response");
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest}]}));
  rows=await readPublic();
  assert.equal(rows.find(a=>a.nameAtCapture.includes("MARINES")).allianceKey,undefined,
    "unbinding takes effect on next GET, without a new trophy capture");
});
test("eight same-name, different-colour ENDGAME guests each get a distinct R2 key",async()=>{
  const f=fixture();
  const colours=["#ee0000","#f60","#0073ff","#00a164",
    "#9900cc","#ffff00","#ffffff","#222222"];
  const slugs=["red","orange","blue","green","purple","yellow","white","black"];
  const guests=slugs.map((colour,i)=>{
    const aid="aid-endgame-"+colour, fingerprint=fp(aid);
    add(f,source(fingerprint,aid,
      "END<color="+colours[i]+">GAME R-évolution",2500+i),fingerprint);
    return {fingerprint,allianceKey:"endgame-revolution-"+colour};
  });
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:guests}));
  add(f,source(losp,"aid-zeus","Zeus",3010),losp);
  const outcome=await archiveTrophyHistory(f.env,slot,NOW);
  assert.equal(outcome.observed,9);
  assert.equal(outcome.complete,true);
  const result=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  const rows=result.snapshots[0].alliances;
  assert.equal(rows.length,9);
  assert.deepEqual(new Set(rows.map(a=>a.allianceKey).filter(Boolean)),
    new Set(guests.map(a=>a.allianceKey)));
  assert.equal(rows.find(a=>a.nameAtCapture==="Zeus").allianceKey,undefined);
  assert.equal(new Set(rows.map(a=>a.publicId)).size,9);
  assert.ok(!JSON.stringify(result).includes(guests[0].fingerprint));
});
test("guest revocation removes public readings even when a bound key still exists in old archive",async()=>{
  const f=fixture();
  add(f,source(losp,"aid-zeus","Zeus",3010),losp);
  add(f,source(guest,"aid-marines","MARINES",2280),guest);
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:guest,allianceKey:"marines"}]}));
  await archiveTrophyHistory(f.env,slot,NOW);
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const result=await (await publicTrophyHistory(new Request(url),f.env,NOW)).json();
  assert.deepEqual(result.snapshots[0].alliances.map(a=>a.nameAtCapture),["Zeus"]);
});


test("Sunday repairs only missing guest Saturday trophies using true source timestamp",async()=>{
  const f=fixture();
  const red=fp("aid-endgame-red"),orange=fp("aid-endgame-orange");
  const orangeId="11111111-2222-4333-8444-555555555555";
  const saturday="2026-11-07", observed="2026-11-07T23:09:34.879Z";
  const sunday=Date.parse("2026-11-08T10:08:00.000Z");
  const key=BATCH_PREFIX+"trophy-history/rolling.json";
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:red,allianceKey:"endgame-revolution-red"},
    {fingerprint:orange,allianceKey:"endgame-revolution-orange"}]}));
  f.data.set(key,JSON.stringify({version:1,kind:"connected-alliance-trophy-history",
    ids:{[orange]:orangeId},updatedAt:"2026-11-07T02:30:00Z",
    snapshots:[{collectionDayUtc:saturday,capturedAt:"2026-11-07T02:08:00Z",
      complete:false,expected:3,alliances:[{
        publicId:orangeId,nameAtCapture:"END<color=#f60>GAME R-évolution",
        warTrophies:2534,capturedAt:"2026-11-07T02:08:00Z"}]}]}));
  f.data.set(BATCH_PREFIX+"guest-season-ranks/captures/"+
    "2026-11-07T23-09-34-879Z-01234567-89ab-cdef-0123-456789abcdef.json",
    JSON.stringify({version:1,source:"/player/v1/alliance/card",
      capturedAt:observed,completeSessionScan:true,alliances:[
        {allianceFingerprint:red,name:"END<color=#f00>GΔME R-évolution",
          warRank:27,raidRank:14,warTrophies:3026},
        {allianceFingerprint:orange,name:"END<color=#f60>GAME R-évolution",
          warRank:1021,raidRank:842,warTrophies:2534}]}));
  const before=f.data.get(key);
  assert.equal((await recoverPreviousSaturdayGuestTrophies(
    f.env,Date.parse("2026-11-07T23:30:00Z"))).status,
    "outside-recovery-window");
  assert.equal(f.data.get(key),before);
  const result=await recoverPreviousSaturdayGuestTrophies(f.env,sunday);
  assert.deepEqual(result,{status:"updated",added:1,day:saturday});
  const response=await(await publicTrophyHistory(
    new Request(url),f.env,sunday)).json();
  assert.equal(response.snapshots.length,1);
  const rows=response.snapshots[0].alliances;
  assert.equal(rows.length,2);
  const r=rows.find(a=>a.allianceKey==="endgame-revolution-red");
  const o=rows.find(a=>a.allianceKey==="endgame-revolution-orange");
  assert.equal(r.warTrophies,3026);
  assert.equal(r.capturedAt,observed);
  assert.equal(o.warTrophies,2534);
  assert.equal(o.publicId,orangeId);
  assert.equal(o.capturedAt,"2026-11-07T02:08:00Z");
  assert.equal(response.snapshots[0].coverage.complete,false);
  const json=JSON.stringify(response);
  for(const privateId of [red,orange,"aid-endgame-red"])
    assert.ok(!json.includes(privateId));
  assert.equal((await recoverPreviousSaturdayGuestTrophies(f.env,sunday))
    .status,"unchanged","idempotent repeated cron must not alter readings");
  // Withdrawal hides recovered trophies immediately, just like normal ones.
  f.data.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:orange,allianceKey:"endgame-revolution-orange"}]}));
  const after=await(await publicTrophyHistory(
    new Request(url),f.env,sunday)).json();
  assert.deepEqual(after.snapshots[0].alliances.map(a=>a.allianceKey),
    ["endgame-revolution-orange"]);
});
