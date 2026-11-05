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
  rows:people.map(p=>({name:p.name,latestArena:p.rank,
    ...(p.icon!==undefined?{icon:p.icon}:{}),
    ...(p.frame!==undefined?{frame:p.frame}:{})})),
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
const auth=(data=validAuth(),spy=[])=>async(internalRequest)=>{
  assert.ok(internalRequest instanceof Request,
    "Service binding must receive a full internal Request");
  spy.push(internalRequest);
  assert.equal(internalRequest.url,"https://losp-auth.internal/signed-access");
  assert.equal(internalRequest.method,"GET");
  assert.equal(internalRequest.headers.get("Authorization"),"Bearer "+signed);
  assert.equal(internalRequest.headers.get("Accept"),"application/json");
  assert.equal(internalRequest.redirect,"manual");
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
  const failure=await res.json();
  assert.equal(failure.status,"auth-unavailable");
  assert.equal(failure.reason,"auth-binding-missing");
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

test("unavailable old archive never blocks validated 24 latest MARINES receipts",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MΛЯIΠΣƧ",
    Array.from({length:24},(_,i)=>({name:"Marine "+i,rank:i+1}))));
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",
    "{corrupt archive");
  const response=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.archiveWarning,"archive-unavailable");
  assert.equal(body.snapshots.length,1);
  assert.equal(body.snapshots[0].players.length,24);
  assert.ok(body.snapshots[0].players.every(p=>p.alliance==="marines"));
  assert.equal(body.snapshots[0].date,date);
});
test("invalid archive shape is ignored without accepting unverified historical ranks",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MARINES",[{name:"Today",rank:4}]));
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",
    JSON.stringify({version:2,snapshots:[{date:"2026-11-01",
      players:[{name:"Invented",allianceKey:"marines",arenaRank:1}]}]}));
  const body=await(await secureGuestArenaHistory(request(),f.env,now,auth())).json();
  assert.equal(body.archiveWarning,"archive-invalid");
  assert.deepEqual(body.snapshots.map(s=>s.date),[date]);
  assert.deepEqual(body.snapshots[0].players.map(p=>p.name),["Today"]);
  assert.doesNotMatch(JSON.stringify(body),/Invented/);
});
test("R2 registry faults return an actionable safe reason without exposing identifiers",async()=>{
  const f=create();
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:2,alliances:[]}));
  const res=await secureGuestArenaHistory(request("approved"),f.env,now,
    auth(validAuth("admin",["marines"],"all")));
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.reason,"approval-registry-invalid");
  assert.doesNotMatch(JSON.stringify(body),new RegExp(guest));
});
test("trusted Worker binding is used for an actual signed-access request",async()=>{
  const f=create(),calls=[];
  f.env.LOSP_AUTH={fetch:async(internalRequest)=>{
    assert.ok(internalRequest instanceof Request);
    calls.push(internalRequest);
    return Response.json(validAuth());
  }};
  const res=await secureGuestArenaHistory(request(),f.env,now);
  assert.equal(res.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"https://losp-auth.internal/signed-access");
  assert.equal(calls[0].headers.get("Authorization"),"Bearer "+signed);
  assert.equal(calls[0].redirect,"manual");
});
test("upstream auth service failure is distinguishable from a missing R2 receipt",async()=>{
  const f=create();
  f.env.LOSP_AUTH={fetch:async()=>new Response(null,{status:503})};
  const res=await secureGuestArenaHistory(request(),f.env,now);
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.status,"auth-unavailable");
  assert.equal(body.reason,"auth-service-error");
  assert.equal(f.reads.length,0);
});

test("service binding never contacts the public workers.dev endpoint or exposes a token in URL",async()=>{
  const f=create(),seen=[];
  f.env.LOSP_AUTH={fetch:async request=>{
    seen.push(request);
    return Response.json(validAuth());
  }};
  const result=await secureGuestArenaHistory(request(),f.env,now);
  assert.equal(result.status,200);
  assert.equal(seen.length,1);
  assert.equal(new globalThis.URL(seen[0].url).hostname,"losp-auth.internal");
  assert.equal(new globalThis.URL(seen[0].url).pathname,"/signed-access");
  assert.ok(!seen[0].url.includes(signed));
  assert.equal(seen[0].headers.get("Origin"),null);
  assert.equal(seen[0].headers.get("Cookie"),null);
});
test("service binding invocation throw remains fail-closed before reading private R2",async()=>{
  const f=create();
  f.env.LOSP_AUTH={fetch:async request=>{
    assert.ok(request instanceof Request);
    throw new TypeError("synthetic binding failure");
  }};
  const res=await secureGuestArenaHistory(request(),f.env,now);
  assert.equal(res.status,503);
  assert.equal((await res.json()).reason,"auth-service-unreachable");
  assert.equal(f.reads.length,0);
});


const portrait="https://assets.marvelstrikeforce.com/imgs/Portrait_Test_0123abcd.png";
const frame="https://assets.marvelstrikeforce.com/imgs/ICON_FRAME_Test_aabbcc11.png";
test("MARINES gets original Scopely portrait/frame for all 24 Arena members",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MΛЯIΠΣƧ",
    Array.from({length:24},(_,i)=>({
      name:"Marine "+i,rank:i+1,icon:portrait,frame
    }))));
  const response=await secureGuestArenaHistory(request(),f.env,now,auth());
  assert.equal(response.status,200);
  const data=await response.json();
  assert.deepEqual(data.alliances,["marines"]);
  assert.equal(data.snapshots[0].players.length,24);
  assert.equal(data.profiles.length,24);
  for(const p of data.profiles){
    assert.equal(p.alliance,"marines");
    assert.equal(p.icon,portrait);
    assert.equal(p.frame,frame);
    assert.ok(!Object.hasOwn(p,"arenaRank"),"Only media is in profiles");
  }
  assert.equal(data.snapshots[0].players[0].icon,portrait);
  assert.equal(data.snapshots[0].players[0].frame,frame);
  const raw=JSON.stringify(data);
  for(const forbidden of ["allianceFingerprint","accessToken",secret,
    guest,losp,"roster-batches/v1/"]){
    assert.ok(!raw.includes(forbidden),forbidden);
  }
});
test("only the official asset host and safe images path can appear in guest profile",async()=>{
  const f=create();
  f.records.set(key(guest),receipt(guest,"MARINES",[
    {name:"Valid",rank:1,icon:portrait,frame},
    {name:"Offhost",rank:2,icon:"https://attacker.test/imgs/Portrait.png",
      frame:"javascript:alert(1)"},
    {name:"PathTraversal",rank:3,
      icon:"https://assets.marvelstrikeforce.com/../../secrets",
      frame:"https://assets.marvelstrikeforce.com/imgs/a/b.png"},
    {name:"One",rank:4,icon:portrait,frame:""}
  ]));
  const data=await(await secureGuestArenaHistory(request(),f.env,now,auth())).json();
  assert.equal(data.profiles.length,2);
  assert.ok(data.profiles.every(p=>p.name==="Valid"||p.name==="One"));
  assert.equal(data.profiles.find(p=>p.name==="One").frame,undefined);
  assert.ok(data.snapshots[0].players.every(p=>p.name!=="Offhost"||!p.icon));
  assert.doesNotMatch(JSON.stringify(data),/attacker\.test|javascript:|secrets/);
});
test("admin sees separate profiles for two invited tenants with identical player names",async()=>{
  const f=create();
  f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:guest,allianceKey:"marines"},
    {fingerprint:other,allianceKey:"future-alliance"}
  ]}));
  f.records.set(key(guest),receipt(guest,"MARINES",[
    {name:"Same Name",rank:5,icon:portrait,frame}]));
  f.records.set(key(other),receipt(other,"FUTURE",[
    {name:"Same Name",rank:6,icon:"https://assets.marvelstrikeforce.com/imgs/Portrait_Future_abcdef00.png",
      frame:"https://assets.marvelstrikeforce.com/imgs/ICON_FRAME_Future_123abc00.png"}]));
  const data=await(await secureGuestArenaHistory(request("approved"),f.env,now,
    auth(validAuth("admin",["marines","future-alliance"],"all")))).json();
  assert.deepEqual(data.alliances,["future-alliance","marines"]);
  assert.equal(data.profiles.length,2);
  const marine=data.profiles.find(p=>p.alliance==="marines");
  const future=data.profiles.find(p=>p.alliance==="future-alliance");
  assert.equal(marine.icon,portrait);
  assert.notEqual(future.icon,marine.icon);
  assert.equal(data.snapshots[0].players.length,2);
  const guestOnly=await(await secureGuestArenaHistory(request("marines"),f.env,now,
    auth(validAuth("guest",["marines"],"marines")))).json();
  assert.deepEqual(guestOnly.alliances,["marines"]);
  assert.deepEqual(guestOnly.profiles.map(p=>p.alliance),["marines"]);
  assert.doesNotMatch(JSON.stringify(guestOnly),/Portrait_Future|future-alliance/);
});
test("before the next daily reward collection, latest real R2 reward receipt supplies portraits",async()=>{
  const f=create(),tomorrow=Date.parse("2026-11-06T15:15:00Z");
  f.records.set(key(guest),receipt(guest,"MARINES",[
    {name:"Yesterday",rank:14,icon:portrait,frame}]));
  f.records.set("roster-batches/v1/guest-arena-history/rolling.json",JSON.stringify({
    version:1,snapshots:[{date,sourceDay:date,sourceKind:"reward",
      players:[{name:"Yesterday",arenaRank:14,alliance:"MARINES",
        allianceKey:"marines"}]}]
  }));
  const data=await(await secureGuestArenaHistory(request(),f.env,tomorrow,
    auth())).json();
  assert.equal(data.snapshots.length,1);
  assert.equal(data.snapshots[0].date,date);
  assert.equal(data.profiles.length,1);
  assert.deepEqual(data.profiles[0],{name:"Yesterday",alliance:"marines",
    icon:portrait,frame});
  assert.equal(data.snapshots[0].players[0].icon,undefined,
    "An old archived point remains immutable; media is separate");
  assert.ok(f.reads.includes(key(guest)));
  assert.ok(!f.reads.some(k=>k.includes("/player/v1")));
});
