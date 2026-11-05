import test from "node:test";
import assert from "node:assert/strict";
import {secureGuestInfos,projectInfoReceipt} from "../src/secure-guest-infos.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const fp="b".repeat(64),losp="a".repeat(64),other="c".repeat(64);
const signed="v1."+"Z".repeat(55)+"."+"Y".repeat(43);
const URL="https://losp-roster-service.deliriousfan7.workers.dev/api/secure/guest-infos";
const now=Date.parse("2026-11-05T17:47:00Z");
const path=(id=fp,campaign="2026-11-05-pm")=>
  "roster-batches/v1/"+id+"/campaigns/"+campaign+"-infos.json";
const receipt=(id=fp,campaign="2026-11-05-pm",alliance="MΛЯIΠΣƧ")=>({
  version:1,kind:"alliance-infos-campaign",allianceFingerprint:id,
  campaign,allianceName:alliance,capturedAt:"2026-11-05T14:19:00Z",
  expiresAt:"2026-11-12T14:19:00Z",
  rows:[{name:"Marine 01",alliance,tcp:125000000,war_mvp:125,
    icon:"https://assets.marvelstrikeforce.com/imgs/icon.png",
    frame:"",rosterShare:false,rank:"leader",aid:"private",
    level:{completedTier:110},stp:19000000,daysInAlliance:75,
    charactersCollected:380,charactersAtMaxStarRank:310,
    latestArena:10,latestBlitz:150,blitzWins:500,
    wwPoints:1000,qualifications:{lang:["fr"]}}],
  accessToken:"secret-data"
});
function fixture(){
  const records=new Map(),reads=[];
  records.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:losp,name:"Zeus"}]}));
  records.set(GUEST_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:fp,allianceKey:"marines"}]}));
  const env={CAPTAIN_BUCKET:{
    get:async k=>{reads.push(k);const v=records.get(k);
      return v===undefined?null:{size:v.length,text:async()=>v};},
    put:async()=>{throw Error("Projection must not write");}
  },LOSP_AUTH:{fetch:async()=>{throw Error("Use injected auth");}}};
  return {records,reads,env};
}
function request(keys="marines",origin="https://keryas777.github.io",
  bearer=signed){
  return new Request(URL+"?alliances="+encodeURIComponent(keys),
    {headers:{Origin:origin,Authorization:"Bearer "+bearer}});
}
const validAuth=(role="guest",allowed=["marines"])=>({
  ok:true,signedSession:true,role,groupKey:role==="admin"?"all":"marines",
  allowedAlliances:allowed
});
const auth=(value=validAuth())=>async req=>{
  assert.equal(req.url,"https://losp-auth.internal/signed-access");
  assert.equal(req.headers.get("Authorization"),"Bearer "+signed);
  return Response.json(value);
};

test("signed MARINES can read latest private Infos, without publishing private fields",async()=>{
  const f=fixture();
  f.records.set(path(),JSON.stringify(receipt()));
  const response=await secureGuestInfos(request(),f.env,now,auth());
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),
    "https://keryas777.github.io");
  const json=await response.json();
  assert.equal(json.kind,"authorized-guest-infos");
  assert.equal(json.alliances.length,1);
  assert.equal(json.alliances[0].state,"complete");
  assert.deepEqual(json.alliances[0].players[0],{
    name:"Marine 01",alliance:"marines",tcp:125000000,war_mvp:125,
    icon:"https://assets.marvelstrikeforce.com/imgs/icon.png",frame:"",
    rank:"leader",rosterShare:false,aid:"private",level:{completedTier:110},
    stp:19000000,daysInAlliance:75,charactersCollected:380,
    charactersAtMaxStarRank:310,latestArena:10,latestBlitz:150,
    blitzWins:500,wwPoints:1000,qualifications:{lang:["fr"]}
  });
  for(const secret of [fp,losp,"secret-data","accessToken",
    "allianceFingerprint","roster-batches/v1/"])
    assert.doesNotMatch(JSON.stringify(json),new RegExp(secret));
  assert.ok(f.reads.includes(path()));
});

test("missing most recent campaign falls back to previous valid snapshot",async()=>{
  const f=fixture(),r=receipt(fp,"2026-11-05-am");
  r.capturedAt="2026-11-05T02:15:00Z";
  r.expiresAt="2026-11-12T02:15:00Z";
  f.records.set(path(fp,"2026-11-05-am"),JSON.stringify(r));
  const json=await(await secureGuestInfos(request(),f.env,now,auth())).json();
  assert.equal(json.alliances[0].state,"complete");
  assert.equal(json.alliances[0].players.length,1);
});

test("signed session authorization is mandatory; no tenant crossover",async()=>{
  const f=fixture();
  let res=await secureGuestInfos(request("marines","https://evil.example"),
    f.env,now,auth());
  assert.equal(res.status,403);
  res=await secureGuestInfos(request("marines",undefined,"legacy-session"),
    f.env,now,auth());
  assert.equal(res.status,401);
  res=await secureGuestInfos(request("marines"),f.env,now,
    auth(validAuth("guest",["other"])));
  assert.equal(res.status,403);
  res=await secureGuestInfos(request("approved"),f.env,now,auth());
  assert.equal(res.status,403);
  assert.equal(f.reads.length,0);
});

test("admin may request all approved guests; nobody can request an unbound tenant",async()=>{
  const f=fixture();
  f.records.set(path(),JSON.stringify(receipt()));
  const res=await secureGuestInfos(request("approved"),f.env,now,
    auth(validAuth("admin",["marines","other"])));
  assert.equal(res.status,200);
  assert.deepEqual((await res.json()).alliances.map(x=>x.alliance),["marines"]);
  const bad=await secureGuestInfos(request("other"),f.env,now,
    auth(validAuth("admin",["other"])));
  assert.equal(bad.status,409);
});

test("missing data has a distinct no-collection state, never fabricated zero ranks",async()=>{
  const f=fixture();
  const body=await(await secureGuestInfos(request(),f.env,now,auth())).json();
  assert.equal(body.alliances[0].state,"not-collected");
  assert.deepEqual(body.alliances[0].players,[]);
});

test("malformed or expired snapshots never leak player data",async()=>{
  const f=fixture(),r=receipt();
  r.rows[0].war_mvp=-1;
  f.records.set(path(),JSON.stringify(r));
  const result=await(await secureGuestInfos(request(),f.env,now,auth())).json();
  assert.equal(result.alliances[0].state,"invalid-snapshot");
  assert.deepEqual(result.alliances[0].players,[]);
  assert.equal(projectInfoReceipt({...receipt(),expiresAt:"2026-11-05T00:00:00Z"},
    fp,"2026-11-05-pm","marines",now),null);
  assert.equal(projectInfoReceipt({...receipt(),allianceFingerprint:other},
    fp,"2026-11-05-pm","marines",now),null);
});

test("no signed service binding is never replaced by unsigned /me",async()=>{
  const f=fixture();
  delete f.env.LOSP_AUTH;
  const res=await secureGuestInfos(request(),f.env,now);
  assert.equal(res.status,503);
  assert.equal((await res.json()).reason,"auth-binding-missing");
  assert.equal(f.reads.length,0);
});
