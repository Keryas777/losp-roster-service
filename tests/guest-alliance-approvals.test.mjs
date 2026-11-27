import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {ROSTER_APPROVAL_KEY,readApproval} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY,GUEST_INITIAL_SYNC_STATE_ROOT,readGuestApprovals,
  readGuestInitialSyncState,readCollectibleApprovals,handleGuestAllianceApproval}
  from "../src/guest-alliance-approvals.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const hash=s=>createHash("sha256").update(s).digest("hex");
const guest=hash("outside-aid"),losp=hash("losp-aid");
function fixture(role="captain",options={}){
  const store=options.store||new Map(),etags=options.etags||new Map(),
    calls=[],bucketWrites=[],failures={writeKey:null};
  const state={role};
  state.aid=options.aid||"outside-aid";
  if(!store.has(ROSTER_APPROVAL_KEY)){
    store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
      alliances:[{fingerprint:losp,name:"Zeus"}]}));
    etags.set(ROSTER_APPROVAL_KEY,"etag-losp");
  }
  let etagCounter=0;
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"ac".repeat(32),
    CAPTAIN_BUCKET:{
      get:async k=>store.has(k)?{text:async()=>store.get(k),etag:etags.get(k)}:null,
      put:async(k,v,options={})=>{
        bucketWrites.push(k);
        if(failures.writeKey===k){failures.writeKey=null;
          throw Error("simulated-r2-write-failure");}
        const onlyIf=options.onlyIf||{};
        if(onlyIf.etagDoesNotMatch==="*"&&store.has(k))return null;
        if(onlyIf.etagMatches&&onlyIf.etagMatches!==etags.get(k))return null;
        store.set(k,v);
        const etag="etag-"+(++etagCounter);
        etags.set(k,etag);
        return {etag};
      },
      delete:async k=>{store.delete(k);etags.delete(k);},
      list:async({prefix,limit=1000}={})=>{
        const objects=prefix===CAPTAIN_PREFIX?
          [{key:CAPTAIN_PREFIX+(options.sessionKey||"a".repeat(64))}]:
          [...store.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}));
        return {objects:objects.slice(0,limit),truncated:objects.length>limit};
      }
    },
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:k=>k,
      get:()=>({fetch:async()=>Response.json({status:"active",accessToken:"SECRET"})})
    }
  };
  const provider=async(uri)=>{
    calls.push(uri);
    if(uri.endsWith("/alliance/card"))
      return Response.json({data:{id:state.aid+":v1",name:"Invités de test"}});
    if(uri.endsWith("/alliance/members"))
      return Response.json({data:[
        {id:"self",isSelf:true,rank:state.role,
          card:{name:"Leader",rosterShare:false}},
        {id:"co",isSelf:false,rank:"member",
          card:{name:"Membre",rosterShare:true}}
      ]});
    throw Error("Unexpected request: "+uri);
  };
  const request=(fingerprint,action="approve",override={})=>new Request(origin+
    "/admin/api/guest-alliance-approval",{
      method:"POST",headers:{Origin:override.origin||origin,
        "Content-Type":"application/json"},
      body:JSON.stringify({fingerprint,action,
        ...(override.allianceKey?{allianceKey:override.allianceKey}:{})})
    });
  return {env,store,etags,calls,bucketWrites,failures,state,provider,request};
}
test("a captain can explicitly enroll her own current guest alliance, without altering LoSP",async()=>{
  const f=fixture();
  const before=(await readApproval(f.env)).alliances;
  const response=await handleGuestAllianceApproval(f.request(guest),f.env,f.provider);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:"approved",count:1});
  const raw=f.store.get(GUEST_APPROVAL_KEY);
  const saved=JSON.parse(raw);
  assert.deepEqual(saved.alliances,[{fingerprint:guest}]);
  assert.doesNotMatch(raw,/SECRET|Invités de test|Leader|Membre|outside-aid/);
  assert.deepEqual((await readApproval(f.env)).alliances,before);
  const merged=await readCollectibleApprovals(f.env);
  assert.deepEqual(merged.lospAlliances,before);
  assert.deepEqual(merged.guestAlliances.map(a=>a.fingerprint),[guest]);
  assert.equal(merged.status,"configured");
  assert.ok(f.calls.every(u=>!u.includes("/roster")));
  const duplicate=await handleGuestAllianceApproval(f.request(guest),f.env,f.provider);
  assert.equal((await duplicate.json()).status,"already-approved");
  const revoked=await handleGuestAllianceApproval(f.request(guest,"revoke"),
    f.env,f.provider);
  assert.equal((await revoked.json()).status,"revoked");
  assert.equal((await readGuestApprovals(f.env)).alliances.length,0);
  assert.deepEqual((await readApproval(f.env)).alliances,before);
});
test("explicit admin approval relies on current membership and OAuth, not an in-game rank",async()=>{
  const f=fixture("member");
  const result=await handleGuestAllianceApproval(f.request(guest),f.env,f.provider);
  assert.equal(result.status,200);
  assert.equal((await result.json()).status,"approved");
  assert.ok(f.calls.some(url=>url.endsWith("/alliance/members")));
  assert.ok(f.calls.every(url=>!url.includes("/roster")));
  assert.deepEqual((await readGuestApprovals(f.env)).alliances,[{fingerprint:guest}]);
});
test("guest enrollment rejects foreign origin, nonexistent alliance and LoSP promotion",async()=>{
  const f=fixture();
  assert.equal((await handleGuestAllianceApproval(f.request(guest,"approve",{
    origin:"https://evil.example"
  }),f.env,f.provider)).status,403);
  assert.equal((await handleGuestAllianceApproval(f.request("e".repeat(64)),
    f.env,f.provider)).status,409);
  assert.equal((await handleGuestAllianceApproval(f.request(losp),
    f.env,f.provider)).status,409);
  assert.equal(f.store.has(GUEST_APPROVAL_KEY),false);
});
test("guest approval + WebApp binding enqueues the immediate catch-up without any roster GET",async()=>{
  const f=fixture();
  f.env.ROSTER_BATCH_LOCK={idFromName:name=>name,
    get:()=>({fetch:async req=>{
      const body=await req.json();
      return Response.json({status:body.action==="acquire"?"acquired":"released"});
    }})};
  const req=new Request(origin+"/admin/api/guest-alliance-approval",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({fingerprint:guest,action:"approve",
      allianceKey:"questionable-propriety"})
  });
  const result=await handleGuestAllianceApproval(req,f.env,f.provider);
  assert.equal(result.status,200);
  const response=await result.json();
  assert.equal(response.status,"approved");
  assert.equal(response.initialSync,"queued");
  const queue=f.store.get("roster-batches/v1/guest-initial-sync/"+guest+".json");
  assert.ok(queue);
  const saved=JSON.parse(queue);
  assert.equal(saved.phase,"ranks");
  assert.equal(saved.allianceKey,"questionable-propriety");
  assert.doesNotMatch(queue,/SECRET|Leader|Membre|outside-aid/);
  assert.ok(f.calls.every(uri=>!uri.includes("/roster")));
});

test("a broken guest registry fails closed for guests but leaves LoSP available",async()=>{
  const f=fixture();
  f.store.set(GUEST_APPROVAL_KEY,'{"version":1,"alliances":[{"fingerprint":"bad"}]}');
  assert.equal((await readGuestApprovals(f.env)).status,"invalid-registry");
  const merged=await readCollectibleApprovals(f.env);
  assert.equal(merged.status,"configured");
  assert.equal(merged.guestRegistryStatus,"invalid-registry");
  assert.equal(merged.guestAlliances.length,0);
  assert.deepEqual(merged.alliances.map(a=>a.fingerprint),[losp]);
});
test("LoSP always wins if the same fingerprint is present in both registries",async()=>{
  const f=fixture();
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:losp},{fingerprint:guest}]}));
  const merged=await readCollectibleApprovals(f.env);
  assert.equal(merged.alliances.length,2);
  assert.deepEqual(merged.guestAlliances.map(a=>a.fingerprint),[guest]);
});

test("an approved guest can be bound to exactly one stable WebApp key",async()=>{
  const f=fixture();
  await handleGuestAllianceApproval(f.request(guest),f.env,f.provider);
  const action=(fingerprint,mode,allianceKey)=>new Request(origin+
    "/admin/api/guest-alliance-approval",{
      method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint,action:mode,
        ...(allianceKey?{allianceKey}:{})})
    });
  const beforeCalls=f.calls.length;
  let response=await handleGuestAllianceApproval(
    action(guest,"bind","endgame-revolution-red"),f.env,f.provider);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,"bound");
  assert.equal(f.calls.length,beforeCalls,"binding needs no new Scopely scan");
  assert.deepEqual((await readGuestApprovals(f.env)).alliances,
    [{fingerprint:guest,allianceKey:"endgame-revolution-red"}]);
  const second=hash("another-invited-aid");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:guest,allianceKey:"endgame-revolution-red"},
    {fingerprint:second}]}));
  response=await handleGuestAllianceApproval(
    action(second,"bind","endgame-revolution-red"),f.env,f.provider);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,"alliance-key-already-bound");
  response=await handleGuestAllianceApproval(
    action(guest,"bind","endgame-revolution-orange"),f.env,f.provider);
  assert.equal((await response.json()).status,"bound");
  assert.equal((await readGuestApprovals(f.env)).alliances[0].allianceKey,
    "endgame-revolution-orange");
  assert.equal((await readGuestInitialSyncState(f.env,guest,
    "endgame-revolution-orange")).status,"binding-changed");
  response=await handleGuestAllianceApproval(
    action(guest,"unbind"),f.env,f.provider);
  assert.equal((await response.json()).status,"unbound");
  assert.deepEqual((await readGuestApprovals(f.env)).alliances[0],
    {fingerprint:guest});
  assert.equal((await handleGuestAllianceApproval(
    action(second,"bind","zeus !!"),f.env,f.provider)).status,400);
  assert.deepEqual((await readApproval(f.env)).alliances,
    [{fingerprint:losp,name:"Zeus"}]);
});

test("admin approval records the guest WebApp key atomically",async()=>{
  const f=fixture();
  const req=(fingerprint,allianceKey)=>new Request(origin+
    "/admin/api/guest-alliance-approval",{
      method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint,action:"approve",allianceKey})
    });
  const response=await handleGuestAllianceApproval(
    req(guest,"endgame-revolution-orange"),f.env,f.provider);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,"approved");
  assert.deepEqual((await readGuestApprovals(f.env)).alliances,
    [{fingerprint:guest,allianceKey:"endgame-revolution-orange"}]);
  const lifecycle=JSON.parse(f.store.get(
    GUEST_INITIAL_SYNC_STATE_ROOT+guest+".json"));
  assert.equal(lifecycle.status,"pending");
  assert.ok(f.bucketWrites.indexOf(GUEST_INITIAL_SYNC_STATE_ROOT+guest+".json")<
    f.bucketWrites.indexOf(GUEST_APPROVAL_KEY),
    "durable intent is saved before the approval CAS");
  assert.deepEqual(Object.keys(JSON.parse(f.store.get(GUEST_APPROVAL_KEY))
    .alliances[0]).sort(),["allianceKey","fingerprint"]);
  assert.ok(f.calls.every(url=>!url.includes("/roster")));
  const repeat=await handleGuestAllianceApproval(
    req(guest,"endgame-revolution-orange"),f.env,f.provider);
  assert.equal((await repeat.json()).status,"already-approved");
  assert.equal((await handleGuestAllianceApproval(
    req(guest,"endgame-revolution-red"),f.env,f.provider)).status,409);
  assert.equal((await readGuestApprovals(f.env)).alliances[0].allianceKey,
    "endgame-revolution-orange");
});
test("previously approved unbound alliance can be bound without new Scopely calls",async()=>{
  const f=fixture();
  await handleGuestAllianceApproval(f.request(guest),f.env,f.provider);
  const before=f.calls.length;
  const response=await handleGuestAllianceApproval(new Request(origin+
    "/admin/api/guest-alliance-approval",{
      method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint:guest,action:"approve",
        allianceKey:"marines"})
    }),f.env,f.provider);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,"already-approved");
  assert.equal(f.calls.length,before);
  assert.deepEqual((await readGuestApprovals(f.env)).alliances,
    [{fingerprint:guest,allianceKey:"marines"}]);
});
test("failed lifecycle-marker write prevents a silent approval without durable intent",async()=>{
  const f=fixture(),stateKey=GUEST_INITIAL_SYNC_STATE_ROOT+guest+".json";
  f.failures.writeKey=stateKey;
  const request=()=>new Request(origin+"/admin/api/guest-alliance-approval",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({fingerprint:guest,action:"approve",
      allianceKey:"french-legion"})
  });
  const failed=await handleGuestAllianceApproval(request(),f.env,f.provider);
  assert.equal(failed.status,503);
  assert.equal(f.store.has(GUEST_APPROVAL_KEY),false);
  assert.equal(f.store.has(stateKey),false);
  const retry=await handleGuestAllianceApproval(request(),f.env,f.provider);
  assert.equal(retry.status,200);
  assert.equal(JSON.parse(f.store.get(stateKey)).status,"pending");
  assert.ok([...f.store.keys()].some(k=>k.startsWith(
    "roster-batches/v1/guest-initial-sync/")));
});
test("interruption after intent write but before approval CAS is recovered by retry",async()=>{
  const f=fixture(),stateKey=GUEST_INITIAL_SYNC_STATE_ROOT+guest+".json";
  const request=()=>new Request(origin+"/admin/api/guest-alliance-approval",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({fingerprint:guest,action:"approve",
      allianceKey:"french-legion"})
  });
  const originalPut=f.env.CAPTAIN_BUCKET.put;
  f.env.CAPTAIN_BUCKET.put=async(key,...args)=>{
    if(key===GUEST_APPROVAL_KEY)throw Error("simulated-worker-interruption");
    return originalPut(key,...args);
  };
  assert.equal((await handleGuestAllianceApproval(request(),f.env,f.provider)).status,503);
  assert.equal(JSON.parse(f.store.get(stateKey)).status,"pending");
  assert.equal(f.store.has(GUEST_APPROVAL_KEY),false);
  f.env.CAPTAIN_BUCKET.put=originalPut;
  const retried=await handleGuestAllianceApproval(request(),f.env,f.provider);
  assert.equal(retried.status,200);
  assert.equal(JSON.parse(f.store.get(stateKey)).status,"pending");
  assert.ok([...f.store.keys()].some(k=>k.startsWith(
    "roster-batches/v1/guest-initial-sync/")));
});
test("atomic binding refuses a duplicate or malformed guest key",async()=>{
  const f=fixture(),other=hash("another-aid");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:other,allianceKey:"marines"}]}));
  const req=allianceKey=>new Request(origin+"/admin/api/guest-alliance-approval",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({fingerprint:guest,action:"approve",allianceKey})
  });
  let response=await handleGuestAllianceApproval(req("marines"),f.env,f.provider);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,"alliance-key-already-bound");
  response=await handleGuestAllianceApproval(req("bad key"),f.env,f.provider);
  assert.equal(response.status,400);
  assert.deepEqual((await readGuestApprovals(f.env)).alliances,
    [{fingerprint:other,allianceKey:"marines"}]);
});

test("simultaneous guest approvals retain every binding and queue each tenant once",async()=>{
  const store=new Map(),etags=new Map();
  const aidA="concurrent-guest-aid-a",aidB="concurrent-guest-aid-b";
  const fpA=hash(aidA),fpB=hash(aidB);
  const a=fixture("captain",{store,etags,aid:aidA,sessionKey:"b".repeat(64)});
  const b=fixture("captain",{store,etags,aid:aidB,sessionKey:"c".repeat(64)});
  const [responseA,responseB]=await Promise.all([
    handleGuestAllianceApproval(a.request(fpA,"approve",{
      allianceKey:"new-age-of-pymps"}),a.env,a.provider),
    handleGuestAllianceApproval(b.request(fpB,"approve",{
      allianceKey:"french-legion"}),b.env,b.provider)
  ]);
  assert.equal(responseA.status,200);
  assert.equal(responseB.status,200);
  const registry=await readGuestApprovals(a.env);
  assert.deepEqual(new Map(registry.alliances.map(row=>[
    row.fingerprint,row.allianceKey])),new Map([
      [fpA,"new-age-of-pymps"],[fpB,"french-legion"]
    ]));
  for(const fp of [fpA,fpB]){
    const raw=store.get("roster-batches/v1/guest-initial-sync/"+fp+".json");
    assert.ok(raw,"both concurrent approvals must leave a durable request");
    assert.equal(JSON.parse(raw).status,"queued");
  }
  assert.ok([...a.calls,...b.calls].every(uri=>!uri.includes("/roster")));
});
