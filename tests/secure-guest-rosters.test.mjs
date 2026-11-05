import test from "node:test";
import assert from "node:assert/strict";
import {secureGuestRosters} from "../src/secure-guest-rosters.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const fp="b".repeat(64),other="c".repeat(64),losp="a".repeat(64);
const signed="v1."+"Y".repeat(55)+"."+"Z".repeat(43);
const SITE="https://keryas777.github.io";
const URL="https://losp-roster-service.deliriousfan7.workers.dev/api/secure/guest-rosters";
const now=Date.parse("2026-11-05T18:00:00Z");
const expiry="2026-11-11T02:00:00Z";
const runId="1".repeat(8)+"-"+ "2".repeat(4)+"-"+ "3".repeat(4)+"-"+ "4".repeat(4)+"-"+ "5".repeat(12);
const secret="SECRET_SHOULD_NOT_LEAK";
function fixture(){
  const objects=new Map(),reads=[],writes=[];
  objects.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:fp,allianceKey:"marines"},
      {fingerprint:other,allianceKey:"endgame-revolution-red"}]}));
  objects.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:losp,name:"Zeus"}]}));
  const bucket={
    get:async key=>{
      reads.push(key);
      const v=objects.get(key);
      return v===undefined?null:{size:v.length,text:async()=>v};
    },
    put:async(...args)=>writes.push(args),
  };
  return {objects,reads,writes,env:{CAPTAIN_BUCKET:bucket,
    LOSP_AUTH:{fetch:async()=>{throw Error("mock auth required");}}}};
}
function request(alliance="marines",auth=signed,origin=SITE){
  return new Request(URL+"?alliance="+encodeURIComponent(alliance),{
    headers:{Origin:origin,Authorization:"Bearer "+auth}});
}
function auth(role="guest",allowed=["marines"],groupKey="marines"){
  return async (_url,opts)=>{
    assert.equal(opts.headers.Authorization,"Bearer "+signed);
    return Response.json({ok:true,signedSession:true,role,groupKey,
      allowedAlliances:allowed});
  };
}
function archive(f,count=24,{unshared=0}={}){
  const root="roster-batches/v1/"+f+"/";
  const manifest={version:1,fingerprint:f,runId,
    membershipDigest:"d".repeat(64),total:count,coMembers:count-1,
    observedMembers:count+unshared,includesPersonal:true,
    coverage:unshared?"authorized-only":"all-members",
    notSharedCount:unshared,capturedAt:"2026-11-05T03:45:00Z",
    expiresAt:expiry,accessToken:secret};
  f===fp&&assert.equal(f.length,64);
  return {root,manifest};
}
function seed(fixtureData,{fingerprint=fp,count=24,unshared=0,deleted=-1,
  duplicates=false}={}){
  const {root,manifest}=archive(fingerprint,count,{unshared});
  fixtureData.objects.set(root+"latest-complete.json",JSON.stringify(manifest));
  for(let i=0;i<count;i++){
    const index=i===count-1?"self":i;
    const row={version:1,allianceFingerprint:fingerprint,
      kind:index==="self"?"private-staged-personal-roster":
        "private-staged-microbatch",
      runId,memberIndex:index,name:duplicates?"Same name":"Marine "+i,
      volatileMemberId:"private-"+i,accessToken:secret,
      capturedAt:"2026-11-05T03:40:00Z",expiresAt:expiry,
      characters:[{id:"Blob",power:100000+i,level:110,gearTier:19,
        activeYellow:7,activeRed:8,basic:7,special:7,ultimate:7,passive:5,
        iso8:"0,0,0,0,0,0,striker,5,0,0,0,0",
        privateNotes:secret}]};
    if(i!==deleted)fixtureData.objects.set(
      root+runId+"/member-"+index+".json",JSON.stringify(row));
  }
}
test("MARINES 24 authorized rosters from R2, sanitized, no Scopely calls",async()=>{
  const f=fixture();seed(f,{count:24,unshared:1});
  const r=await secureGuestRosters(request(),f.env,now,auth());
  assert.equal(r.status,200);
  assert.equal(r.headers.get("Cache-Control"),"private, no-store");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"),SITE);
  const body=await r.json();
  assert.equal(body.kind,"authorized-guest-rosters");
  assert.equal(body.state,"complete");
  assert.equal(body.rosters.length,24);
  assert.equal(body.rosters[0].alliance,"marines");
  assert.equal(body.rosters[0].chars.blob.power,100000);
  assert.equal(body.rosters[0].chars.blob.gear,19);
  assert.equal(body.rosters[0].chars.blob.diamonds,1);
  assert.equal(body.rosters[0].chars.blob.abilities.ultimate,7);
  assert.equal(body.rosters[0].chars.blob.isoMax,5);
  assert.equal(body.rosters[0].iso.blob.isoClass,"striker");
  for(const forbidden of [secret,"volatileMemberId","allianceFingerprint",
    "accessToken","roster-batches/v1/",fp,losp,"notSharedCount"]){
    assert.ok(!JSON.stringify(body).includes(forbidden),forbidden);
  }
  assert.equal(f.writes.length,0);
  assert.ok(f.reads.every(key=>key===ROSTER_APPROVAL_KEY||
    key===GUEST_APPROVAL_KEY||key.startsWith("roster-batches/v1/"+fp+"/")));
});
test("missing complete manifest gives explicit empty state (no partial roster)",async()=>{
  const f=fixture();
  const r=await secureGuestRosters(request(),f.env,now,auth());
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.state,"not-collected");
  assert.deepEqual(body.rosters,[]);
});
test("missing member, invalid identity, expired manifest or duplicate names never leak partial rows",async()=>{
  for(const issue of ["missing","duplicate","expired"]){
    const f=fixture();seed(f,{count:3,deleted:issue==="missing"?1:-1,
      duplicates:issue==="duplicate"});
    if(issue==="expired"){
      const key="roster-batches/v1/"+fp+"/latest-complete.json";
      const m=JSON.parse(f.objects.get(key));m.expiresAt="2026-11-04T00:00:00Z";
      f.objects.set(key,JSON.stringify(m));
    }
    const res=await secureGuestRosters(request(),f.env,now,auth());
    assert.equal(res.status,issue==="expired"?200:503,issue);
    const body=await res.json();
    assert.equal(body.rosters?.length||0,0);
  }
});
test("forged/unsigned Discord session is denied before reading any R2",async()=>{
  const f=fixture();
  const invalid=await secureGuestRosters(request("marines","eyJyb2xlIjoiYWRtaW4ifQ"),f.env,now,
    async()=>{throw Error("must never contact auth");});
  assert.equal(invalid.status,401);
  assert.deepEqual(f.reads,[]);
  const denied=await secureGuestRosters(request(),f.env,now,async()=>Response.json({
    ok:true,signedSession:false,role:"admin",allowedAlliances:["marines"]}));
  assert.equal(denied.status,401);
  assert.deepEqual(f.reads,[]);
});
test("guest cannot request another alliance and ambiguous ENDGAME is not guessed",async()=>{
  const f=fixture();seed(f,{count:2});
  const forbidden=await secureGuestRosters(request("endgame-revolution-red"),f.env,now,auth());
  assert.equal(forbidden.status,403);
  assert.deepEqual(f.reads,[]);
  const invalid=await secureGuestRosters(request("ENDGAME R-évolution"),f.env,now,auth());
  assert.equal(invalid.status,400);
  assert.deepEqual(f.reads,[]);
});
test("revocation and absent binding fail closed, LoSP never exposed",async()=>{
  const f=fixture();seed(f,{count:2});
  f.objects.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  let r=await secureGuestRosters(request(),f.env,now,auth());
  assert.equal(r.status,409);
  f.objects.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:fp}]}));
  r=await secureGuestRosters(request(),f.env,now,auth());
  assert.equal(r.status,409);
  const admin=auth("admin",["marines","zeus"],"all");
  r=await secureGuestRosters(request("zeus"),f.env,now,admin);
  assert.equal(r.status,409);
});
test("signed admin sees each approved guest separately, not LoSP",async()=>{
  const f=fixture();seed(f,{count:2});seed(f,{fingerprint:other,count:2});
  const admin=auth("admin",["zeus","marines","endgame-revolution-red"],"all");
  const r=await secureGuestRosters(request("endgame-revolution-red"),f.env,now,admin);
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.rosters.length,2);
  assert.ok(body.rosters.every(x=>x.alliance==="endgame-revolution-red"));
  assert.ok(!f.reads.some(k=>k.startsWith("roster-batches/v1/"+fp+"/")));
});
test("OPTIONS, Origin, GET and trusted service binding enforced",async()=>{
  const f=fixture();
  let r=await secureGuestRosters(new Request(URL,{method:"OPTIONS",
    headers:{Origin:SITE}}),f.env,now);
  assert.equal(r.status,204);
  assert.equal(r.headers.get("Access-Control-Allow-Headers"),"Authorization");
  r=await secureGuestRosters(new Request(URL,{method:"OPTIONS",
    headers:{Origin:"https://evil.example"}}),f.env,now);
  assert.equal(r.status,403);
  r=await secureGuestRosters(new Request(URL,{method:"POST"}),f.env,now);
  assert.equal(r.status,405);
  r=await secureGuestRosters(request("marines",signed,"https://evil.example"),
    f.env,now,auth());
  assert.equal(r.status,403);
  delete f.env.LOSP_AUTH;
  r=await secureGuestRosters(request(),f.env,now,auth());
  assert.equal(r.status,503);
  assert.deepEqual(f.reads,[]);
});
