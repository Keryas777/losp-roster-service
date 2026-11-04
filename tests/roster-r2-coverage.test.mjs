import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";
import {handleRosterR2Coverage} from "../src/roster-r2-coverage.js";
import {handleAdmin} from "../src/admin-routes.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {CONNECTED_ALLIANCE_PREFIX} from "../src/connected-alliance-index.js";
import {BATCH_PREFIX,BATCH_MAX_AGE_MS} from "../src/private-roster-batches.js";
import {rosterAttemptKey,rosterCooldownKey,rosterAttemptRecord}
  from "../src/roster-auto-diagnostics.js";

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
  assert.ok(f.read.every(k=>k===ROSTER_APPROVAL_KEY||k===GUEST_APPROVAL_KEY||k.startsWith(BATCH_PREFIX)||
    k.startsWith("roster-auto/v1/last-attempt/")||
    k.startsWith("roster-auto/v1/cooldown/")));
  assert.ok(f.heads.every(k=>k.startsWith(BATCH_PREFIX)));
  assert.doesNotMatch(JSON.stringify(data),/SECRET_PLAYER|SECRET_CAPTAIN|SECRET_CHARACTER|access_token|refresh_token/);
});

test("per-alliance errors and active cooldown are displayed from private R2 metadata only",async()=>{
 const f=fixture();
 const stamp="2026-10-21T12:00Z";
 const slot={campaign:"2026-10-21-am",stamp};
 const privateRecord=rosterAttemptRecord(slot,"rate-limited",409,7,
   "2026-10-21T13:00:00.000Z");
 f.store.set(rosterAttemptKey(fp(3)),JSON.stringify(privateRecord));
 f.store.set(rosterCooldownKey(fp(3)),JSON.stringify({
   until:"2026-10-21T13:00:00.000Z",reason:"429"
 }));
 const result=await(await handleRosterR2Coverage(request(),f.env,now)).json();
 const alliance=result.alliances[2];
 assert.deepEqual(alliance.automation,{
   status:"valid",campaign:slot.campaign,at:stamp,
   outcome:"rate-limited",requests:7,httpStatus:409,
   failureReason:"rate-limited",cooldownUntil:"2026-10-21T13:00:00.000Z"
 });
 assert.equal(result.alliances[0].automation.status,"missing");
 assert.ok(f.read.includes(rosterAttemptKey(fp(3))));
 assert.ok(f.read.includes(rosterCooldownKey(fp(3))));
 assert.deepEqual(f.writes,[]);
 assert.doesNotMatch(JSON.stringify(result),/SECRET_PLAYER|SECRET_CAPTAIN|SECRET_CHARACTER/);
});

test("unavailable or forged per-alliance telemetry never invalidates roster manifests",async()=>{
 const f=fixture();
 const fake=rosterAttemptRecord({
   campaign:"2026-10-21-am",stamp:"2026-10-21T12:00Z"
 },"network-error",503,3);
 fake.privateToken="DO-NOT-RETURN";
 fake.outcome="<script>alert(1)</script>";
 f.store.set(rosterAttemptKey(fp(1)),JSON.stringify(fake));
 let data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
 assert.equal(data.alliances[0].automation.status,"invalid");
 assert.equal(data.alliances[0].manifest.status,"valid");
 assert.doesNotMatch(JSON.stringify(data),/DO-NOT-RETURN|script/);
 fake.outcome="network-error";fake.at="2026-10-22T12:00Z";
 f.store.set(rosterAttemptKey(fp(1)),JSON.stringify(fake));
 data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
 assert.equal(data.alliances[0].automation.status,"invalid",
   "A future attempt must not masquerade as past collection");
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
  assert.match(js,/Dernier micro-lot réellement tenté/);
  assert.match(js,/Dernier échec/);
  assert.match(js,/Collecte temporairement suspendue/);
  assert.match(js,/roster-auto-resume/);
  assert.match(js,/Lancer le rattrapage automatique/);
  assert.match(js,/Micro-lot manuel/);
  assert.match(js,/roster-auto-recovery/);
  assert.match(admin,/roster-auto-resume/);
  assert.match(admin,/roster-auto-recovery/);
});

test("R2 admin keeps targeted resume buttons enabled after initial load and re-render",async()=>{
 const js=await readFile(new URL("../public/admin-roster-r2-coverage.js",import.meta.url),"utf8");
 class FakeElement{
   constructor(tag){this.tag=tag;this.children=[];this.style={};
     this.disabled=false;this.isConnected=true;this.handlers={};this.textContent="";}
   append(...children){this.children.push(...children);}
   replaceChildren(...children){this.children=children;}
   addEventListener(type,callback){this.handlers[type]=callback;}
 }
 const nodes=new Map(["roster-r2-refresh","roster-r2-copy","roster-r2-status",
   "roster-r2-report"].map(key=>[key,new FakeElement("div")]));
 const alliance={fingerprint:"a".repeat(64),name:"LoSP Kronos",
   progress:{status:"in-progress",campaign:"2026-11-03-pm",
     completed:20,eligibleCoMembers:23,remaining:3,observedMembers:24,
     noShareCount:0,personalRosterCollected:false},
   manifest:{status:"missing"},automation:{status:"missing"}};
 const report={status:"ok",alliances:[alliance]};
 const requests=[];
 const fetch=async(url,options={})=>{
   requests.push({url,options});
   const manual=url==="/admin/api/roster-auto-resume";
   const queue=url==="/admin/api/roster-auto-recovery";
   if(queue){
     const action=JSON.parse(options.body).action;
     alliance.recovery={status:action==="start"?"queued":"stopped",
       campaign:"2026-11-03-pm",attempts:0};
   }
   return {ok:true,status:200,json:async()=>manual?
     {status:"in-progress",campaign:"2026-11-03-pm",requestsThisTick:7}:
     queue?{status:alliance.recovery.status}:report};
 };
 const context={fetch,document:{
   getElementById:id=>nodes.get(id),
   createElement:tag=>new FakeElement(tag),
   createTextNode:value=>({textContent:value})
 }};
 new Script(js).runInNewContext(context);
 const buttons=()=>{
   const found=[];
   const walk=el=>{
     if(el?.tag==="button")found.push(el);
     for(const child of el?.children||[])walk(child);
   };
   walk(nodes.get("roster-r2-report"));
   return found;
 };
 // The original defect disabled new buttons when render() ran with busy=true.
 nodes.get("roster-r2-refresh").handlers.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(buttons().length,2);
 assert.ok(buttons().every(x=>x.disabled===false));
 buttons().find(x=>x.textContent.startsWith("Micro-lot manuel")).handlers.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.filter(x=>x.url==="/admin/api/roster-auto-resume").length,1);
 assert.equal(buttons().length,2);
 assert.ok(buttons().every(x=>x.disabled===false),
   "Rerender after a successful microbatch must not strand any button");
 buttons().find(x=>x.textContent.startsWith("Lancer le rattrapage")).handlers.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.filter(x=>x.url==="/admin/api/roster-auto-recovery").length,1);
 assert.ok(buttons().some(x=>x.textContent.startsWith("Arrêter le rattrapage")));
 assert.equal(buttons().find(x=>x.textContent.startsWith("Micro-lot manuel")).disabled,true,
   "Manual microbatch must remain disabled while queued recovery is active");
 buttons().find(x=>x.textContent.startsWith("Arrêter le rattrapage")).handlers.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.filter(x=>x.url==="/admin/api/roster-auto-recovery").length,2);
 assert.equal(buttons().find(x=>x.textContent.startsWith("Micro-lot manuel")).disabled,false);
 assert.equal(nodes.get("roster-r2-refresh").disabled,false);
});


test("guest display name comes from cached Scopely directory without any provider or R2 writes",async()=>{
  const f=fixture(),guest=fp("f"),other=fp("e");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:guest}
  ]}));
  const cached=(sid,fingerprint,name,offset=0)=>f.store.set(
    CONNECTED_ALLIANCE_PREFIX+sid,JSON.stringify({version:1,fingerprint,name,
      observedAt:new Date(now-offset).toISOString()}));
  cached(fp("a"),guest,"Ancien nom",3600_000);
  cached(fp("b"),guest,"<color=red>ΜΛЯΠΣƧ</color>",60_000);
  cached(fp("c"),fp(1),"FAUSSE ATHÉNA",30_000); // LoSP name is not overridden
  cached(fp("d"),other,"ALLIANCE NON APPROUVÉE",20_000);
  const listed=[];
  f.env.CAPTAIN_BUCKET.list=async opts=>{
    listed.push(opts);
    const keys=[...f.store.keys()].filter(k=>k.startsWith(opts.prefix));
    return {objects:keys.map(key=>({key})),truncated:false};
  };
  const data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
  assert.equal(data.status,"ok");
  assert.equal(data.approvedCount,6);
  assert.equal(data.alliances.at(-1).name,"<color=red>ΜΛЯΠΣƧ</color>");
  assert.equal(data.alliances[0].name,"Zeus");
  assert.deepEqual(listed.map(x=>x.prefix),[CONNECTED_ALLIANCE_PREFIX]);
  assert.deepEqual(f.writes,[]);
  assert.ok(f.read.every(k=>!k.startsWith("oauth-captains/")));
  assert.doesNotMatch(JSON.stringify(data),/ALLIANCE NON APPROUVÉE|FAUSSE ATHÉNA/);
  const selected=await(await handleRosterR2Coverage(
    request("?fingerprint="+guest),f.env,now)).json();
  assert.equal(selected.scope,"full");
  assert.equal(selected.alliances[0].name,"<color=red>ΜΛЯΠΣƧ</color>");
});

test("missing, stale, malformed or unavailable cached guest names keep the generic label",async()=>{
  const f=fixture(),guest=fp("f"),sid=fp("a");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:guest}
  ]}));
  let objects=[];
  f.env.CAPTAIN_BUCKET.list=async()=>({objects,truncated:false});
  const readName=async()=> (await(await handleRosterR2Coverage(
    request(),f.env,now)).json()).alliances.at(-1).name;
  assert.equal(await readName(),"Alliance invitée");
  const key=CONNECTED_ALLIANCE_PREFIX+sid;
  objects=[{key}];
  const save=(name,stamp)=>f.store.set(key,JSON.stringify({
    version:1,fingerprint:guest,name,observedAt:stamp
  }));
  save("Trop ancien",new Date(now-8*86400000).toISOString());
  assert.equal(await readName(),"Alliance invitée");
  save("Nom futur",new Date(now+3600_000).toISOString());
  assert.equal(await readName(),"Alliance invitée");
  save("<script>danger</script>","invalid-date");
  assert.equal(await readName(),"Alliance invitée");
  f.env.CAPTAIN_BUCKET.list=async()=>{throw Error("unavailable");};
  assert.equal(await readName(),"Alliance invitée");
  assert.deepEqual(f.writes,[]);
});

test("paginated guest directory uses latest entry; incomplete listing cannot mislabel",async()=>{
  const f=fixture(),guest=fp("f");
  f.store.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:guest}
  ]}));
  const keys=[fp("a"),fp("b")].map(s=>CONNECTED_ALLIANCE_PREFIX+s);
  f.store.set(keys[0],JSON.stringify({version:1,fingerprint:guest,name:"Ancien",
    observedAt:new Date(now-2000).toISOString()}));
  f.store.set(keys[1],JSON.stringify({version:1,fingerprint:guest,name:"À jour",
    observedAt:new Date(now-1000).toISOString()}));
  f.env.CAPTAIN_BUCKET.list=async opts=>opts.cursor?
    {objects:[{key:keys[1]}],truncated:false}:
    {objects:[{key:keys[0]}],truncated:true,cursor:"page-2"};
  let data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
  assert.equal(data.alliances.at(-1).name,"À jour");
  f.env.CAPTAIN_BUCKET.list=async()=>({objects:[{key:keys[0]}],
    truncated:true,cursor:null});
  data=await(await handleRosterR2Coverage(request(),f.env,now)).json();
  assert.equal(data.alliances.at(-1).name,"Alliance invitée");
  assert.deepEqual(f.writes,[]);
});

test("guest MSF color markup renders as a clean safe name in the R2 admin card",async()=>{
  const js=await readFile(new URL("../public/admin-roster-r2-coverage.js",import.meta.url),"utf8");
  const start=js.indexOf("  const title=(card,value)=>{");
  const end=js.indexOf("\n  function render(",start);
  assert.ok(start>=0&&end>start);
  const node=tag=>({tag,style:{},children:[],append(...items){this.children.push(...items);}});
  const document={createElement:node,createTextNode:text=>({textContent:text})};
  const show=runInNewContext(js.slice(start,end)+"\ntitle",{document});
  const card=node("article");
  show(card,"<color=red>ΜΛЯΠΣƧ</color>");
  assert.equal(card.children[0].children[0].textContent,"ΜΛЯΠΣƧ");
  assert.equal(card.children[0].children[0].style.color,"#ff6060");
  assert.doesNotMatch(JSON.stringify(card),/<color|<script/i);
});


test("admin R2 controls use clean guest names in buttons and statuses",async()=>{
  const js=await readFile(new URL("../public/admin-roster-r2-coverage.js",import.meta.url),"utf8");
  const start=js.indexOf("  const plainAllianceName=");
  const end=js.indexOf(";",start);
  assert.ok(start>=0&&end>start);
  const format=runInNewContext(js.slice(start,end+1)+"\nplainAllianceName");
  assert.equal(format("<color=red>ΜΛЯΠΣƧ</color>"),"ΜΛЯΠΣƧ");
  assert.equal(format("LoSP <#E10D17>Kronos"),"LoSP Kronos");
  assert.equal(format("  <color=red> Invités </color>  "),"Invités");
  assert.equal(format("LoSP Zeus"),"LoSP Zeus");
  assert.equal(js.split("plainAllianceName(alliance.name)").length-1,4,
    "Manual action, auto recovery and their statuses must share the formatter");
  assert.doesNotMatch(js,/String\(alliance\.name\)\.replace\(/);
});
