import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {completeKey,BATCH_PREFIX} from "../src/private-roster-batches.js";
import {ROSTER_CRON,rosterWindow,runRosterAutoTick,rosterAutoStatus} from "../src/automatic-roster-scheduler.js";
import worker from "../src/index.js";

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
test("only valid scheduled 2-minute UTC windows start campaigns",()=>{
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T02:00:00Z")).campaign,"2026-10-18-am");
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T05:58:00Z")).tick,119);
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T14:00:00Z")).campaign,"2026-10-18-pm");
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T06:00:00Z")),null);
 assert.equal(rosterWindow(ROSTER_CRON,d("2026-10-18T14:01:00Z")),null);
 assert.equal(rosterWindow("15 3 * * *",d("2026-10-18T03:15:00Z")),null);
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
   assert.ok(["in-progress","complete"].includes(res.status),JSON.stringify(res));
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
   assert.ok(["in-progress","complete"].includes(res.status),JSON.stringify(res));
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
test("a revoked sharing permission cannot produce a misleading complete snapshot",async()=>{
 const f=fixture();f.flags.revoke=true;
 await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 const last=await runRosterAutoTick(f.env,controller("2026-10-18T02:02:00Z"),f.fetchImpl);
 assert.equal(last.status,"partial-consent");
 assert.equal(f.store.has(completeKey(fp)),false);
});
test("daily API request budget stops new batches without spending the reserve",async()=>{
 const f=fixture(),date="2026-10-18";
 f.store.set("roster-auto/v1/days/"+date+".json",JSON.stringify({
   date,used:940,ticks:30,lastTick:null
 }));
 const result=await runRosterAutoTick(f.env,controller("2026-10-18T02:00:00Z"),f.fetchImpl);
 assert.equal(result.status,"daily-budget-reached");
 assert.equal(f.calls.length,0);
});
