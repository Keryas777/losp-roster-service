import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import worker from "../src/index.js";
import {handleAdmin} from "../src/admin-routes.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {
  handlePrivateRosterPilot,prunePrivateRosterPilots,
  ROSTER_PILOT_PREFIX,ROSTER_PILOT_MAX_AGE_MS
} from "../src/private-roster-pilot.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const token="PILOT_SECRET";
const fp=createHash("sha256").update("aid007").digest("hex");
const captainKey=CAPTAIN_PREFIX+"d".repeat(64);
const chars=Array.from({length:207},(_,i)=>({
  id:"CHAR_"+i,power:190000+i,iso8:{class:"striker",level:5},
  yellowStars:7,redStars:7,diamonds:3
}));
function fixture({shared=true,changed=false,moved=false,truncated=false}={}){
  const store=new Map(),calls=[],deletes=[],uploadTimes=new Map();
  store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {name:"Zeus",fingerprint:fp}
  ]}));
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"cd".repeat(32),
    CAPTAIN_BUCKET:{
      get:async key=>store.has(key)?{text:async()=>store.get(key)}:null,
      put:async(key,raw)=>{store.set(key,raw);uploadTimes.set(key,new Date());},
      delete:async key=>{deletes.push(key);store.delete(key);},
      list:async({prefix})=>prefix===CAPTAIN_PREFIX?
        {objects:[{key:captainKey}],truncated}:
        {objects:[...store.keys()].filter(k=>k.startsWith(prefix)).map(key=>({
          key,uploaded:uploadTimes.get(key)||new Date()
        })),truncated:false}
    },
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:id=>id,
      get:()=>({fetch:async req=>{
        assert.equal((await req.json()).action,"access");
        return Response.json({status:"active",accessToken:token});
      }})
    }
  };
  const api=async(url,request)=>{
    calls.push(url);
    assert.equal(request.method,"GET");
    assert.equal(request.headers.Authorization,"Bearer "+token);
    if(url.endsWith("/alliance/card")){
      const id=moved&&calls.filter(x=>x.endsWith("/alliance/card")).length>1?
        "aid008:v9":"aid007:v3";
      return Response.json({data:{id,name:"Zeus"}});
    }
    if(url.endsWith("/alliance/members")){
      const second=calls.filter(x=>x.endsWith("/alliance/members")).length>1;
      return Response.json({data:[
        {id:"self",isSelf:true,card:{name:"Captain",rosterShare:true}},
        {id:"member",isSelf:false,card:{name:"Shared member",
          rosterShare:shared&&!(changed&&second)}},
        {id:"optout",isSelf:false,card:{name:"Private player",rosterShare:false}}
      ]});
    }
    if(url.includes("/roster/member/member")){
      const u=new URL(url);
      assert.equal(u.searchParams.get("statsFormat"),"csv");
      const page=Number(u.searchParams.get("page")),size=Number(u.searchParams.get("perPage"));
      return Response.json({data:chars.slice((page-1)*size,page*size),meta:{
        page,perPage:size,perTotal:chars.length,asOf:"2026-10-18T17:01:00Z"
      }});
    }
    throw Error("Unexpected request");
  };
  return {store,calls,deletes,uploadTimes,env,api};
}
const request=(fingerprint=fp,originHeader=origin)=>new Request(origin+"/admin/api/roster-pilot",{
  method:"POST",headers:{Origin:originHeader,"Content-Type":"application/json"},
  body:JSON.stringify({fingerprint})
});
test("one eligible co-member: complete pagination, revalidation and private R2 snapshot",async()=>{
  const f=fixture();
  const res=await handlePrivateRosterPilot(request(),f.env,f.api,Date.UTC(2026,9,18,18));
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.status,"stored");
  assert.equal(body.characters,207);
  assert.equal(body.pages,3);
  assert.equal(body.requests,7);
  assert.equal(body.publiclyAvailable,false);
  assert.equal(body.storage,"private-r2");
  assert.equal(f.calls.filter(x=>x.includes("/roster/member/")).length,3);
  assert.equal(f.calls.filter(x=>x.endsWith("/alliance/members")).length,2);
  assert.equal(f.calls.filter(x=>x.endsWith("/alliance/card")).length,2);
  assert.ok(f.calls.every(x=>!x.endsWith("/roster/member/optout")&&!x.endsWith("/roster/member/self")));
  const stored=JSON.parse(f.store.get(ROSTER_PILOT_PREFIX+fp+".json"));
  assert.equal(stored.characters.length,207);
  assert.equal(stored.playerName,"Shared member");
  assert.equal(stored.memberIdVolatile,"member");
  assert.equal(stored.kind,"private-manual-pilot");
  assert.equal(Date.parse(stored.expiresAt)-Date.parse(stored.capturedAt),ROSTER_PILOT_MAX_AGE_MS);
  assert.doesNotMatch(JSON.stringify(stored),/PILOT_SECRET|Private player/);
  assert.doesNotMatch(JSON.stringify(body),/CHAR_|memberIdVolatile|PILOT_SECRET/);
});
test("revoked roster sharing after pagination never stores partial characters",async()=>{
  const f=fixture({changed:true});
  const res=await handlePrivateRosterPilot(request(),f.env,f.api);
  assert.equal(res.status,409);
  assert.equal((await res.json()).status,"changed-during-read");
  assert.equal(f.store.has(ROSTER_PILOT_PREFIX+fp+".json"),false);
});
test("alliance transition during pagination fails closed",async()=>{
  const f=fixture({moved:true});
  const res=await handlePrivateRosterPilot(request(),f.env,f.api);
  assert.equal(res.status,409);
  assert.equal((await res.json()).status,"alliance-changed-during-read");
  assert.equal(f.store.size,1);
});
test("unknown, unapproved and partial session census never touch rosters",async()=>{
  const f=fixture();
  assert.equal((await handlePrivateRosterPilot(request("f".repeat(64)),f.env,f.api)).status,403);
  assert.equal(f.calls.length,0);
  const tooMany=fixture({truncated:true});
  assert.equal((await handlePrivateRosterPilot(request(),tooMany.env,tooMany.api)).status,409);
  assert.equal(tooMany.calls.length,0);
  const invisible=fixture({shared:false});
  const res=await handlePrivateRosterPilot(request(),invisible.env,invisible.api);
  assert.equal(res.status,409);
  assert.equal((await res.json()).status,"no-eligible-shared-member");
  assert.equal(invisible.calls.filter(x=>x.includes("/roster/member/")).length,0);
});
test("CSRF, malformed payload and forged admin JWT all fail before private reads",async()=>{
  const f=fixture();
  const x=await handlePrivateRosterPilot(request(fp,"https://attacker.example"),f.env,f.api);
  assert.equal(x.status,403);
  const malformed=await handlePrivateRosterPilot(request("nope"),f.env,f.api);
  assert.equal(malformed.status,400);
  const forged=await handleAdmin(request(),{
    ...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"test.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"
  },f.api);
  assert.equal(forged.status,403);
  assert.equal(f.calls.length,0);
  assert.equal(f.store.size,1);
});
test("pilot R2 cleanup prunes expired and no-longer-approved records without Scopely reads",async()=>{
  const f=fixture(),key=ROSTER_PILOT_PREFIX+fp+".json";
  const other="f".repeat(64),otherKey=ROSTER_PILOT_PREFIX+other+".json";
  f.store.set(key,"private record");
  f.store.set(otherKey,"orphan record");
  f.uploadTimes.set(key,new Date("2026-10-01T00:00:00Z"));
  f.uploadTimes.set(otherKey,new Date("2026-10-18T00:00:00Z"));
  const first=await prunePrivateRosterPilots(f.env,Date.UTC(2026,9,18,19));
  assert.deepEqual(first,{status:"checked",checked:2,deleted:2});
  assert.equal(f.store.size,1);
  assert.deepEqual(f.deletes.sort(),[key,otherKey].sort());
  assert.equal(f.calls.length,0);
});
test("no public pilot endpoints and no scheduled Scopely roster collection",async()=>{
  const f=fixture();
  for(const path of ["/api/rosters","/roster-pilot","/admin/api/roster-pilot"]){
    const response=await worker.fetch(new Request(origin+path),f.env);
    assert.notEqual(response.status,200);
  }
  const js=await readFile(new URL("../public/admin-roster-preflight.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML|indexedDB/);
  assert.match(js,/\/admin\/api\/roster-pilot/);
});
