import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {handleRosterR2Coverage} from "../src/roster-r2-coverage.js";
import {handleAdmin} from "../src/admin-routes.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {BATCH_PREFIX,BATCH_MAX_AGE_MS} from "../src/private-roster-batches.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const now=Date.parse("2026-10-21T12:30:00Z");
const started=new Date(now-60*60_000).toISOString();
const expires=new Date(Date.parse(started)+BATCH_MAX_AGE_MS).toISOString();
const fp=n=>String(n).repeat(64);
const digest=fp("a");
const run1="11111111-1111-4111-8111-111111111111";
const run2="22222222-2222-4222-8222-222222222222";
const run3="33333333-3333-4333-8333-333333333333";
const run4="44444444-4444-4444-8444-444444444444";
const run5="55555555-5555-4555-8555-555555555555";
const names=["Zeus","Athéna","Kronos","Dionysos","Poséidon"];
const request=query=>new Request(origin+"/admin/api/roster-r2-coverage"+(query||""));
const progress=(n,run,eligible,completed,observed,self,campaign="2026-10-21-am")=>({
  version:1,fingerprint:fp(n),runId:run,membershipDigest:digest,
  startedAt:started,expiresAt:expires,totalEligible:eligible,
  completed,observedMembers:observed,selfCompleted:self,campaign
});
const manifest=(n,run,count)=>({
  version:1,fingerprint:fp(n),runId:run,membershipDigest:digest,
  total:count,coMembers:count-1,observedMembers:count,
  includesPersonal:true,capturedAt:started,expiresAt:expires
});
const pKey=n=>BATCH_PREFIX+fp(n)+"/progress.json";
const mKey=n=>BATCH_PREFIX+fp(n)+"/latest-complete.json";
const selfKey=(n,run)=>BATCH_PREFIX+fp(n)+"/"+run+"/member-self.json";
const memberKey=(n,run,i)=>BATCH_PREFIX+fp(n)+"/"+run+"/member-"+i+".json";

function fixture(){
  const store=new Map(),read=[],heads=[],writes=[];
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:
    names.map((name,i)=>({name,fingerprint:fp(i+1)}))}));
  function add(key,data){store.set(key,typeof data==="string"?data:JSON.stringify(data));}
  function files(n,run,count,self=true){
    for(let i=0;i<count;i++)add(memberKey(n,run,i),{
      playerName:"SECRET_PLAYER",characters:[{id:"SECRET_CHARACTER"}]});
    if(self)add(selfKey(n,run),{playerName:"SECRET_CAPTAIN"});
  }
  add(pKey(1),progress(1,run1,2,2,3,true));
  add(mKey(1),manifest(1,run1,3));files(1,run1,2);
  // Two members exist without consent from every member; no full pointer.
  add(pKey(4),progress(4,run2,1,1,3,true));files(4,run2,1);
  add(pKey(3),progress(3,run3,2,1,3,false));files(3,run3,1,false);
  // Previous complete pointer remains valid while a new campaign is in progress.
  add(pKey(5),progress(5,run4,2,1,3,false,"2026-10-21-pm"));
  files(5,run4,1,false);
  add(mKey(5),manifest(5,run5,3));files(5,run5,2);
  const bucket={
    get:async key=>{read.push(key);return store.has(key)?
      {text:async()=>store.get(key)}:null;},
    head:async key=>{heads.push(key);return store.has(key)?{size:100}:null;},
    put:async key=>{writes.push(key);throw Error("write prohibited");},
    delete:async key=>{writes.push(key);throw Error("delete prohibited");},
    list:async()=>{throw Error("list prohibited");}
  };
  return {store,read,heads,writes,env:{CAPTAIN_BUCKET:bucket}};
}

test("R2 summary detects 5 approved alliances without any Scopely calls or writes",async()=>{
  const f=fixture();
  const data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
  assert.equal(data.status,"ok");
  assert.equal(data.scope,"summary");
  assert.equal(data.approvedCount,5);
  assert.deepEqual(data.alliances.map(x=>x.name),names);
  assert.deepEqual(data.alliances.map(x=>x.progress.status),[
    "complete","not-started","in-progress","partial-consent","in-progress"
  ]);
  assert.equal(data.alliances[0].manifest.status,"valid");
  assert.equal(data.alliances[0].manifest.verified,null); // not all HEAD checked
  assert.equal(data.alliances[3].progress.noShareCount,1);
  assert.equal(data.alliances[3].manifest.status,"missing");
  assert.equal(data.alliances[4].manifest.matchesCurrentProgress,false);
  assert.deepEqual(f.writes,[]);
  assert.ok(f.read.every(k=>k===ROSTER_APPROVAL_KEY||k.startsWith(BATCH_PREFIX)));
  assert.ok(f.heads.every(k=>k.startsWith(BATCH_PREFIX)));
  assert.doesNotMatch(JSON.stringify(data),/SECRET_PLAYER|SECRET_CAPTAIN|SECRET_CHARACTER|access_token|refresh_token/);
});

test("authorized-only manifest validates the consenting roster subset and rejects inflated coverage",async()=>{
  const f=fixture();
  const partial={...manifest(4,run2,2),observedMembers:3,
    coverage:"authorized-only",notSharedCount:1};
  f.store.set(mKey(4),JSON.stringify(partial));
  const response=await handleRosterR2Coverage(request("?fingerprint="+fp(4)),f.env,now);
  const item=(await response.json()).alliances[0];
  assert.equal(item.progress.status,"partial-consent");
  assert.equal(item.manifest.status,"valid");
  assert.equal(item.manifest.coverage,"authorized-only");
  assert.equal(item.manifest.members,2);
  assert.equal(item.manifest.observedMembers,3);
  assert.equal(item.manifest.notSharedCount,1);
  assert.equal(item.manifest.verified,true);
  assert.equal(item.manifest.files.checked,2);
  assert.equal(item.manifest.files.missing,0);
  partial.notSharedCount=0; // inconsistent: never silently declare full coverage
  f.store.set(mKey(4),JSON.stringify(partial));
  const bad=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[3];
  assert.equal(bad.manifest.status,"invalid");
  partial.notSharedCount=1;partial.coverage="all-members";
  f.store.set(mKey(4),JSON.stringify(partial));
  const wrong=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[3];
  assert.equal(wrong.manifest.status,"invalid");
  assert.deepEqual(f.writes,[]);
});

test("Poséidon scenario: 22/22 authorized rosters, 24 observed, one opt-out is a verified manifest",async()=>{
  const f=fixture();
  f.store.set(pKey(4),JSON.stringify(progress(4,run2,22,22,24,true)));
  f.store.set(mKey(4),JSON.stringify({...manifest(4,run2,23),
    observedMembers:24,coverage:"authorized-only",notSharedCount:1}));
  for(let i=0;i<22;i++)f.store.set(memberKey(4,run2,i),
    JSON.stringify({characters:[{id:"PRIVATE"}]}));
  f.store.set(selfKey(4,run2),JSON.stringify({characters:[{id:"PRIVATE"}]}));
  const data=await(await handleRosterR2Coverage(
    request("?fingerprint="+fp(4)),f.env,now)).json();
  const a=data.alliances[0];
  assert.equal(a.progress.completed,22);
  assert.equal(a.progress.eligibleCoMembers,22);
  assert.equal(a.progress.noShareCount,1);
  assert.equal(a.progress.status,"partial-consent");
  assert.equal(a.manifest.status,"valid");
  assert.equal(a.manifest.coverage,"authorized-only");
  assert.equal(a.manifest.members,23);
  assert.equal(a.manifest.observedMembers,24);
  assert.equal(a.manifest.notSharedCount,1);
  assert.equal(a.manifest.files.checked,23);
  assert.equal(a.manifest.verified,true);
  assert.deepEqual(f.writes,[]);
});

test("deep check verifies every current member and the previous valid manifest",async()=>{
  const f=fixture();
  const full=await(await handleRosterR2Coverage(request("?fingerprint="+fp(1)),f.env,now)).json();
  assert.equal(full.scope,"full");
  assert.equal(full.alliances.length,1);
  assert.deepEqual(full.alliances[0].manifest.files,{
    checked:3,missing:0,allPresent:true,verification:"r2-head-only"
  });
  assert.equal(full.alliances[0].manifest.verified,true);
  assert.equal(full.alliances[0].progress.files.checked,3);
  const old=await(await handleRosterR2Coverage(request("?fingerprint="+fp(5)),f.env,now)).json();
  assert.equal(old.alliances[0].manifest.matchesCurrentProgress,false);
  assert.equal(old.alliances[0].manifest.verified,true);
  assert.equal(old.alliances[0].progress.files.checked,1);
  assert.deepEqual(f.writes,[]);
});

test("missing backing snapshots never count as verified complete",async()=>{
  const f=fixture();
  f.store.delete(memberKey(1,run1,1));
  let a=(await(await handleRosterR2Coverage(request("?fingerprint="+fp(1)),f.env,now)).json()).alliances[0];
  assert.equal(a.manifest.status,"valid");
  assert.equal(a.manifest.files.missing,1);
  assert.equal(a.manifest.verified,false);
  f.store.delete(selfKey(1,run1));
  a=(await(await handleRosterR2Coverage(request("?fingerprint="+fp(1)),f.env,now)).json()).alliances[0];
  assert.equal(a.manifest.personalFilePresent,false);
  assert.equal(a.progress.personalFilePresent,false);
  assert.equal(a.manifest.verified,false);
});

test("expired, malformed and missing R2 records are distinguished",async()=>{
  const f=fixture();
  const stale=manifest(1,run1,3);
  stale.expiresAt="2026-10-20T01:00:00Z";
  f.store.set(mKey(1),JSON.stringify(stale));
  let m=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[0].manifest;
  assert.equal(m.status,"expired");
  f.store.set(mKey(1),"{invalid");
  m=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[0].manifest;
  assert.equal(m.status,"invalid");
  f.store.delete(mKey(1));
  m=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[0].manifest;
  assert.equal(m.status,"missing");
  f.store.set(pKey(4),JSON.stringify({...progress(4,run2,1,1,3,true),
    completed:99}));
  const p=(await(await handleRosterR2Coverage(request(),f.env,now)).json()).alliances[3].progress;
  assert.equal(p.status,"invalid");
});

test("unapproved fingerprints, bad queries and broken R2 are rejected",async()=>{
  const f=fixture();
  assert.equal((await handleRosterR2Coverage(request("?fingerprint="+fp("f")),f.env,now)).status,403);
  for(const q of ["?fingerprint=bad","?other=x","?fingerprint="+fp(1)+"&fingerprint="+fp(2)]){
    assert.equal((await handleRosterR2Coverage(request(q),f.env,now)).status,400);
  }
  assert.equal((await handleRosterR2Coverage(request(),{},now)).status,503);
  f.store.set(ROSTER_APPROVAL_KEY,"{");
  assert.equal((await handleRosterR2Coverage(request(),f.env,now)).status,503);
});

test("Access authentication gates endpoint before any private R2 read",async()=>{
  const f=fixture();
  const res=await handleAdmin(request(),{...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"losp-test.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"},async()=>{
      throw Error("External fetch prohibited");
    });
  assert.equal(res.status,403);
  assert.equal(f.read.length,0);
  assert.equal(f.heads.length,0);
});

test("admin UI is vanilla, safely renders private aggregates and has no storage side effects",async()=>{
  const js=await readFile(new URL("../public/admin-roster-r2-coverage.js",import.meta.url),"utf8");
  const admin=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.match(js,/textContent/);
  assert.match(js,/createElement/);
  assert.doesNotMatch(js,/innerHTML|localStorage|sessionStorage|eval\(/);
  assert.match(admin,/roster-r2-coverage/);
  assert.match(admin,/admin-roster-r2-coverage\.js/);
});
