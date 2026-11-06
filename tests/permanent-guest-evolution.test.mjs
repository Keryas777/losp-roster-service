import test from "node:test";
import assert from "node:assert/strict";
import {archivePermanentGuestEvolutionTick,securePermanentGuestEvolution}
  from "../src/permanent-guest-evolution.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const fp="b".repeat(64),r2Base="roster-batches/v1/";
const signature="v1."+"X".repeat(45)+"."+"Y".repeat(43);
const origin="https://keryas777.github.io";
const date1="2026-11-08",date2="2026-12-20";
const first=Date.parse("2026-11-08T22:00:00Z");
const second=Date.parse("2026-12-20T22:00:00Z");
const checkpoint=(date,power)=>({date,
  sourceCapturedAt:date+"T15:45:00Z",
  players:[{player:"Shared",alliance:"marines",
    chars:{blob:{power,level:110,abilities:{basic:7}}},
    iso:{blob:{isoClass:"raider"}}}]});
function make(){
  const objects=new Map(),writes=[];
  objects.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:fp,allianceKey:"marines"}]}));
  objects.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const bucket={
    get:async key=>objects.has(key)?{size:objects.get(key).length,
      text:async()=>objects.get(key)}:null,
    put:async(key,value)=>{writes.push(key);objects.set(key,value);},
    delete:async key=>objects.delete(key)
  };
  const env={CAPTAIN_BUCKET:bucket,LOSP_AUTH:{fetch:async()=>Response.json({
    ok:true,signedSession:true,role:"guest",groupKey:"marines",
    allowedAlliances:["marines"]})}};
  const infos=(date,sharing=true)=>objects.set(r2Base+fp+
    "/campaigns/"+date+"-pm-infos.json",JSON.stringify({
      version:1,kind:"alliance-infos-campaign",
      allianceFingerprint:fp,campaign:date+"-pm",
      capturedAt:date+"T16:00:00Z",
      expiresAt:new Date(Date.parse(date+"T16:00:00Z")+7*86400000)
        .toISOString(),
      rows:[{name:"Shared",rosterShare:sharing}]
    }));
  const staged=dates=>objects.set(r2Base+"guest-evolution/"+fp+
    "/rolling.json",JSON.stringify({
      version:1,fingerprint:fp,allianceKey:"marines",
      checkpoints:dates
    }));
  const request=(view,extra={})=>new Request(
    "https://example.invalid/api/secure/guest-evolution?"+
    new URLSearchParams({alliance:"marines",view,...extra}),{
      headers:{Origin:origin,Authorization:"Bearer "+signature}});
  return {objects,writes,env,infos,staged,request};
}
test("WebApp permanent index retains Nov checkpoint at Dec checkpoint",async()=>{
  const f=make();
  f.infos(date1);f.staged([checkpoint(date1,1000)]);
  assert.equal((await archivePermanentGuestEvolutionTick(f.env,first)).status,
    "archived");
  assert.equal(f.writes.length,2);
  f.infos(date2);f.staged([checkpoint(date2,2500)]);
  assert.equal((await archivePermanentGuestEvolutionTick(f.env,second)).status,
    "archived");
  const index=JSON.parse(f.objects.get("webapp-evolution/v1/"+fp+"/index.json"));
  assert.deepEqual(index.checkpoints.map(c=>c.date),[date1,date2]);
  const response=await securePermanentGuestEvolution(f.request("index"),
    f.env,second);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.index.players.g_marines__shared.checkpoints,[date1,date2]);
  assert.equal(body.historyPolicy,"checkpoint-archive");
  const older=await securePermanentGuestEvolution(f.request("player",{
    date:date1,playerKey:"g_marines__shared"}),f.env,second);
  assert.equal(older.status,200);
  assert.equal((await older.json()).snapshot.chars.blob.power,1000);
  const newer=await securePermanentGuestEvolution(f.request("group",{date:date2}),
    f.env,second);
  assert.equal((await newer.json()).group.players[0].totalPower,2500);
});
test("latest revoked rosterShare hides all older checkpoints",async()=>{
  const f=make();f.infos(date1);f.staged([checkpoint(date1,1000)]);
  await archivePermanentGuestEvolutionTick(f.env,first);
  f.infos(date2,false);
  const response=await securePermanentGuestEvolution(f.request("index"),f.env,second);
  const body=await response.json();
  assert.equal(Object.keys(body.index.players).length,0);
  assert.equal(body.index.checkpoints.length,0);
  const detail=await securePermanentGuestEvolution(f.request("player",{
    date:date1,playerKey:"g_marines__shared"}),f.env,second);
  assert.equal((await detail.json()).snapshot,null);
});
test("unsigned sessions are denied and names are tenant-scoped",async()=>{
  const f=make();f.infos(date1);f.staged([checkpoint(date1,1000)]);
  await archivePermanentGuestEvolutionTick(f.env,first);
  const unsigned=new Request(f.request("index").url,{headers:{Origin:origin}});
  assert.equal((await securePermanentGuestEvolution(unsigned,f.env,first)).status,401);
  const wrongKey=await securePermanentGuestEvolution(f.request("player",{
    date:date1,playerKey:"g_others__shared"}),f.env,first);
  assert.equal((await wrongKey.json()).snapshot,null);
  f.env.LOSP_AUTH.fetch=async()=>Response.json({ok:true,signedSession:true,
    role:"guest",groupKey:"others",allowedAlliances:["others"]});
  assert.equal((await securePermanentGuestEvolution(f.request("index"),
    f.env,first)).status,403);
});
test("same-week replay is idempotent; no rolling auto-delete",async()=>{
  const f=make();f.infos(date1);f.staged([checkpoint(date1,1000)]);
  await archivePermanentGuestEvolutionTick(f.env,first);
  const writes=f.writes.length;
  assert.equal((await archivePermanentGuestEvolutionTick(f.env,first)).status,
    "unchanged");
  assert.equal(f.writes.length,writes);
  assert.ok([...f.objects.keys()].some(k=>k.startsWith("webapp-evolution/v1/")));
});
