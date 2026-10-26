import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {handlePlayerR2Explorer} from "../src/player-r2-explorer.js";
import {handleAdmin} from "../src/admin-routes.js";
import {CAPTAIN_PREFIX,putCaptainRecord} from "../src/captain-vault.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const PATH=HOST+"/admin/api/player-r2-explorer";
const SID="b".repeat(64),FP="a".repeat(64);
const RUN="11111111-2222-4333-8444-555555555555";
const NOW=Date.parse("2026-10-26T02:00:00Z");
const PREFIX="roster-batches/v1/";
const DURATION=7*86400000;
function fixture(){
 const db=new Map(),actions=[];
 const bucket={
   get:async key=>{
     actions.push(["get",key]);
     const raw=db.get(key);
     return raw===undefined?null:{size:raw.length,text:async()=>raw};
   },
   head:async key=>{
     actions.push(["head",key]);
     return db.has(key)?{key,size:db.get(key).length}:null;
   },
   put:async(key,value)=>{db.set(key,String(value));},
   delete:async key=>{db.delete(key);},
   list:async ({prefix,limit=100,cursor})=>{
     actions.push(["list",prefix]);
     const items=[...db.keys()].filter(k=>k.startsWith(prefix)).sort();
     const start=cursor?Number(cursor):0;
     const page=items.slice(start,start+limit);
     return {objects:page.map(key=>({key})),truncated:start+limit<items.length,
       cursor:start+limit<items.length?String(start+limit):undefined};
   }
 };
 const env={CAPTAIN_SESSIONS_ENABLED:"true",
   CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
   CAPTAIN_BUCKET:bucket,
   CAPTAIN_REFRESH_COORDINATOR:{idFromName:x=>x,get:()=>({fetch:async()=>
     Response.json({status:"active",accessToken:"PRIVATE_BEARER"})})},
   ROSTER_BATCH_LOCK:{idFromName:x=>x,get:()=>({fetch:async()=>
     Response.json({status:"acquired"})})}
 };
 const ask=(p,method="GET")=>handlePlayerR2Explorer(new Request(
   PATH+"?"+new URLSearchParams(p),{method}),env,NOW);
 return {env,db,actions,ask};
}
async function seed(f,scopes="offline m3p.f.ar.ros m3p.f.pr.inv m3p.f.pr.ros"){
 await putCaptainRecord(f.env.CAPTAIN_BUCKET,f.env.CAPTAIN_ENCRYPTION_KEY_HEX,
   CAPTAIN_PREFIX+SID,{
    version:2,createdAt:NOW-3600000,expiresAt:NOW+25*86400000,
    accessExpiresAt:NOW+3600000,accessToken:"SECRET_ACCESS",
    refreshToken:"SECRET_REFRESH",scope:scopes
   });
 await f.env.CAPTAIN_BUCKET.put("roster-batches/v1/connected-alliances/sessions/"+SID,
   JSON.stringify({version:1,name:"LoSP Sample",fingerprint:FP,
     observedAt:new Date(NOW-60000).toISOString()}));
 await f.env.CAPTAIN_BUCKET.put(ROSTER_APPROVAL_KEY,JSON.stringify({
   version:1,alliances:[{name:"LoSP Sample",fingerprint:FP}]}));
}
function extras(f,family="personal-inventory",count=42,target="self"){
 const prefix=PREFIX+"player-extras/"+SID+"/"+family+"/"+target+"/";
 const key=prefix+RUN+"/page-1.json";
 const data=Array.from({length:count},(_,i)=>({id:"Item-"+i,
   power:i,nested:{unexpected:true}}));
 const capturedAt=new Date(NOW-600000).toISOString();
 f.db.set(key,JSON.stringify({version:1,resource:family,scope:"m3p.f.pr.inv",
   capturedAt,endpoint:"/player/v1/inventory?page=1&perPage=100",
   providerResponse:{data,meta:{asOf:"2026-10-26"},newNestedProperty:{"test":1},
     access_token:"NEVER_EXPOSE_THIS"}}));
 f.db.set(prefix+"latest.json",JSON.stringify({version:1,complete:true,
   resource:family,capturedAt,expiresAt:new Date(NOW+DURATION).toISOString(),
   total:count,pages:[{key,page:1,count}],trigger:"automatic-campaign"}));
 return {key,prefix};
}
function roster(f){
 const prefix=PREFIX+FP+"/";
 const capturedAt=new Date(NOW-600000).toISOString();
 const exp=new Date(NOW+DURATION).toISOString();
 f.db.set(prefix+"progress.json",JSON.stringify({version:1,
   fingerprint:FP,runId:RUN,membershipDigest:"c".repeat(64),campaign:"2026-10-25-pm",
   startedAt:capturedAt,expiresAt:exp,completed:1,totalEligible:1,
   observedMembers:2,selfCompleted:true}));
 f.db.set(prefix+"latest-complete.json",JSON.stringify({version:1,
   fingerprint:FP,runId:RUN,membershipDigest:"c".repeat(64),
   total:2,coMembers:1,observedMembers:2,
   coverage:"all-members",notSharedCount:0,
   includesPersonal:true,capturedAt,expiresAt:exp}));
 for(const role of ["0","self"])
   f.db.set(prefix+RUN+"/member-"+role+".json",JSON.stringify({
     version:1,runId:RUN,allianceFingerprint:FP,
     memberIndex:role==="0"?0:"self",name:"Sample",capturedAt,expiresAt:exp,
     characters:Array.from({length:44},(_,i)=>({id:"Hero"+i,power:i}))
   }));
 const folder="provider-source/12345678-1234-4123-8123-123456789abc/";
 f.db.set(prefix+RUN+"/"+folder+"roster-member-0-page-0.json",JSON.stringify({
   version:1,kind:"private-provider-source",runId:RUN,
   allianceFingerprint:FP,capturedAt,
   endpoint:"/player/v1/roster/member/sample?page=1",
   httpStatus:200,providerResponse:{
     data:Array.from({length:25},(_,i)=>({id:"Hero"+i})),
     meta:{perTotal:25},future:"keep-me"
   }
 }));
 return {prefix,folder};
}
test("read-only R2 catalog lists only opaque sessions and approved alliances",async()=>{
 const f=fixture();await seed(f);
 const r=await f.ask({view:"accounts"});
 assert.equal(r.status,200);
 const v=await r.json();
 assert.equal(v.source,"private-r2-only");
 assert.equal(v.accounts.length,1);
 assert.equal(v.accounts[0].session,SID);
 assert.equal(v.accounts[0].alliance,"LoSP Sample");
 assert.equal(v.alliances.length,1);
 assert.ok(!JSON.stringify(v).includes("SECRET_ACCESS"));
 assert.ok(!JSON.stringify(v).includes("SECRET_REFRESH"));
 assert.equal(f.actions.some(([op])=>["post","fetch"].includes(op)),false);
});
test("real inventory page is paginated and secrets are redacted in browser response",async()=>{
 const f=fixture();await seed(f);extras(f);
 const s=await(await f.ask({view:"extra",session:SID,
   family:"personal-inventory"})).json();
 assert.equal(s.entries[0].status,"archived");
 assert.equal(s.entries[0].pages,1);
 const v=await(await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1",offset:"20"})).json();
 assert.equal(v.status,"ok");
 assert.equal(v.document.providerResponse.data.length,20);
 assert.equal(v.document.providerResponse.data[0].id,"Item-20");
 assert.equal(v.document.providerResponse.newNestedProperty.test,1);
 assert.equal(v.document.providerResponse.access_token,"[masqué]");
 assert.equal(v.entries,42);
 assert.equal(v.hasMore,true);
 const end=await(await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1",offset:"40"})).json();
 assert.equal(end.document.providerResponse.data.length,2);
 assert.equal(end.hasMore,false);
});
test("missing page, expired snapshot and malformed pointer are never readable",async()=>{
 const f=fixture();await seed(f);const x=extras(f);
 f.db.delete(x.key);
 const diag=await(await f.ask({view:"extra",session:SID,
   family:"personal-inventory"})).json();
 assert.equal(diag.entries[0].status,"missing-pages");
 assert.equal((await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1"})).status,404);
 const pointer=JSON.parse(f.db.get(x.prefix+"latest.json"));
 pointer.expiresAt=new Date(NOW-1000).toISOString();
 f.db.set(x.prefix+"latest.json",JSON.stringify(pointer));
 const expired=await(await f.ask({view:"extra",session:SID,
   family:"personal-inventory"})).json();
 assert.equal(expired.entries[0].status,"expired");
 const rejected=await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1"});
 assert.equal(rejected.status,409);
 pointer.expiresAt=new Date(NOW+DURATION).toISOString();
 pointer.pages[0].key="oauth-captains/v1/"+SID;
 f.db.set(x.prefix+"latest.json",JSON.stringify(pointer));
 assert.equal((await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1"})).status,409);
});
test("grants and scopes are required before reading private page content",async()=>{
 const f=fixture();await seed(f,"offline m3p.f.ar.ros");extras(f);
 const listing=await(await f.ask({view:"extra",session:SID,
   family:"personal-inventory"})).json();
 assert.equal(listing.status,"scope-not-granted");
 assert.equal((await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1"})).status,403);
 f.db.delete(CAPTAIN_PREFIX+SID);
 assert.equal((await f.ask({view:"extra-file",session:SID,
   family:"personal-inventory",target:"self",page:"1"})).status,403);
});
test("approved alliance can inspect its own normalized roster and original source envelopes",async()=>{
 const f=fixture();await seed(f);const r=roster(f);
 const s=await(await f.ask({view:"roster",fingerprint:FP})).json();
 assert.equal(s.manifestStatus,"valid");
 assert.equal(s.roles.length,2);
 assert.equal(s.coverage.manifest.verified,true);
 const c=await(await f.ask({view:"roster-file",fingerprint:FP,
   member:"0",offset:"20"})).json();
 assert.equal(c.document.characters.length,20);
 assert.equal(c.document.characters[0].id,"Hero20");
 assert.equal(c.entries,44);
 const listing=await(await f.ask({view:"roster-sources",fingerprint:FP})).json();
 assert.equal(listing.sources.length,1);
 const raw=await(await f.ask({view:"roster-source",fingerprint:FP,
   source:r.folder+"roster-member-0-page-0.json",offset:"20"})).json();
 assert.equal(raw.document.providerResponse.data[0].id,"Hero20");
 assert.equal(raw.document.providerResponse.future,"keep-me");
});
test("unapproved alliances and arbitrary path traversal cannot access R2 records",async()=>{
 const f=fixture();await seed(f);roster(f);
 assert.equal((await f.ask({view:"roster-file",fingerprint:"f".repeat(64),
   member:"self"})).status,403);
 assert.equal((await f.ask({view:"roster-source",fingerprint:FP,
   source:"../../../oauth-captains/v1/"+SID})).status,400);
 assert.equal((await f.ask({view:"roster-file",fingerprint:FP,member:"999"})).status,400);
 assert.equal((await f.ask({view:"extra-file",session:SID,
   family:"../../oauth-captains",target:"self",page:"1"})).status,400);
 assert.equal((await f.ask({view:"accounts",cursor:"evil"})).status,400);
 assert.equal((await f.ask({view:"accounts"},"POST")).status,405);
});
test("per-family diagnostics preserve failure reason without tokens or member IDs",async()=>{
 const f=fixture();await seed(f);extras(f);
 f.db.set(PREFIX+"player-campaign/current.json",JSON.stringify({
   version:1,status:"partial",sessions:[SID],
   errors:[{at:new Date(NOW).toISOString(),session:SID,
     family:"personal-inventory",reason:"page-budget",retry:3},
     {at:new Date(NOW).toISOString(),session:"c".repeat(64),
       family:"personal-inventory",reason:"SECRET_PRIVATE",retry:1}]
 }));
 const v=await(await f.ask({view:"extra",session:SID,
   family:"personal-inventory"})).json();
 assert.equal(v.traces.events.length,1);
 assert.equal(v.traces.events[0].reason,"page-budget");
 assert.ok(!JSON.stringify(v).includes("SECRET_PRIVATE"));
});
test("admin JWT/allowlist check runs before any roster reader",async()=>{
 const f=fixture();await seed(f);const before=f.actions.length;
 const denied=await handleAdmin(new Request(PATH+"?view=accounts"),
   {...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"demo.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"only-admin@example.test"});
 assert.equal(denied.status,403);
 assert.equal(f.actions.length,before);
});
test("UI and routing use the existing Archives R2 tab and never fetch Scopely automatically",async()=>{
 const [html,nav,ui,css,worker]=await Promise.all([
   readFile(new globalThis.URL("../src/admin-routes.js",import.meta.url),"utf8"),
   readFile(new globalThis.URL("../public/admin-navigation.js",import.meta.url),"utf8"),
   readFile(new globalThis.URL("../public/admin-player-r2-explorer.js",import.meta.url),"utf8"),
   readFile(new globalThis.URL("../public/admin-explorer.css",import.meta.url),"utf8"),
   readFile(new globalThis.URL("../src/player-r2-explorer.js",import.meta.url),"utf8")
 ]);
 assert.match(html,/id="player-r2-load"/);
 assert.match(html,/\/admin\/api\/player-r2-explorer/);
 assert.match(html,/admin-player-r2-explorer\.js/);
 assert.match(nav,/player-r2-load/);
 assert.match(nav,/id:"archives"/);
 assert.doesNotThrow(()=>new Script(ui));
 assert.match(css,/#player-r2-json/);
 assert.doesNotMatch(ui,/localStorage|sessionStorage|innerHTML|setInterval|\/player\/v1\//);
 assert.doesNotMatch(worker,/fetchImpl|api\.marvelstrikeforce\.com|new Request\([^)]*https:\/\/api/);
});
