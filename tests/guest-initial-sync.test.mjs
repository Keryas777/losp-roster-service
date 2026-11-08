import test from "node:test";
import assert from "node:assert/strict";
import {enqueueGuestInitialSync,guestInitialSyncStatus,
  runGuestInitialSyncTick,handleGuestInitialSync,
  dispatchInitialGuestDirectory} from "../src/guest-initial-sync.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";

const FP="a".repeat(64),KEY="questionable-propriety";
const START=Date.parse("2026-11-08T08:00:00Z");
const URL="https://losp-roster-service.deliriousfan7.workers.dev";
function fixture(){
  const store=new Map(),call=[];
  store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:FP,allianceKey:KEY}]}));
  const bucket={
    get:async key=>store.has(key)?{text:async()=>store.get(key),
      size:store.get(key).length}:null,
    put:async (key,value)=>{store.set(key,value);},
    delete:async key=>{store.delete(key);},
    list:async ({prefix,limit})=>({truncated:false,
      objects:[...store.keys()].filter(key=>key.startsWith(prefix))
        .slice(0,limit).map(key=>({key}))})
  };
  const env={CAPTAIN_BUCKET:bucket,
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    ROSTER_AUTO_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    MEMBER_INFO_AUTO_ENABLED:"true",
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key},
    ROSTER_BATCH_LOCK:{idFromName:key=>key,
      get:()=>({fetch:async req=>{
        const payload=await req.json();
        return Response.json({status:payload.action==="acquire"?
          "acquired":"released"});
      }})}
  };
  return {store,env,call};
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
test("new approved and bound alliance is queued once; phases finish after restart-safe ticks",async()=>{
  const f=fixture(),steps=[];
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,START)).status,"queued");
  assert.equal((await enqueueGuestInitialSync(f.env,FP,KEY,START)).status,"queued");
  assert.equal((await guestInitialSyncStatus(f.env,FP)).phase,"infos");
  for(let i=0;i<6;i++){
    const res=await runGuestInitialSyncTick(f.env,START+i*60000,
      async()=>{throw Error("No unmocked Scopely calls");},deps(steps));
    assert.notEqual(res.status,"unavailable");
  }
  assert.deepEqual(steps,["infos","infos","roster","ranks","arena","trophies"]);
  const end=await guestInitialSyncStatus(f.env,FP);
  assert.equal(end.status,"complete");
  assert.equal(end.phase,"done");
  assert.equal(end.attempts,6);
  assert.equal((await runGuestInitialSyncTick(f.env,START+6*60000,
    async()=>{throw Error("not called");},deps(steps))).status,"idle");
  assert.equal(steps.length,6);
  assert.equal([...f.store.keys()].filter(k=>k.endsWith("/"+FP+".json")).length,1);
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
  assert.equal((await first.json()).status,"not-started");
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
