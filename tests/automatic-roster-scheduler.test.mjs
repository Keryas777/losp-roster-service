import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {completeKey,BATCH_PREFIX} from "../src/private-roster-batches.js";
import {ROSTER_CRON,TICK_API_BUDGET,rosterWindow,manualRosterWindow,runRosterAutoTick,rosterAutoStatus,handleAdminRosterAutoTest} from "../src/automatic-roster-scheduler.js";
import worker from "../src/index.js";
import {handleAdmin} from "../src/admin-routes.js";

const hash=s=>createHash("sha256").update(s).digest("hex");
const fp=hash("aid007"),token="TOKEN_PRIVATE";
const grantKey=CAPTAIN_PREFIX+"1".repeat(64);
const d=stamp=>Date.parse(stamp);
const controller=time=>({cron:ROSTER_CRON,scheduledTime:d(time)});
function fixture(){
 const store=new Map(),calls=[],objects=new Map();
 const flags={revoke:false,limit:false,changed:false};
 store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
   {fingerprint:fp,name:"Zeus"}]}));
 const bucket={
   get:async k=>store.has(k)?{text:async()=>store.get(k)}:null,
   put:async(k,v)=>{store.set(k,typeof v==="string"?v:await v.text())},
   delete:async k=>{store.delete(k)},
   list:async({prefix})=>({objects:prefix===CAPTAIN_PREFIX?
     [{key:grantKey}]:[],truncated:false})
 };
 const locks={
   idFromName:x=>x,
   get:id=>{
     if(!objects.has(id)){
       const data=new Map();
       objects.set(id,new RosterBatchLock({storage:{
         get:async k=>data.get(k),
         put:async(k,v)=>{data.set(k,v)},
         delete:async k=>{data.delete(k)}
       }}));
     }
     return {fetch:req=>objects.get(id).fetch(req)};
   }
 };
 const env={
   CAPTAIN_SESSIONS_ENABLED:"true",
   CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
   ROSTER_AUTO_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
   CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:locks,
   CAPTAIN_REFRESH_COORDINATOR:{
     idFromName:k=>k,get:()=>({fetch:async req=>{
       assert.equal((await req.json()).action,"access");
       return Response.json({status:"active",accessToken:token});
     }})
   }
 };
 const members=()=>[
   {id:"self",isSelf:true,card:{name:"Captain",rosterShare:true}},
   {id:"co1",isSelf:false,card:{name:"Co1",rosterShare:true}},
   {id:"co2",isSelf:false,card:{name:"Co2",rosterShare:!flags.revoke}}
 ];
 const data=who=>Array.from({length:10},(_,i)=>({
   id:who+"_char"+i,power:100000+i+(flags.changed?10:0),gear:20
 }));
 const fetchImpl=async(url,opts)=>{
   calls.push(url);
   assert.equal(opts.headers.Authorization,"Bearer "+token);
   if(url.endsWith("/alliance/card"))
     return Response.json({data:{id:"aid007:v1",name:"Zeus"}});
   if(url.endsWith("/alliance/members"))
     return Response.json({data:members()});
   if(url.includes("/player/v1/roster")){
     if(flags.limit)return new Response(null,{status:429});
     const u=new URL(url),who=u.pathname==="/player/v1/roster"?
       "self":u.pathname.split("/").at(-1);
     if(u.searchParams.get("since")==="ASOF_1"&&!flags.changed)
       return new Response(null,{status:344});
     const chars=data(who);
     return Response.json({data:chars,meta:{perTotal:chars.length,asOf:"ASOF_1"}});
   }
   throw Error("Unexpected URL: "+url);
 };
 return {env,store,calls,flags,fetchImpl};
}
test("only valid scheduled 1-minute UTC windows start campaigns",()=>{
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T02:00:00Z")).campaign,"2026-10-18-am");
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T05:58:00Z")).tick,238);
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T14:00:00Z")).campaign,"2026-10-18-pm");
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T06:00:00Z")),null);
 // The first minute after a scheduled boundary may still belong to the
 // same one-minute cron slot, because real Cloudflare dispatches can be delayed.
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T14:01:00Z")).stamp,
   "2026-10-18T14:00Z");
 assert.equal(rosterWindow("15 3 * * *",d("2026-10-18T03:15:00Z")),null);
});
test("real Cloudflare cron event 07:50:31 French time maps to 05:50 UTC",()=>{
 // Cloudflare Observability 2026-10-19 07:50:32 UTC+2, event at 05:50:31.718Z.
 // ScheduledController.scheduledTime is milliseconds; logs print seconds.
 const observed=d("2026-10-19T05:50:31.718Z");
 const result=rosterWindow(ROSTER_CRON,observed);
 assert.deepEqual(result,{
   date:"2026-10-19",campaign:"2026-10-19-am",
   tick:230,stamp:"2026-10-19T05:50Z"
 });
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-19T05:50:59.999Z")).stamp,
   result.stamp);
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-19T05:51:29Z")).stamp,
   result.stamp);
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-19T05:52:31.718Z")).stamp,
   "2026-10-19T05:52Z");
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-19T06:00:32Z")),null);
});
test("delayed cron runs once per logical 1-minute slot despite duplicate events",async()=>{
 const f=fixture();
 const first=await runRosterAutoTick(f.env,controller("2026-10-19T05:50:31.718Z"),f.fetchImpl);
 assert.equal(first.status,"complete-co-members");
 assert.ok(first.requestsThisTick>0);
 const before=f.calls.length;
 const same=await runRosterAutoTick(f.env,controller("2026-10-19T05:50:57.123Z"),f.fetchImpl);
 assert.equal(same.status,"already-processed");
 assert.equal(f.calls.length,before);
 const next=await runRosterAutoTick(f.env,controller("2026-10-19T05:52:31.718Z"),f.fetchImpl);
 assert.equal(next.status,"complete");
 assert.ok(f.store.has(completeKey(fp)));
});
test("disabled and retention-unconfirmed are fail-closed with zero Scopely requests",async()=>{
 const f=fixture();
 f.env.ROSTER_AUTO_ENABLED="false";
 assert.equal((await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl)).status,"disabled");
 f.env.ROSTER_AUTO_ENABLED="true";f.env.ROSTER_RETENTION_CONFIRMED="false";
 assert.equal((await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl)).status,"retention-not-confirmed");
 assert.equal(f.calls.length,0);
});
test("AM and PM campaigns read both co-members and personal account, publish only when complete",async()=>{
 const f=fixture();
 const morning=["02:00","02:02"],evening=["14:00","14:02"];
 for(const [n,t] of morning.entries()){
   const res=await runRosterAutoTick(f.env,controller("2026-10-18T"+t+":00Z"),f.fetchImpl);
   assert.ok(["in-progress","complete-co-members","complete"].includes(res.status),JSON.stringify(res));
   if(n===0)assert.equal(f.store.has(completeKey(fp)),false);
 }
 let first=JSON.parse(f.store.get(completeKey(fp)));
 assert.equal(first.total,3);
 assert.equal(first.includesPersonal,true);
 assert.equal(first.observedMembers,3);
 const r2Personal=JSON.parse(f.store.get(BATCH_PREFIX+fp+"/"+first.runId+"/member-self.json"));
 assert.equal(r2Personal.characters.length,10);
 const apiBefore=f.calls.filter(u=>u.includes("/roster")).length;
 for(const t of evening){
   const res=await runRosterAutoTick(f.env,controller("2026-10-18T"+t+":00Z"),f.fetchImpl);
   assert.ok(["in-progress","complete-co-members","complete"].includes(res.status),JSON.stringify(res));
 }
 const second=JSON.parse(f.store.get(completeKey(fp)));
 assert.notEqual(first.runId,second.runId);
 const fetches=f.calls.filter(u=>u.includes("/roster"));
 assert.equal(fetches.length-apiBefore,3);
 assert.ok(fetches.slice(apiBefore).every(url=>new URL(url).searchParams.get("since")==="ASOF_1"));
 const status=await rosterAutoStatus(f.env,d("2026-10-18T16:00:00Z"));
 assert.equal(status.enabled,true);
 assert.ok(status.requestsToday>0&&status.requestsToday<80);
 assert.equal((await worker.fetch(new Request("https://losp-roster-service.deliriousfan7.workers.dev/api/rosters"),f.env)).status,404);
});
test("duplicate cron invocation is idempotent: never re-downloads a roster",async()=>{
 const f=fixture(),time="2026-10-18T02:00:00Z";
 await runRosterAutoTick(f.env,controller(time),f.fetchImpl);
 const before=f.calls.length;
 const r=await runRosterAutoTick(f.env,controller(time),f.fetchImpl);
 assert.equal(r.status,"already-processed");
 assert.equal(f.calls.length,before);
});
test("a rate-limit creates a 60-minute per-alliance cooldown",async()=>{
 const f=fixture();f.flags.limit=true;
 const first=await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 assert.equal(first.status,"rate-limited");
 const before=f.calls.length;
 const second=await runRosterAutoTick(f.env,controller("2026-10-18T02:02:00Z"),f.fetchImpl);
 assert.equal(second.status,"cooldown");
 assert.equal(f.calls.length,before);
});
test("revoked member sharing still produces a truthful authorized-roster manifest",async()=>{
 const f=fixture();f.flags.revoke=true;
 await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 const last=await runRosterAutoTick(f.env,controller("2026-10-18T02:02:00Z"),f.fetchImpl);
 assert.equal(last.status,"partial-consent");
 const manifest=JSON.parse(f.store.get(completeKey(fp)));
 assert.equal(manifest.coverage,"authorized-only");
 assert.equal(manifest.total,2); // one consenting co-member + OAuth owner
 assert.equal(manifest.observedMembers,3);
 assert.equal(manifest.notSharedCount,1);
 assert.equal(manifest.coMembers,1);
 assert.equal(manifest.includesPersonal,true);
 assert.ok(f.store.has(BATCH_PREFIX+fp+"/"+manifest.runId+"/member-0.json"));
 assert.ok(f.store.has(BATCH_PREFIX+fp+"/"+manifest.runId+"/member-self.json"));
 assert.equal(f.calls.some(x=>x.includes("/roster/member/co2")),false,
   "Never fetch a roster after member opt-out");
 const next=await runRosterAutoTick(f.env,controller("2026-10-18T14:00:00Z"),f.fetchImpl);
 assert.ok(["in-progress","complete-co-members"].includes(next.status));
 const end=await runRosterAutoTick(f.env,controller("2026-10-18T14:02:00Z"),f.fetchImpl);
 assert.equal(end.status,"partial-consent");
 const current=JSON.parse(f.store.get(completeKey(fp)));
 assert.notEqual(current.runId,manifest.runId);
 assert.equal(current.notSharedCount,1);
});
test("per-invocation safety bound is independent of alliance count",()=>{
  assert.equal(TICK_API_BUDGET,24);
});
test("daily telemetry above the old 2500-GET ceiling does not block collection",async()=>{
  const f=fixture(),date="2026-10-18";
  f.store.set("roster-auto/v1/days/"+date+".json",JSON.stringify({
    date,used:2501,ticks:130,lastTick:null
  }));
  const result=await runRosterAutoTick(f.env,controller("2026-10-18T14:00:00Z"),f.fetchImpl);
  assert.ok(result.requestsThisTick>0,JSON.stringify(result));
  assert.notEqual(result.status,"daily-budget-reached");
  assert.ok(result.requestsToday>2501);
});
test("a crash after Scopely requests preserves the per-invocation idempotency checkpoint",async()=>{
 const f=fixture(),key="roster-auto/v1/days/2026-10-18.json";
 const original=f.env.CAPTAIN_BUCKET.put;
 f.env.CAPTAIN_BUCKET.put=async(k,v)=>{
   if(k===key&&JSON.parse(v).lastOutcome!=="reserved")
     throw Error("simulate Worker interruption before final counter commit");
   return original(k,v);
 };
 const first=await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 assert.equal(first.status,"unavailable");
 assert.ok(f.calls.length>0);
 const stored=JSON.parse(f.store.get(key));
 assert.equal(stored.used,0);
 assert.equal(stored.lastOutcome,"reserved");
 const before=f.calls.length;
 const repeat=await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 assert.equal(repeat.status,"already-processed");
 assert.equal(f.calls.length,before);
});

test("admin diagnostic runs a real, bounded AM microbatch at 12:46 French time",async()=>{
 const f=fixture(),at=d("2026-10-19T10:46:31.718Z");
 const window=manualRosterWindow(at);
 assert.equal(window.campaign,"2026-10-19-am");
 assert.equal(window.stamp,"2026-10-19T10:46Z");
 assert.equal(rosterWindow(ROSTER_CRON,at),null);
 const r=await handleAdminRosterAutoTest(new Request(
   "https://losp-roster-service.deliriousfan7.workers.dev/admin/api/roster-auto-test",{
     method:"POST",headers:{Origin:"https://losp-roster-service.deliriousfan7.workers.dev",
       "Content-Type":"application/json"},body:"{}"
   }),f.env,f.fetchImpl,at);
 assert.equal(r.status,200);
 const out=await r.json();
 assert.equal(out.status,"complete-co-members");
 assert.equal(out.alliance,"Zeus");
 assert.ok(out.requestsThisTick>0&&out.requestsThisTick<=TICK_API_BUDGET);
 assert.equal(f.calls.filter(x=>x.includes("/roster/member/")).length,2);
 const budget=JSON.parse(f.store.get("roster-auto/v1/days/2026-10-19.json"));
 assert.equal(budget.lastMode,"admin-test");
 assert.equal(budget.lastTick,"2026-10-19T10:46Z");
 assert.equal(budget.used,out.requestsThisTick);
 const progress=[...f.store.entries()].find(([k])=>k.endsWith("/progress.json"));
 assert.ok(progress);
 assert.equal(JSON.parse(progress[1]).completed,2);
});
test("repeated admin test in one slot is idempotent, next slot can finish personal roster",async()=>{
 const f=fixture(),at=d("2026-10-19T10:46:31.718Z");
 const run=time=>handleAdminRosterAutoTest(new Request(
   "https://losp-roster-service.deliriousfan7.workers.dev/admin/api/roster-auto-test",{
     method:"POST",headers:{Origin:"https://losp-roster-service.deliriousfan7.workers.dev",
       "Content-Type":"application/json"},body:"{}"
   }),f.env,f.fetchImpl,time);
 await run(at);
 const before=f.calls.length;
 const again=await (await run(at+10000)).json();
 assert.equal(again.status,"already-processed");
 assert.equal(f.calls.length,before);
 const next=await (await run(d("2026-10-19T10:48:32Z"))).json();
 assert.equal(next.status,"complete");
 assert.ok(f.store.has(completeKey(fp)));
 const secondMode=JSON.parse(f.store.get("roster-auto/v1/days/2026-10-19.json"));
 assert.equal(secondMode.lastMode,"admin-test");
});
test("admin test rejects GET, foreign Origin, extra parameters or missing JSON",async()=>{
 const f=fixture();
 const url="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/roster-auto-test";
 const variants=[
   [new Request(url),405],
   [new Request(url,{method:"POST",headers:{Origin:"https://evil.invalid",
     "Content-Type":"application/json"},body:"{}"}),403],
   [new Request(url,{method:"POST",headers:{Origin:new URL(url).origin,
     "Content-Type":"application/json"},body:'{"alliance":"Zeus"}'}),400],
   [new Request(url,{method:"POST",headers:{Origin:new URL(url).origin,
     "Content-Type":"text/plain"},body:"{}"}),403]
 ];
 for(const [req,status] of variants){
   const res=await handleAdminRosterAutoTest(req,f.env,f.fetchImpl,d("2026-10-19T10:46:31Z"));
   assert.equal(res.status,status);
 }
 assert.equal(f.calls.length,0);
 assert.equal(f.store.has("roster-auto/v1/days/2026-10-19.json"),false);
});
test("admin diagnostic ignores daily telemetry but respects disabled-mode guards",async()=>{
  const f=fixture(),t=d("2026-10-19T10:46:30Z");
  f.store.set("roster-auto/v1/days/2026-10-19.json",
    JSON.stringify({date:"2026-10-19",used:9999,ticks:4,lastTick:null}));
  const req=()=>new Request("https://losp-roster-service.deliriousfan7.workers.dev/admin/api/roster-auto-test",{
    method:"POST",headers:{Origin:"https://losp-roster-service.deliriousfan7.workers.dev",
      "Content-Type":"application/json"},body:"{}"
  });
  const allowed=await (await handleAdminRosterAutoTest(req(),f.env,f.fetchImpl,t)).json();
  assert.equal(allowed.status,"complete-co-members");
  assert.ok(f.calls.length>0);
  const before=f.calls.length;
  f.env.ROSTER_AUTO_ENABLED="false";
  const disabled=await (await handleAdminRosterAutoTest(req(),f.env,f.fetchImpl,t)).json();
  assert.equal(disabled.status,"disabled");
  assert.equal(f.calls.length,before);
});

test("private one-shot endpoint cannot be invoked without a Cloudflare Access admin JWT",async()=>{
 const f=fixture();
 const env={...f.env,MSF_ADMIN_ENABLED:"true",
   CF_ACCESS_TEAM_DOMAIN:"private-losp.cloudflareaccess.com",
   CF_ACCESS_AUD:"a".repeat(64),
   MSF_ADMIN_EMAILS:"admin@example.test"};
 const req=new Request("https://losp-roster-service.deliriousfan7.workers.dev/admin/api/roster-auto-test",{
   method:"POST",headers:{Origin:"https://losp-roster-service.deliriousfan7.workers.dev",
     "Content-Type":"application/json"},body:"{}"
 });
 const result=await handleAdmin(req,env,f.fetchImpl);
 assert.equal(result.status,403);
 assert.equal(f.calls.length,0);
 assert.equal(f.store.has("roster-auto/v1/days/2026-10-19.json"),false);
});
