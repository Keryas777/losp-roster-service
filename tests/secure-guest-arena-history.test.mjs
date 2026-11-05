import test from "node:test";
import assert from "node:assert/strict";
import {secureGuestArenaHistory} from "../src/secure-guest-arena-history.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const guest="b".repeat(64),other="c".repeat(64),losp="a".repeat(64);
const signed="v1."+"Z".repeat(55)+"."+"Y".repeat(43);
const SITE="https://keryas777.github.io";
const URL="https://losp-roster-service.deliriousfan7.workers.dev/api/secure/guest-arena-history";
const now=Date.parse("2026-11-05T17:47:00Z");
const date="2026-11-05";
const secret="DO_NOT_EXPOSE_PRIVATE";
const player="MARINE PLAYER";
function create(){
  const records=new Map(),reads=[];
  records.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:losp,name:"Zeus"}]}));
  records.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:guest,allianceKey:"marines"}]}));
  const bucket={
    get:async key=>{reads.push(key);return records.has(key)?
      {size:records.get(key).length,text:async()=>records.get(key)}:null;},
    put:async()=>{throw Error("read-only guest API must never write");}
  };
  const env={CAPTAIN_BUCKET:bucket,
    LOSP_AUTH:{fetch:async()=>{throw Error("tests inject signed auth mock");}}};
  return {records,reads,bucket,env};
}
const receipt=(fp,alliance,people)=>JSON.stringify({
  version:1,kind:"alliance-infos-reward",allianceFingerprint:fp,
  campaign:date+"-reward",allianceName:alliance,
  capturedAt:date+"T16:05:19Z",expiresAt:"2026-11-12T16:05:19Z",
  observedAt:people.map(p=>({name:p.name,at:date+"T16:05:17Z"})),
  rows:people.map(p=>({name:p.name,latestArena:p.rank})),
  accessToken:secret
});
const key=(fp,day=date)=>"roster-batches/v1/"+fp+
  "/campaigns/"+day+"-reward-infos.json";
function request(alliances="marines",bearer=signed,origin=SITE){
  return new Request(URL+"?alliances="+encodeURIComponent(alliances),{
    headers:{Origin:origin,Authorization:"Bearer "+bearer}
  });
}
function validAuth(role="guest",keys=["marines"],group="marines"){
  return {ok:true,signedSession:true,role,groupKey:group,allowedAlliances:keys};
}
const auth=(data=validAuth(),spy=[])=>async(url,options)=>{
  spy.push({url,options});
  assert.equal(url,"https://losp-auth.deliriousfan7.workers.dev/signed-access");
  assert.equal(options.headers.Authorization,"Bearer "+signed);
  return Response.json(data);
};
test("signed Discord MARINES gets only its 24 actual ranks, before archived R2 history",async()=>{
  const f=create(),calls=[];
  f.records.set(key(guest),receipt(guest,"MΛЯIΠΣƧ",
    Array.from({length:24},(_,i)=>({name:player+" "+i,rank:i+1}))));
  const res=await secureGuestArenaHistory(request(),f.env,now,auth(validAuth(),calls));
  assert.equal(res.status,200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"),SITE);
  assert.equal(res.headers.get("Cache-Control"),"private, no-store");
  const json=await res.json();
  assert.equal(json.status,"ok");
  assert.equal(json.snapshots.length,1);
  assert.equal(json.snapshots[0].date,date);
  assert.equal(json.snapshots[0].players.length,24);
  assert.equal(json.snapshots[0].players[0].alliance,"marines");
  assert.equal(json.snapshots[0].players[0].arenaRank,1);
  const raw=JSON.stringify(json);
  for(const forbidden of [guest,losp,secret,"accessToken","roster-batches/v1/",
    "allianceFingerprint","oauth"])assert.ok(!raw.includes(forbidden),forbidden);
  assert.equal(calls.length,1);
  assert.ok(f.reads.every(k=>!k.includes("/player/v1")));
});
test("already archived, tenant-tagged guest ranks survive source receipt expiry",async()=>{
  const f=create();
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",
    JSON.stringify({version:1,snapshots:[
      {date:"2026-11-02",sourceDay:"2026-11-02",sourceKind:"reward",
        players:[{name:"Veteran",alliance:"MΛЯIΠΣƧ",allianceKey:"marines",
          arenaRank:23},{name:"Other",alliance:"Other",allianceKey:"other",
          arenaRank:10}]}
    ]}));
  const data=await (await secureGuestArenaHistory(request(),f.env,now,auth())).json();
  assert.deepEqual(data.snapshots.map(s=>s.date),["2026-11-02"]);
  assert.deepEqual(data.snapshots[0].players.map(p=>p.name),["Veteran"]);
});
test("old MARINES archive is recognized ONLY with same original receipt proof",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MΛЯIΠΣƧ",
    [{name:"Actual Player",rank:17}]));
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",
    JSON.stringify({version:1,snapshots:[{date,sourceDay:date,sourceKind:"reward",
      players:[{name:"Actual Player",alliance:"MΛЯIΠΣƧ",arenaRank:17},
        {name:"Unproven",alliance:"MΛЯIΠΣƧ",arenaRank:18},
        {name:"Not Marines",alliance:"Another",arenaRank:17}]}]}));
  const response=await secureGuestArenaHistory(request(),f.env,now,auth());
  const data=await response.json();
  assert.deepEqual(data.snapshots[0].players.map(p=>p.name),["Actual Player"]);
});
test("unauthorized access fails closed BEFORE private R2, including forged legacy session",async()=>{
  const f=create();
  const attempted=await secureGuestArenaHistory(
    request("marines","eyJpZCI6IjMwMDMwNTYyNjkyNjQxNTg3NCJ9"),f.env,now,
    async()=>{throw Error("no verification for unsigned");});
  assert.equal(attempted.status,401);
  assert.equal(f.reads.length,0);
  const denied=await secureGuestArenaHistory(request(),f.env,now,
    auth({...validAuth(),signedSession:false}));
  assert.equal(denied.status,401);
  assert.equal(f.reads.length,0);
  const lospRole=await secureGuestArenaHistory(request(),f.env,now,
    auth(validAuth("member",["zeus"],"losp")));
  assert.equal(lospRole.status,401);
  assert.equal(f.reads.length,0);
});
test("a guest never accesses another guest, even with client-supplied selectors",async()=>{
  const f=create();
  for(const keys of ["other","marines,other"]){
    const res=await secureGuestArenaHistory(request(keys),f.env,now,auth());
    assert.equal(res.status,403);
    assert.equal(f.reads.length,0);
  }
});
test("approval revocation, missing public binding and LoSP precedence fail closed",async()=>{
  const f=create();
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  let res=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(res.status,409);
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:guest}]}));
  res=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(res.status,409);
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:losp,allianceKey:"marines"}]}));
  res=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(res.status,409);
});
test("legacy guest names are NOT guessed when multiple tenant approvals exist",async()=>{
  const f=create();
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:guest,allianceKey:"marines"},
      {fingerprint:other,allianceKey:"somewhere"}]}));
  f.records.set(key(guest),receipt(guest,"SAME NAME",
    [{name:"Colliding",rank:5}]));
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",
    JSON.stringify({version:1,snapshots:[{date,sourceDay:date,sourceKind:"reward",
      players:[{name:"Colliding",alliance:"SAME NAME",arenaRank:5}]}]}));
  const data=await(await secureGuestArenaHistory(request(),f.env,now,auth())).json();
  // The current-day verified receipt is safe; the legacy row is not.
  assert.equal(data.snapshots.length,1);
  assert.deepEqual(data.snapshots[0].players.map(p=>p.name),["Colliding"]);
});
test("strict GET/CORS, no token in URL, and admin preview still verifies real signed role",async()=>{
  const f=create();
  const preflight=await secureGuestArenaHistory(new Request(URL,{method:"OPTIONS",
    headers:{Origin:SITE,"Access-Control-Request-Headers":"authorization"}}),f.env,now);
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"),"Authorization");
  assert.equal((await secureGuestArenaHistory(new Request(URL,{method:"OPTIONS",
    headers:{Origin:"https://evil.example"}}),f.env,now)).status,403);
  assert.equal((await secureGuestArenaHistory(new Request(URL,{method:"POST"}),
    f.env,now)).status,405);
  assert.equal((await secureGuestArenaHistory(request("marines","invalid",
    "https://evil.example"),f.env,now)).status,403);
  const admin=await secureGuestArenaHistory(request(),f.env,now,
    auth(validAuth("admin",["zeus","marines"],"all")));
  assert.equal(admin.status,200);
});

test("missing trusted service binding fails closed before any R2 read",async()=>{
  const f=create();
  delete f.env.LOSP_AUTH;
  const res=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(res.status,503);
  assert.equal((await res.json()).status,"auth-unavailable");
  assert.equal(f.reads.length,0);
});

test("signed admin dynamically sees only approved and bound guests (no ENDGAME placeholder)",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MΛЯIΠΣƧ",
    Array.from({length:24},(_,i)=>({name:"Marine "+(i+1),rank:i+1}))));
  const signedAdmin=validAuth("admin",[
    "zeus","marines","endgame-revolution-red","endgame-revolution-orange"],"all");
  const res=await secureGuestArenaHistory(
    request("approved"),f.env,now,auth(signedAdmin));
  assert.equal(res.status,200);
  const data=await res.json();
  assert.equal(data.snapshots.length,1);
  assert.equal(data.snapshots[0].players.length,24);
  assert.ok(data.snapshots[0].players.every(p=>p.alliance==="marines"));
  assert.ok(!JSON.stringify(data).includes(guest));
});
test("signed admin approved selector responds only with the currently approved list",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MARINES",[{name:"Ranked",rank:20}]));
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const res=await secureGuestArenaHistory(request("approved"),f.env,now,
    auth(validAuth("admin",["marines"],"all")));
  assert.equal(res.status,200);
  const data=await res.json();
  assert.deepEqual(data.snapshots,[]);
  assert.ok(f.reads.every(k=>!k.includes("/campaigns/")));
});
test("guest sessions cannot enumerate every approved alliance",async()=>{
  const f=create();
  const res=await secureGuestArenaHistory(request("approved"),f.env,now,
    auth(validAuth("guest",["marines"],"marines")));
  assert.equal(res.status,403);
  assert.equal(f.reads.length,0);
});
test("admin list is intersected with actual signed allowedAlliances, not browser preview",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MARINES",[{name:"Ranked",rank:20}]));
  const res=await secureGuestArenaHistory(request("approved"),f.env,now,
    auth(validAuth("admin",["zeus"],"all")));
  assert.equal(res.status,200);
  const body=await res.json();
  assert.deepEqual(body.snapshots,[]);
});
