import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import worker from "../src/index.js";
import {handleAdmin} from "../src/admin-routes.js";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {BATCH_PREFIX,handleRosterMicrobatch,getRosterBatchStatus} from "../src/private-roster-batches.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const hash=s=>createHash("sha256").update(s).digest("hex");
const fingerprint=hash("aid-zeus");
const otherFinger=hash("aid-kronos");
const users=["A","B","C","D","E"];
const mkMember=(id,isSelf=false,share=true)=>({
  id,isSelf,card:{name:"Player "+id,rosterShare:share}
});
const request=(fp=fingerprint,extra={})=>
  new Request(origin+"/admin/api/roster-batch",{method:"POST",
    headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({fingerprint:fp,...extra})});
const statusRequest=fp=>new Request(origin+"/admin/api/roster-batch-status?fingerprint="+fp);
function fixture({noOptout=false,members=users}={}){
 const store=new Map(),logs=[],storage=new Map(),counters={calls:0,revision:0,reorder:false,changedRosters:false,conditionalHits:0};
 store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
   {name:"Zeus",fingerprint},
   {name:"Kronos",fingerprint:otherFinger}
 ]}));
 const lock=new RosterBatchLock({storage:{
   get:async k=>storage.get(k),put:async(k,v)=>{storage.set(k,v)},
   delete:async k=>{storage.delete(k)}
 }});
 const env={
   CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
   CAPTAIN_BUCKET:{
     get:async k=>store.has(k)?{text:async()=>store.get(k)}:null,
     put:async(k,v)=>{store.set(k,v);logs.push(k)},
     delete:async k=>store.delete(k),
     list:async({prefix})=>({objects:prefix===CAPTAIN_PREFIX?
       ["c","d"].map(k=>({key:CAPTAIN_PREFIX+k.repeat(64)})):[],truncated:false})
   },
   CAPTAIN_REFRESH_COORDINATOR:{
     idFromName:k=>k,
     get:key=>({fetch:async req=>{
       assert.equal((await req.json()).action,"access");
       return Response.json({status:"active",accessToken:
         key.includes("c".repeat(64))?"TOKEN_Z":"TOKEN_K"});
     }})
   },
   ROSTER_BATCH_LOCK:{
     idFromName:fp=>fp,get:()=>({fetch:req=>lock.fetch(req)})
   }
 };
 const api=async(url,opts)=>{
   counters.calls++;
   const token=opts.headers.Authorization.split(" ")[1];
   const aid=token==="TOKEN_K"?"aid-kronos":"aid-zeus";
   if(url.endsWith("/alliance/card"))
     return Response.json({data:{id:aid+":version1",name:aid,
       futureField:{unknownKey:"preserved",nested:{enabled:true}}},
       meta:{serverSchema:"opaque",version:77}});
   if(url.endsWith("/alliance/members"))return Response.json({data:[
     mkMember("self",true),...(counters.reorder?[...members].reverse():members).map((x,i)=>mkMember(
       counters.revision&&i===2?x+"-changed":x)),...(noOptout?[]:[mkMember("private",false,false)])
   ],meta:{arbitraryProviderField:{deep:"kept"}}});
   if(new URL(url).pathname==="/player/v1/roster"){
     const u=new URL(url),since=u.searchParams.get("since");
     if(since==="2026-10-18")return new Response(null,{status:344});
     const chars=Array.from({length:207},(_,i)=>({
       id:"self_char_"+i,power:220000+i,gear:20,iso8:{class:"striker"}
     }));
     return Response.json({data:chars,meta:{perTotal:207,asOf:"2026-10-18"}});
   }
   if(url.includes("/roster/member/")){
     const u=new URL(url),id=u.pathname.split("/").at(-1);
     assert.notEqual(id,"private");assert.notEqual(id,"self");
     const conditional=u.searchParams.get("since");
     if(conditional==="2026-10-18"&&!counters.changedRosters){
       counters.conditionalHits++;
       return new Response(null,{status:344});
     }
     const page=Number(u.searchParams.get("page")||1);
     const perPage=u.searchParams.has("perPage")?Number(u.searchParams.get("perPage")):207;
     const chars=Array.from({length:207},(_,i)=>({
       id:id+"_c"+i,power:200000+i+(counters.changedRosters?100:0),gear:20,
       iso8:{class:"striker"}
     }));
     const paged=u.searchParams.has("perPage");
     return Response.json({data:chars.slice((page-1)*perPage,page*perPage),
       meta:{...(paged?{page,perPage}:{}),perTotal:207,
         asOf:counters.changedRosters?"2026-10-19":"2026-10-18",
         newProviderMeta:{opaque:"retained"}},
       unexpectedRosterField:{unknown:true}});
   }
   throw Error("Bad provider URL "+url);
 };
 return {store,logs,counters,storage,env,api,lock};
}
test("an automatic alliance batch reads one shared roster within the 24-GET budget",async()=>{
  const members=Array.from({length:11},(_,i)=>"Member"+String(i).padStart(2,"0"));
  const f=fixture({members,noOptout:true}),now=Date.UTC(2026,9,24,17);
  const res=await handleRosterMicrobatch(request(),f.env,f.api,now,{
    campaign:"2026-10-24-pm",tick:"2026-10-24T17:00Z"
  });
  assert.equal(res.status,200);
  const data=await res.json();
  assert.equal(data.savedThisBatch,1);
  assert.equal(data.completed,1);
  assert.equal(data.remaining,10);
  assert.equal(data.status,"in-progress");
  assert.ok(data.requestsThisBatch<=24);
  const saved=[...f.store.keys()].filter(k=>/\/member-[0-9]+\.json$/.test(k));
  assert.equal(saved.length,1);
});
test("a two-player batch persists only complete separate R2 objects and advances after writes",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 const begin=await getRosterBatchStatus(statusRequest(fingerprint),f.env,now);
 assert.equal((await begin.json()).status,"not-started");
 const res=await handleRosterMicrobatch(request(),f.env,f.api,now);
 assert.equal(res.status,200);
 const body=await res.json();
 assert.equal(body.status,"in-progress");
 assert.equal(body.savedThisBatch,2);
 assert.equal(body.charactersThisBatch,414);
 assert.equal(body.completed,2);assert.equal(body.eligibleCoMembers,5);
 assert.equal(body.remaining,3);
 assert.equal(body.pagesThisBatch,2);
 assert.equal(body.publiclyAvailable,false);
 const state=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 assert.equal(state.completed,2);
 assert.equal(state.totalEligible,5);
 assert.match(state.membershipDigest,/^[a-f0-9]{64}$/);
 const playerRecords=f.logs.filter(k=>k.includes("/member-"));
 assert.equal(playerRecords.length,2);
 assert.deepEqual(playerRecords.map(k=>k.split("/").at(-1)),["member-0.json","member-1.json"]);
 assert.equal(JSON.parse(f.store.get(playerRecords[0])).characters.length,207);
 assert.equal(f.logs.at(-1),BATCH_PREFIX+fingerprint+"/progress.json");
 assert.doesNotMatch(JSON.stringify(body),/TOKEN_|Player A|_c0/);
});
test("validated microbatch archives every alliance-card and membership JSON field without extra GETs",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,19,14);
 const response=await handleRosterMicrobatch(request(),f.env,f.api,now);
 assert.equal(response.status,200);
 const source=[...f.store.keys()].filter(key=>key.includes("/provider-source/"));
 assert.equal(source.length,5); // card, 2 member checks, 2 full roster responses
 assert.ok(source.every(key=>key.startsWith(BATCH_PREFIX+fingerprint+"/")));
 const card=JSON.parse(f.store.get(source.find(key=>key.endsWith("/alliance-card.json"))));
 assert.equal(card.endpoint,"/player/v1/alliance/card");
 assert.equal(card.providerResponse.data.futureField.nested.enabled,true);
 assert.equal(card.providerResponse.meta.serverSchema,"opaque");
 const members=JSON.parse(f.store.get(source.find(key=>key.endsWith("/members-before.json"))));
 assert.equal(members.providerResponse.meta.arbitraryProviderField.deep,"kept");
 assert.ok(members.providerResponse.data.some(v=>v.id==="private"&&v.card.rosterShare===false));
 const after=JSON.parse(f.store.get(source.find(key=>key.endsWith("/members-after.json"))));
 assert.deepEqual(after.providerResponse,members.providerResponse);
 const firstRoster=JSON.parse(f.store.get(source.find(key=>key.endsWith("/roster-member-0-page-0.json"))));
 assert.equal(firstRoster.endpoint.startsWith("/player/v1/roster/member/"),true);
 assert.equal(firstRoster.httpStatus,200);
 assert.equal(firstRoster.providerResponse.unexpectedRosterField.unknown,true);
 assert.equal(firstRoster.providerResponse.meta.newProviderMeta.opaque,"retained");
 assert.equal(firstRoster.providerResponse.data.length,207);
 assert.equal(f.logs.at(-1),BATCH_PREFIX+fingerprint+"/progress.json");
 assert.equal(f.counters.calls,(await response.clone().json()).requestsThisBatch);
 assert.doesNotMatch(await response.text(),/futureField|private-provider-source|TOKEN_|arbitraryProviderField/);
 const data=[...f.store.entries()].filter(([key])=>key.includes("/member-"));
 assert.equal(data.length,2);
 assert.ok(data.every(([,raw])=>!JSON.parse(raw).characters.some(c=>c.id==="private")));
});
test("manual resume skips previous members and reaches 'complete-co-members' after 3 batches",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 for(const expected of [2,4,5]){
   const res=await handleRosterMicrobatch(request(),f.env,f.api,now+expected*1000);
   assert.equal(res.status,200);
   const body=await res.json();
   assert.equal(body.completed,expected);
   assert.equal(body.remaining,5-expected);
   assert.equal(body.status,expected===5?"complete-co-members":"in-progress");
 }
 const saved=[...f.store.keys()].filter(k=>k.includes("/member-"));
 assert.equal(saved.length,5);
 assert.deepEqual(saved.map(k=>JSON.parse(f.store.get(k)).name),
   users.map(x=>"Player "+x));
 const callsBefore=f.counters.calls;
 const res=await handleRosterMicrobatch(request(),f.env,f.api,now+12000);
 assert.equal((await res.json()).status,"complete-co-members");
 assert.equal(f.counters.calls,callsBefore);
});
test("upstream member reordering does not duplicate or skip players between batches",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 const first=await handleRosterMicrobatch(request(),f.env,f.api,now);
 assert.equal(first.status,200);
 f.counters.reorder=true;
 const second=await handleRosterMicrobatch(request(),f.env,f.api,now+60000);
 assert.equal(second.status,200);
 assert.equal((await second.json()).completed,4);
 const stored=[...f.store.keys()].filter(k=>k.includes("/member-"));
 assert.deepEqual(stored.map(k=>JSON.parse(f.store.get(k)).name),
   ["Player A","Player B","Player C","Player D"]);
});
test("completed baseline refresh uses one since/344 call per unchanged member",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 for(const expected of [2,4,5]){
   const a=await handleRosterMicrobatch(request(),f.env,f.api,now+expected*1000);
   assert.equal((await a.json()).completed,expected);
 }
 const oldState=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 const res=await handleRosterMicrobatch(request(fingerprint,{refresh:true}),f.env,f.api,now+3600000);
 assert.equal(res.status,200);
 const data=await res.json();
 assert.equal(data.unchangedThisBatch,2);
 assert.equal(data.pagesThisBatch,0);
 assert.equal(data.savedThisBatch,2);
 assert.equal(f.counters.conditionalHits,2);
 const refreshed=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 assert.notEqual(refreshed.runId,oldState.runId);
 assert.equal(refreshed.baseline.runId,oldState.runId);
 assert.equal(refreshed.completed,2);
 const newRecords=[...f.store.keys()].filter(k=>k.includes("/"+refreshed.runId+"/member-"));
 assert.equal(newRecords.length,2);
 assert.equal(JSON.parse(f.store.get(newRecords[0])).characters.length,207);
 assert.ok(f.counters.calls<40);
});
test("since returns changed roster: fetch full result once, never preserve stale cached power",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 for(const expected of [2,4,5])await handleRosterMicrobatch(request(),f.env,f.api,now+expected*1000);
 f.counters.changedRosters=true;
 const res=await handleRosterMicrobatch(request(fingerprint,{refresh:true}),f.env,f.api,now+7200000);
 assert.equal(res.status,200);
 const result=await res.json();
 assert.equal(result.unchangedThisBatch,0);
 assert.equal(result.pagesThisBatch,2);
 assert.equal(result.charactersThisBatch,414);
 const next=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 const newObj=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/"+next.runId+"/member-0.json"));
 assert.equal(newObj.characters[0].power,200100);
});
test("refresh cannot start with incomplete baseline or changed membership",async()=>{
 const f=fixture();
 const invalid=await handleRosterMicrobatch(request(fingerprint,{refresh:true}),f.env,f.api);
 assert.equal(invalid.status,409);
 assert.equal((await invalid.json()).status,"refresh-requires-complete-run");
 for(const expected of [2,4,5])await handleRosterMicrobatch(request(),f.env,f.api);
 const before=f.store.get(BATCH_PREFIX+fingerprint+"/progress.json");
 const countBefore=f.counters.calls;
 f.counters.revision=1;
 const changed=await handleRosterMicrobatch(request(fingerprint,{refresh:true}),f.env,f.api);
 assert.equal(changed.status,409);
 assert.equal((await changed.json()).status,"membership-changed-restart-required");
 assert.equal(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"),before);
 assert.ok(f.counters.calls-countBefore<=4);
});
test("a change in roster membership blocks resume and preserves old progress",async()=>{
 const f=fixture();
 assert.equal((await handleRosterMicrobatch(request(),f.env,f.api)).status,200);
 const progressBefore=f.store.get(BATCH_PREFIX+fingerprint+"/progress.json");
 f.counters.revision=1;
 const res=await handleRosterMicrobatch(request(),f.env,f.api);
 assert.equal(res.status,409);
 assert.equal((await res.json()).status,"membership-changed-restart-required");
 assert.equal(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"),progressBefore);
 assert.equal([...f.store.keys()].filter(k=>k.includes("/member-")).length,2);
});
test("explicit restart after a membership revision creates an isolated run",async()=>{
 const f=fixture();
 const first=await handleRosterMicrobatch(request(),f.env,f.api);
 assert.equal(first.status,200);
 const former=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 f.counters.revision=1;
 const redo=await handleRosterMicrobatch(request(fingerprint,{restart:true}),f.env,f.api);
 assert.equal(redo.status,200);
 const next=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 assert.notEqual(next.runId,former.runId);
 assert.notEqual(next.membershipDigest,former.membershipDigest);
 assert.equal(next.completed,2);
});
test("expired progress refuses silent resume, offers explicit restart",async()=>{
 const f=fixture(),now=Date.UTC(2026,9,18,18);
 await handleRosterMicrobatch(request(),f.env,f.api,now);
 const future=now+8*86400000;
 const expired=await handleRosterMicrobatch(request(),f.env,f.api,future);
 assert.equal(expired.status,409);
 assert.equal((await expired.json()).status,"expired-restart-required");
 const fresh=await handleRosterMicrobatch(request(fingerprint,{restart:true}),f.env,f.api,future);
 assert.equal(fresh.status,200);
});
test("alliance mutex blocks concurrent claims and requires correct holder to release",async()=>{
 const f=fixture();
 const req=(action,holder)=>new Request("https://internal/",{method:"POST",
   body:JSON.stringify({action,holder,fingerprint}),headers:{"Content-Type":"application/json"}});
 const holder1="11111111-1111-4111-8111-111111111111";
 const holder2="22222222-2222-4222-8222-222222222222";
 assert.equal((await(await f.lock.fetch(req("acquire",holder1))).json()).status,"acquired");
 const refused=await f.lock.fetch(req("acquire",holder2));
 assert.equal(refused.status,409);
 assert.equal((await(await f.lock.fetch(req("release",holder2))).json()).status,"released");
 assert.equal((await f.lock.fetch(req("acquire",holder2))).status,409);
 await f.lock.fetch(req("release",holder1));
 assert.equal((await(await f.lock.fetch(req("acquire",holder2))).json()).status,"acquired");
});
test("separate alliance progress keys cannot cross-contaminate",async()=>{
 const f=fixture();
 assert.equal((await handleRosterMicrobatch(request(fingerprint),f.env,f.api)).status,200);
 assert.equal((await handleRosterMicrobatch(request(otherFinger),f.env,f.api)).status,200);
 const first=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/progress.json"));
 const second=JSON.parse(f.store.get(BATCH_PREFIX+otherFinger+"/progress.json"));
 assert.notEqual(first.runId,second.runId);
 assert.equal(first.completed,2);assert.equal(second.completed,2);
});
test("foreign Origin, unknown fingerprint, forged admin and public access fail closed",async()=>{
 const f=fixture();
 const foreign=new Request(origin+"/admin/api/roster-batch",{method:"POST",
   headers:{"Content-Type":"application/json","Origin":"https://evil.example"},
   body:JSON.stringify({fingerprint})});
 assert.equal((await handleRosterMicrobatch(foreign,f.env,f.api)).status,403);
 assert.equal((await handleRosterMicrobatch(request("f".repeat(64)),f.env,f.api)).status,403);
 const unauthorized=await handleAdmin(request(),{
   ...f.env,MSF_ADMIN_ENABLED:"true",
   CF_ACCESS_TEAM_DOMAIN:"test.cloudflareaccess.com",
   CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"
 },f.api);
 assert.equal(unauthorized.status,403);
 assert.equal((await worker.fetch(new Request(origin+"/api/rosters"),f.env)).status,404);
 assert.equal(f.counters.calls,0);
 const js=await readFile(new URL("../public/admin-roster-preflight.js",import.meta.url),"utf8");
 assert.doesNotThrow(()=>new Script(js));
 assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML|indexedDB/);
});

test("automatic campaign finalizes only after the captain personal roster and all co-members",async()=>{
 const f=fixture({noOptout:true}),now=Date.UTC(2026,9,18,18);
 const internal=i=>({campaign:"2026-10-18-pm",tick:"2026-10-18T"+(16+i)+":00Z"});
 for(let expected=1;expected<=5;expected++){
   const response=await handleRosterMicrobatch(request(),f.env,f.api,
     now+expected*1000,internal(expected));
   assert.equal(response.status,200);
   assert.equal((await response.json()).completed,expected);
 }
 const pointer=BATCH_PREFIX+fingerprint+"/latest-complete.json";
 assert.equal(f.store.has(pointer),false);
 const selfRes=await handleRosterMicrobatch(request(),f.env,f.api,now+11000,internal(8));
 assert.equal(selfRes.status,200);
 const selfBody=await selfRes.json();
 assert.equal(selfBody.status,"complete");
 assert.equal(selfBody.personalRosterCollected,true);
 assert.equal(selfBody.personalRoster,true);
 const manifest=JSON.parse(f.store.get(pointer));
 assert.equal(manifest.total,6);
 assert.equal(manifest.coMembers,5);
 assert.equal(manifest.includesPersonal,true);
 const selfRecord=JSON.parse(f.store.get(BATCH_PREFIX+fingerprint+"/"+manifest.runId+"/member-self.json"));
 assert.equal(selfRecord.characters.length,207);
 assert.equal(selfRecord.volatileMemberId,"self");
 const selfRawKey=[...f.store.keys()].find(key=>key.endsWith("/roster-self-page-0.json"));
 assert.ok(selfRawKey);
 const selfRaw=JSON.parse(f.store.get(selfRawKey));
 assert.equal(selfRaw.providerResponse.meta.perTotal,207);
 assert.equal(selfRaw.providerResponse.data.length,207);
 const reRun=await handleRosterMicrobatch(request(),f.env,f.api,now+12000,internal(8));
 assert.equal((await reRun.json()).status,"already-processed-tick");
});
