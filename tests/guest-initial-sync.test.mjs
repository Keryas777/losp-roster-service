import test from "node:test";
import assert from "node:assert/strict";
import {enqueueGuestInitialSync,guestInitialSyncStatus,
  runGuestInitialSyncTick,handleGuestInitialSync,
  reconcileGuestInitialSyncRequests,dispatchInitialGuestDirectory}
  from "../src/guest-initial-sync.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {RosterBatchLock} from "../src/roster-batch-lock.js";

const FP="a".repeat(64),KEY="questionable-propriety";
const START=Date.parse("2026-11-08T02:00:00Z");
const URL="https://losp-roster-service.deliriousfan7.workers.dev";
function fixture(){
  const store=new Map(),etags=new Map(),call=[],lockState=new Map();
  const failures={bucketPut:0,bucketPutKey:null,lockDelete:0};
  let etagCounter=0;
  store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY,initialSyncStatus:"pending"}]}));
  etags.set(GUEST_APPROVAL_KEY,"etag-approval");
  const bucket={
    get:async key=>store.has(key)?{text:async()=>store.get(key),
      size:store.get(key).length,etag:etags.get(key)}:null,
    put:async (key,value,options={})=>{
      if(failures.bucketPut>0){failures.bucketPut--;throw Error("simulated-r2-failure");}
      if(failures.bucketPutKey===key)throw Error("simulated-keyed-r2-failure");
      const condition=options.onlyIf||{};
      if(condition.etagDoesNotMatch==="*"&&store.has(key))return null;
      if(condition.etagMatches&&condition.etagMatches!==etags.get(key))return null;
      store.set(key,value);
      const etag="etag-"+(++etagCounter);
      etags.set(key,etag);
      return {etag};
    },
    delete:async key=>{store.delete(key);etags.delete(key);},
    list:async ({prefix,limit})=>({truncated:false,
      objects:[...store.keys()].filter(key=>key.startsWith(prefix))
        .slice(0,limit).map(key=>({key}))})
  };
  const lock=new RosterBatchLock({storage:{
    get:async key=>lockState.get(key),
    put:async (key,value)=>lockState.set(key,value),
    delete:async key=>{
      if(failures.lockDelete>0){failures.lockDelete--;throw Error("simulated-lock-delete-failure");}
      lockState.delete(key);
    }
  }});
  const env={CAPTAIN_BUCKET:bucket,
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    ROSTER_AUTO_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    MEMBER_INFO_AUTO_ENABLED:"true",
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key},
    ROSTER_BATCH_LOCK:{idFromName:key=>key,
      get:()=>({fetch:req=>lock.fetch(req)})}
  };
  return {store,etags,env,call,lock,lockState,failures};
}
function deps(calls){
  return {
    infos:async()=>{calls.push("infos");return {status:calls.filter(x=>x==="infos").length===1?"partial":"complete",requests:6};},
    ranks:async()=>{calls.push("ranks");return {status:"captured",requests:2};},
    arena:async()=>{calls.push("arena");return {status:"updated"};},
    trophies:async()=>{calls.push("trophies");return {status:"updated",requests:0};},
    roster:async()=>{calls.push("roster");return {status:"complete",requestsThisTick:10};}
  };
}
const queuePath=fp=>"roster-batches/v1/guest-initial-sync/"+fp+".json";
function queueRecord(fp=FP,key=KEY,overrides={}){
  const now=Date.now();
  return {version:1,fingerprint:fp,allianceKey:key,status:"queued",
    phase:"ranks",requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString(),attempts:0,lastOutcome:null,...overrides};
}
function saveQueue(f,record){
  const path=queuePath(record.fingerprint);
  f.store.set(path,JSON.stringify(record));
  f.etags.set(path,"etag-queue-"+record.updatedAt);
  return path;
}
function stubLock(f,makeResponse){
  f.env.ROSTER_BATCH_LOCK={idFromName:key=>key,get:()=>({fetch:async request=>{
    const body=await request.json();
    return makeResponse(body);
  }})};
}
test("new approved and bound alliance is queued once; phases finish after restart-safe ticks",async()=>{
  const f=fixture(),steps=[];
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,START)).status,"queued");
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,START)).status,"queued");
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"ranks");
  for(let i=0;i<6;i++){
    const res=await runGuestInitialSyncTick(f.env,START+i*60000,
      async()=>{throw Error("No unmocked Scopely calls");},deps(steps));
    assert.notEqual(res.status,"unavailable");
  }
  assert.deepEqual(steps,["ranks","infos","infos","roster","arena","trophies"]);
  const end=await guestInitialSyncStatus(f.env,FP);
  assert.equal(end.status,"complete");
  assert.equal(end.phase,"done");
  assert.equal(end.attempts,6);
  assert.equal((await runGuestInitialSyncTick(f.env,START+6*60000,
    async()=>{throw Error("not called");},deps(steps))).status,"idle");
  assert.equal(steps.length,6);
  assert.equal([...f.store.keys()].filter(k=>k.endsWith("/"+FP+".json")).length,1);
  assert.equal(f.lockState.has("lease"),false);
});

test("a genuine RosterBatchLock 409 is reported as temporary contention",async()=>{
  const f=fixture(),now=Date.now();
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  const held=await f.lock.fetch(new Request("https://lock.test/",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({
      action:"acquire",holder:"123e4567-e89b-12d3-a456-426614174000",
      fingerprint:"e".repeat(64)})}));
  assert.equal(held.status,200);
  const result=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely must not run when the lock is busy");
  },deps([]));
  assert.equal(result.status,"lock-busy");
  assert.equal(result.httpStatus,409);
  const record=JSON.parse(f.store.get(queuePath(FP)));
  assert.equal(record.status,"queued");
  assert.equal(record.lastOutcome,"lock-busy");
  assert.equal(Date.parse(record.nextAt),now+2*60000);
});

test("HTTP 400, HTTP 503, malformed and unexpected lock replies stay distinct",async()=>{
  for(const [httpStatus,payload,expected,finalStatus] of [
    [400,{status:"invalid"},"lock-invalid-request","failed"],
    [503,{status:"unavailable"},"lock-internal-error","queued"],
    [503,null,"lock-internal-error","queued"],
    [200,null,"lock-invalid-response","failed"],
    [200,{status:"not-acquired"},"lock-unexpected-response","failed"]
  ]){
    const f=fixture(),now=Date.now();
    saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
      updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
      nextAt:new Date(now).toISOString()}));
    stubLock(f,body=>body.action==="release"?Response.json({status:"released"}):
      payload===null?new Response("not-json",{status:httpStatus}):
        Response.json(payload,{status:httpStatus}));
    const result=await runGuestInitialSyncTick(f.env,now,async()=>{
      throw Error("Scopely must not run on a failed lock response");
    },deps([]));
    assert.equal(result.status,expected);
    const saved=JSON.parse(f.store.get(queuePath(FP)));
    assert.equal(saved.status,finalStatus);
    assert.equal(saved.lastOutcome,expected);
  }
});

test("the real Durable Object reports storage failures as internal lock errors",async()=>{
  const f=fixture(),now=Date.now();
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  const broken=new RosterBatchLock({storage:{
    get:async()=>{throw Error("simulated-do-storage-read-failure");},
    put:async()=>{},delete:async()=>{}
  }});
  f.env.ROSTER_BATCH_LOCK={idFromName:key=>key,get:()=>({fetch:req=>broken.fetch(req)})};
  const result=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely must not run while the lock's storage is unavailable");
  },deps([]));
  assert.equal(result.status,"lock-internal-error");
  assert.equal(result.httpStatus,503);
  assert.equal(JSON.parse(f.store.get(queuePath(FP))).status,"queued");
});

test("an expired Durable Object lease can be acquired and released",async()=>{
  const f=fixture(),now=Date.now(),steps=[];
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  f.lockState.set("lease",{fingerprint:"e".repeat(64),
    holder:"123e4567-e89b-12d3-a456-426614174000",expiresAt:Date.now()-1});
  const result=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely disabled in test");
  },{...deps(steps),ranks:async()=>{steps.push("ranks");return {status:"captured",requests:1};}});
  assert.equal(result.status,"queued");
  assert.deepEqual(steps,["ranks"]);
  assert.equal(f.lockState.has("lease"),false);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"infos");
});

test("a failed Durable Object release is observable and the lease expires safely",async()=>{
  const f=fixture(),now=Date.now();
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  f.failures.lockDelete=1;
  const result=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely disabled in test");
  },{...deps([]),ranks:async()=>({status:"captured",requests:1})});
  assert.equal(result.status,"queued");
  assert.equal(result.lockReleaseStatus,"lock-release-failed");
  assert.equal(result.lockReleaseHttpStatus,503);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"infos");
  assert.equal((await guestInitialSyncStatus(f.env,FP)).lockReleaseStatus,
    "lock-release-failed");
  // Simulate expiry without waiting eight minutes in the test runner.
  const lease=f.lockState.get("lease");
  assert.ok(lease);
  f.lockState.set("lease",{...lease,expiresAt:Date.now()-1});
  const retry=await runGuestInitialSyncTick(f.env,now+60000,
    async()=>{throw Error("Scopely disabled in test");},
    {...deps([]),infos:async()=>({status:"complete",requests:1})});
  assert.equal(retry.status,"queued");
});

test("a failed R2 request write is recovered automatically without a provider call",async()=>{
  const f=fixture(),now=Date.now();
  f.failures.bucketPut=1;
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,now)).status,
    "storage-write-failed");
  assert.equal(f.store.has(queuePath(FP)),false);
  const recovered=await reconcileGuestInitialSyncRequests(f.env,now+1000);
  assert.deepEqual(recovered,{status:"queued",created:1});
  assert.equal(JSON.parse(f.store.get(queuePath(FP))).status,"queued");
  assert.deepEqual(f.call,[]);
});

test("queue reconciliation remains available if the execution lock binding is missing",async()=>{
  const f=fixture(),now=Date.now();
  f.failures.bucketPut=1;
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,now)).status,
    "storage-write-failed");
  delete f.env.ROSTER_BATCH_LOCK;
  const result=await runGuestInitialSyncTick(f.env,now+60000,async()=>{
    throw Error("Scopely must not run without the execution lock");
  },deps([]));
  assert.equal(result.status,"lock-unavailable");
  assert.ok(f.store.has(queuePath(FP)),"reconciliation must still persist the intent");
  assert.equal(JSON.parse(f.store.get(queuePath(FP))).lastOutcome,"lock-unavailable");
});

test("cron reconciliation queues only durable pending intents, one per tick",async()=>{
  const f=fixture(),second="b".repeat(64),third="c".repeat(64),now=Date.now();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:FP,allianceKey:KEY,initialSyncStatus:"pending"},
    {fingerprint:second,allianceKey:"another-guest",initialSyncStatus:"pending"},
    {fingerprint:third}
  ]}));
  f.etags.set(GUEST_APPROVAL_KEY,"etag-approvals-multiple");
  assert.deepEqual(await reconcileGuestInitialSyncRequests(f.env,now),
    {status:"queued",created:1});
  assert.deepEqual(await reconcileGuestInitialSyncRequests(f.env,now+60000),
    {status:"queued",created:1});
  assert.ok(f.store.has(queuePath(FP)));
  assert.ok(f.store.has(queuePath(second)));
  assert.equal(f.store.has(queuePath(third)),false,"unbound approvals are not queued");
});

test("due alliances share turns fairly instead of letting the oldest queue starve the rest",async()=>{
  const f=fixture(),second="b".repeat(64),now=Date.now(),calls=[];
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:FP,allianceKey:KEY,initialSyncStatus:"pending"},
    {fingerprint:second,allianceKey:"another-guest",initialSyncStatus:"pending"}
  ]}));
  f.etags.set(GUEST_APPROVAL_KEY,"etag-fair-approvals");
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now-2000).toISOString(),
    updatedAt:new Date(now-2000).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  saveQueue(f,queueRecord(second,"another-guest",{
    requestedAt:new Date(now-1000).toISOString(),updatedAt:new Date(now-1000).toISOString(),
    deadlineAt:new Date(now+48*3600000).toISOString(),nextAt:new Date(now).toISOString()}));
  const runAt=at=>runGuestInitialSyncTick(f.env,at,async()=>{
    throw Error("No external provider calls in fairness test");
  },{...deps(calls),ranks:async(_env,fp)=>{
    calls.push(fp);return {status:"captured",requests:1};
  }});
  assert.equal((await runAt(now)).status,"queued");
  assert.equal((await runAt(now+60000)).status,"queued");
  assert.deepEqual(calls,[FP,second]);
});

test("cron and the admin enqueue can race without losing or resetting a request",async()=>{
  const f=fixture(),now=Date.now(),steps=[];
  const [admin,repair,tick]=await Promise.all([
    enqueueGuestInitialSync(f.env,FP,KEY,now),
    reconcileGuestInitialSyncRequests(f.env,now),
    runGuestInitialSyncTick(f.env,now,async()=>{
      throw Error("no external provider calls in this race test");
    },{...deps(steps),ranks:async()=>{steps.push("ranks");return {status:"captured",requests:1};}})
  ]);
  assert.ok(["queued","running","complete"].includes(
    JSON.parse(f.store.get(queuePath(FP))).status));
  const saved=JSON.parse(f.store.get(queuePath(FP)));
  assert.equal(saved.fingerprint,FP);
  assert.equal(saved.allianceKey,KEY);
  assert.ok(saved.attempts<=1,"only one cron claim may advance the request");
  assert.ok(["queued","idle"].includes(repair.status));
  assert.ok(["queued","complete","idle"].includes(tick.status));
  assert.ok(["queued","running","complete"].includes(admin.status));
  assert.ok(steps.length<=1);
});

test("a crashed running claim waits for lease expiry, then resumes its saved phase",async()=>{
  const f=fixture(),now=Date.now(),until=now+8*60000,steps=[];
  const active=queueRecord(FP,KEY,{status:"running",phase:"ranks",
    claimToken:"123e4567-e89b-12d3-a456-426614174000",
    claimUntil:new Date(until).toISOString(),nextAt:new Date(until).toISOString(),
    requestedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString()});
  saveQueue(f,active);
  f.lockState.set("lease",{fingerprint:"e".repeat(64),
    holder:"123e4567-e89b-12d3-a456-426614174000",expiresAt:Date.now()-1});
  const waiting=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("must not call provider before claim expiry");
  },deps(steps));
  assert.equal(waiting.status,"cooldown");
  assert.deepEqual(steps,[]);
  active.claimUntil=new Date(now-1).toISOString();
  active.nextAt=new Date(now-1).toISOString();
  active.updatedAt=new Date(now+1).toISOString();
  saveQueue(f,active);
  const resumed=await runGuestInitialSyncTick(f.env,now+2,async()=>{
    throw Error("provider disabled in test");
  },{...deps(steps),ranks:async()=>{steps.push("ranks");return {status:"captured",requests:1};}});
  assert.equal(resumed.status,"queued");
  assert.deepEqual(steps,["ranks"]);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"infos");
});

test("revocation during a phase stops progression before the next provider phase",async()=>{
  const f=fixture(),now=Date.now(),steps=[];
  saveQueue(f,queueRecord(FP,KEY,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  const stopped=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely disabled in test");
  },{...deps(steps),ranks:async()=>{
    steps.push("ranks");
    f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
    return {status:"captured",requests:1};
  }});
  assert.equal(stopped.status,"stopped");
  assert.equal(stopped.lastOutcome,"approval-or-binding-withdrawn");
  assert.deepEqual(steps,["ranks"]);
});

test("a changed binding stops the old queue before collection and preserves tenant data",async()=>{
  const f=fixture(),now=Date.now(),oldKey="old-guest-key";
  const sentinelKey="private-test-data/"+FP;
  const sentinel='{"kept":true}';
  f.store.set(sentinelKey,sentinel);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY}]}));
  saveQueue(f,queueRecord(FP,oldKey,{requestedAt:new Date(now).toISOString(),
    updatedAt:new Date(now).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString()}));
  const steps=[];
  const stopped=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("no provider calls after association change");
  },{...deps(steps),ranks:async()=>{steps.push("wrong-tenant");return {status:"captured"};}});
  assert.equal(stopped.status,"stopped");
  assert.deepEqual(steps,[]);
  assert.equal(f.store.get(sentinelKey),sentinel);
});

test("administrative relaunch preserves completed and already-pending records",async()=>{
  const f=fixture(),now=Date.now();
  const complete=queueRecord(FP,KEY,{status:"complete",phase:"done",attempts:6,
    requestedAt:new Date(now-10000).toISOString(),
    updatedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+48*3600000).toISOString(),
    nextAt:new Date(now).toISOString(),lastOutcome:"already-recorded"});
  let path=saveQueue(f,complete),before=f.store.get(path);
  const completed=await enqueueGuestInitialSync(f.env,FP,KEY,now,{restart:true});
  assert.equal(completed.status,"already-complete");
  assert.equal(f.store.get(path),before);
  const pendingRecord={...complete,status:"queued",phase:"roster",attempts:3,
    lastOutcome:"partial-consent"};
  path=saveQueue(f,pendingRecord);before=f.store.get(path);
  const inFlight=await enqueueGuestInitialSync(f.env,FP,KEY,now,{restart:true});
  assert.equal(inFlight.status,"already-pending");
  assert.equal(f.store.get(path),before);
});

test("existing collection receipts are left intact when an initial phase resumes",async()=>{
  const f=fixture(),now=Date.now(),calls=[];
  const receiptKey="guest-roster-receipts/"+FP+".json";
  const existing='{"status":"complete","members":2}';
  f.store.set(receiptKey,existing);
  saveQueue(f,queueRecord(FP,KEY,{status:"queued",phase:"roster",
    requestedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),
    deadlineAt:new Date(now+48*3600000).toISOString(),nextAt:new Date(now).toISOString()}));
  const result=await runGuestInitialSyncTick(f.env,now,async()=>{
    throw Error("Scopely disabled in test");
  },{...deps(calls),roster:async()=>{
    calls.push("reuse-existing-receipt");
    assert.equal(f.store.get(receiptKey),existing);
    return {status:"complete",requestsThisTick:0};
  }});
  assert.equal(result.status,"queued");
  assert.deepEqual(calls,["reuse-existing-receipt"]);
  assert.equal(f.store.get(receiptKey),existing);
});
test("revoked guest stops before ANY new provider capture and does not cross tenants",async()=>{
  const f=fixture();
  await enqueueGuestInitialSync(f.env,FP,KEY,START);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const res=await runGuestInitialSyncTick(f.env,START,async()=>{
    throw Error("no provider calls allowed");
  });
  assert.equal(res.status,"stopped");
  assert.equal((await guestInitialSyncStatus(f.env,FP)).lastOutcome,
    "approval-or-binding-withdrawn");
});
test("admin-only GET status and explicit POST retry validate scope and Origin",async()=>{
  const f=fixture();
  const path=URL+"/admin/api/guest-initial-sync?fingerprint="+FP;
  const first=await handleGuestInitialSync(new Request(path),f.env,START);
  assert.equal((await first.json()).status,"pending-registration");
  const foreign=new Request(path,{method:"POST",
    headers:{Origin:"https://evil.example","Content-Type":"application/json"},
    body:'{"action":"restart"}'});
  assert.equal((await handleGuestInitialSync(foreign,f.env,START)).status,403);
  const retry=new Request(path,{method:"POST",
    headers:{Origin:URL,"Content-Type":"application/json"},
    body:'{"action":"restart"}'});
  const res=await handleGuestInitialSync(retry,f.env,START);
  assert.equal(res.status,202);
  assert.equal((await res.json()).status,"queued");
  assert.equal((await guestInitialSyncStatus(f.env,FP)).status,"queued");
  assert.equal((await handleGuestInitialSync(new Request(URL+
    "/admin/api/guest-initial-sync?fingerprint=bad"),f.env,START)).status,400);
});

test("unbound or revoked guest entries remain not-started during status checks",async()=>{
  const f=fixture(),other="b".repeat(64);
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:other}]}));
  assert.equal((await guestInitialSyncStatus(f.env,other)).status,"not-started");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  assert.equal((await guestInitialSyncStatus(f.env,FP)).status,"not-started");
});

test("completed onboarding survives queue expiration and is never recreated",async()=>{
  const f=fixture(),now=Date.now();
  const completed=queueRecord(FP,KEY,{status:"complete",phase:"done",
    requestedAt:new Date(now-10000).toISOString(),updatedAt:new Date(now).toISOString(),
    deadlineAt:new Date(now+48*3600000).toISOString(),nextAt:new Date(now).toISOString()});
  saveQueue(f,completed);
  await reconcileGuestInitialSyncRequests(f.env,now);
  const approval=JSON.parse(f.store.get(GUEST_APPROVAL_KEY));
  assert.equal(approval.alliances[0].initialSyncStatus,"complete");
  f.store.delete(queuePath(FP));
  f.etags.delete(queuePath(FP));
  assert.equal((await reconcileGuestInitialSyncRequests(f.env,now+60000)).created,0);
  assert.equal(f.store.has(queuePath(FP)),false);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).status,"complete");
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,now+120000,
    {restart:true})).status,"already-complete");
});

test("legacy markerless approval is surfaced for one explicit recovery, not bulk replayed",async()=>{
  const f=fixture(),now=Date.now();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY}]}));
  assert.equal((await reconcileGuestInitialSyncRequests(f.env,now)).created,0);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).status,"pending-registration");
  const started=await enqueueGuestInitialSync(f.env,FP,KEY,now,{restart:true});
  assert.equal(started.status,"queued");
  assert.equal(JSON.parse(f.store.get(GUEST_APPROVAL_KEY))
    .alliances[0].initialSyncStatus,"pending");
});

test("a changed WebApp association requires review before any new queue",async()=>{
  const f=fixture(),now=Date.now();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:FP,allianceKey:KEY,initialSyncStatus:"binding-changed"}
  ]}));
  assert.equal((await guestInitialSyncStatus(f.env,FP)).status,"binding-changed");
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,now,{restart:true})).status,
    "binding-changed-requires-review");
  assert.equal(f.store.has(queuePath(FP)),false);
});

test("an interrupted admin retry is recovered without repeating the relaunch",async()=>{
  const f=fixture(),now=Date.now();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:FP,allianceKey:KEY,initialSyncStatus:"failed"}
  ]}));
  saveQueue(f,queueRecord(FP,KEY,{status:"failed",phase:"roster",
    requestedAt:new Date(now-1000).toISOString(),updatedAt:new Date(now-1000).toISOString(),
    deadlineAt:new Date(now+48*3600000).toISOString(),nextAt:new Date(now).toISOString()}));
  f.failures.bucketPutKey=queuePath(FP);
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,now,{restart:true})).status,
    "storage-write-failed");
  assert.equal(JSON.parse(f.store.get(GUEST_APPROVAL_KEY))
    .alliances[0].initialSyncStatus,"restart-requested");
  f.failures.bucketPutKey=null;
  const recovered=await reconcileGuestInitialSyncRequests(f.env,now+60000);
  assert.equal(recovered.status,"repaired");
  assert.equal(JSON.parse(f.store.get(queuePath(FP))).status,"queued");
  assert.equal(JSON.parse(f.store.get(GUEST_APPROVAL_KEY))
    .alliances[0].initialSyncStatus,"pending");
});

test("first complete Infos wakes the public guest directory without leaking identities",async()=>{
  let count=0;
  const env={ROSTER_GITHUB_DISPATCH_ENABLED:"true",
    ROSTER_GITHUB_DISPATCH_TOKEN:"SERVER_ONLY_TEST_TOKEN"};
  const result=await dispatchInitialGuestDirectory(env,async(url,options)=>{
    count++;
    assert.equal(url,"https://api.github.com/repos/Keryas777/msf/actions/workflows/publish-guest-joueurs.yml/dispatches");
    assert.equal(options.method,"POST");
    assert.equal(options.headers.Authorization,"Bearer SERVER_ONLY_TEST_TOKEN");
    assert.deepEqual(JSON.parse(options.body),{ref:"main"});
    return new Response(null,{status:204});
  });
  assert.equal(result,"dispatched");
  assert.equal(count,1);
  assert.equal(await dispatchInitialGuestDirectory({},async()=>{throw Error("never called");}),"not-configured");
  assert.equal(await dispatchInitialGuestDirectory(env,async()=>new Response(null,{status:403})),"github-unavailable");
});

test("initial Infos wait for the actual AM window without creating an out-of-window receipt",async()=>{
  const f=fixture(),calls=[];
  const before=Date.parse("2026-11-09T00:09:00Z");
  await enqueueGuestInitialSync(f.env,FP,KEY,before);
  const mocked=deps(calls);
  const ranks=await runGuestInitialSyncTick(f.env,before,
    async()=>{throw Error("No Scopely calls");},mocked);
  assert.equal(ranks.phase,"infos");
  const early=await runGuestInitialSyncTick(f.env,before+60000,
    async()=>{throw Error("No Scopely calls");},mocked);
  assert.equal(early.lastOutcome,"campaign-not-open");
  assert.deepEqual(calls,["ranks"]);
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"infos");
  const opened=await runGuestInitialSyncTick(f.env,
    Date.parse("2026-11-09T02:00:00Z"),
    async()=>{throw Error("No Scopely calls");},mocked);
  assert.equal(opened.lastOutcome,"partial");
  assert.deepEqual(calls,["ranks","infos"]);
});

test("initial Infos never use the expired AM window or premature PM window",async()=>{
  const f=fixture(),calls=[];
  const start=Date.parse("2026-11-09T03:59:00Z");
  await enqueueGuestInitialSync(f.env,FP,KEY,start);
  const mocked=deps(calls);
  await runGuestInitialSyncTick(f.env,start,
    async()=>{throw Error("No Scopely calls");},mocked);
  for(const time of ["2026-11-09T04:00:00Z","2026-11-09T13:59:00Z"]){
    const res=await runGuestInitialSyncTick(f.env,Date.parse(time),
      async()=>{throw Error("No Scopely calls");},mocked);
    assert.equal(res.lastOutcome,"campaign-not-open");
  }
  assert.deepEqual(calls,["ranks"]);
  // The 13:59 attempt schedules a five-minute retry (nextAt=14:04).
  // A 14:00 tick must respect the existing cooldown rather than collect.
  const cooling=await runGuestInitialSyncTick(f.env,
    Date.parse("2026-11-09T14:00:00Z"),
    async()=>{throw Error("No Scopely calls");},mocked);
  assert.equal(cooling.status,"cooldown");
  const resumed=await runGuestInitialSyncTick(f.env,
    Date.parse("2026-11-09T14:04:00Z"),
    async()=>{throw Error("No Scopely calls");},mocked);
  assert.equal(resumed.lastOutcome,"partial");
  assert.deepEqual(calls,["ranks","infos"]);
});
