import test from "node:test";
import assert from "node:assert/strict";
import {archiveGuestEvolutionTick,secureGuestEvolution} from "../src/secure-guest-evolution.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
const fp="b".repeat(64),signed="v1."+"Y".repeat(55)+"."+"Z".repeat(43);
const runId="11111111-2222-3333-4444-555555555555";
const sunday=Date.parse("2026-11-08T22:00:00Z");
const captured="2026-11-08T15:45:00Z";
function fixture(){
  const objects=new Map();
  objects.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[{
    fingerprint:fp,allianceKey:"marines"}]}));
  objects.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[{
    fingerprint:"a".repeat(64),name:"Zeus"}]}));
  const root="roster-batches/v1/"+fp+"/";
  objects.set(root+"latest-complete.json",JSON.stringify({
    version:1,fingerprint:fp,runId,membershipDigest:"d".repeat(64),
    total:1,coMembers:0,observedMembers:1,includesPersonal:true,
    coverage:"all-members",notSharedCount:0,capturedAt:captured,
    expiresAt:"2026-11-15T15:45:00Z"}));
  objects.set(root+runId+"/member-self.json",JSON.stringify({
    version:1,allianceFingerprint:fp,runId,memberIndex:"self",
    kind:"private-staged-personal-roster",name:"Marine",volatileMemberId:"internal",
    capturedAt:"2026-11-08T15:40:00Z",expiresAt:"2026-11-15T15:45:00Z",
    characters:[{id:"Blob",power:1000100,level:110,gearTier:19,
      activeYellow:7,activeRed:8,basic:7,special:7,
      iso8:"0,0,0,0,0,0,raider,5,0,0,0,0"}]}));
  objects.set(root+"campaigns/2026-11-08-pm-infos.json",JSON.stringify({
    version:1,kind:"alliance-infos-campaign",campaign:"2026-11-08-pm",
    allianceFingerprint:fp,capturedAt:"2026-11-08T16:00:00Z",
    expiresAt:"2026-11-15T16:00:00Z",
    rows:[{name:"Marine",rosterShare:true}]}));
  const env={CAPTAIN_BUCKET:{
    get:async key=>objects.has(key)?{size:objects.get(key).length,
      text:async()=>objects.get(key)}:null,
    put:async(key,data)=>{objects.set(key,data);}
  },LOSP_AUTH:{fetch:async()=>Response.json({ok:true,signedSession:true,
    role:"guest",groupKey:"marines",allowedAlliances:["marines"]})}};
  return {env,objects,root};
}
function req(view="index",options={}){
  return new Request("https://example.invalid/api/secure/guest-evolution?"+
    new URLSearchParams({alliance:"marines",view,...options}),{
      headers:{Origin:"https://keryas777.github.io",
        Authorization:"Bearer "+signed}});
}
test("weekly checkpoint uses actual captured Sunday roster and signed tenant",async()=>{
  const f=fixture();
  const tick=await archiveGuestEvolutionTick(f.env,sunday);
  assert.equal(tick.status,"checkpoint-ready");
  const archived=JSON.parse(f.objects.get(
    "roster-batches/v1/guest-evolution/"+fp+"/rolling.json"));
  assert.equal(archived.checkpoints[0].sourceCapturedAt,captured);
  const res=await secureGuestEvolution(req(),f.env,sunday);
  assert.equal(res.status,200);
  const body=await res.json();
  assert.deepEqual(body.index.checkpoints.map(x=>x.date),["2026-11-08"]);
  assert.equal(body.index.players.g_marines__marine.name,"Marine");
  const group=await(await secureGuestEvolution(req("group",
    {date:"2026-11-08"}),f.env,sunday)).json();
  assert.equal(group.group.players[0].totalPower,1000100);
  const detail=await(await secureGuestEvolution(req("player",
    {date:"2026-11-08",playerKey:"g_marines__marine"}),
    f.env,sunday)).json();
  assert.equal(detail.snapshot.chars.blob.abilities.special,7);
  assert.equal(detail.snapshot.iso.blob.isoClass,"raider");
  assert.doesNotMatch(JSON.stringify(detail),/volatileMemberId/);
});
test("consent withdrawal hides past snapshots, no retrofit",async()=>{
  const f=fixture();
  await archiveGuestEvolutionTick(f.env,sunday);
  f.objects.set(f.root+"campaigns/2026-11-09-am-infos.json",
    JSON.stringify({version:1,kind:"alliance-infos-campaign",
      campaign:"2026-11-09-am",allianceFingerprint:fp,
      capturedAt:"2026-11-09T08:00:00Z",
      expiresAt:"2026-11-16T08:00:00Z",
      rows:[{name:"Marine",rosterShare:false}]}));
  const date=Date.parse("2026-11-09T10:00:00Z");
  const body=await(await secureGuestEvolution(req(),f.env,date)).json();
  assert.equal(Object.keys(body.index.players).length,0);
  const rotated=await archiveGuestEvolutionTick(f.env,date);
  assert.equal(rotated.status,"refreshed");
  const saved=JSON.parse(f.objects.get(
    "roster-batches/v1/guest-evolution/"+fp+"/rolling.json"));
  assert.equal(saved.checkpoints.length,0);
});
test("invalid session and forbidden origin do not read guest history",async()=>{
  const f=fixture();
  const request=req();
  const invalid=new Request(request.url,{headers:{Origin:"https://keryas777.github.io"}});
  assert.equal((await secureGuestEvolution(invalid,f.env,sunday)).status,401);
  const origin=new Request(request.url,{headers:{
    Origin:"https://untrusted.example",Authorization:"Bearer "+signed}});
  assert.equal((await secureGuestEvolution(origin,f.env,sunday)).status,403);
});

test("Sunday checkpoint is refused when the only real roster is from Saturday",async()=>{
  const f=fixture();
  const name=f.root+"latest-complete.json";
  const record=JSON.parse(f.objects.get(name));
  record.capturedAt="2026-11-07T15:45:00Z";
  f.objects.set(name,JSON.stringify(record));
  const memberKey=f.root+runId+"/member-self.json";
  const member=JSON.parse(f.objects.get(memberKey));
  member.capturedAt="2026-11-07T15:40:00Z";
  f.objects.set(memberKey,JSON.stringify(member));
  const tick=await archiveGuestEvolutionTick(f.env,sunday);
  assert.equal(tick.status,"roster-not-ready");
  assert.equal(f.objects.has("roster-batches/v1/guest-evolution/"+
    fp+"/rolling.json"),false);
});
