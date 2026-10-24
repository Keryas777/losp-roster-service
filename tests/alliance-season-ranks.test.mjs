import {test} from "node:test";
import assert from "node:assert/strict";
import {handleAllianceSeasonRanks} from "../src/alliance-season-ranks.js";
import {handleAdmin} from "../src/admin-routes.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {createHash} from "node:crypto";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const URL=ORIGIN+"/admin/api/alliance-season-ranks";
const PREFIX="roster-batches/v1/season-ranks/";
const key=n=>CAPTAIN_PREFIX+String(n).padStart(64,"0");
function fixture(){
  const db=new Map(),actions=[],calls=[];
  db.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:["zeus","kronos"].map(name=>({fingerprint:createHash("sha256").update(name).digest("hex"),name}))}));
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ac".repeat(32),
    CAPTAIN_BUCKET:{
      get:async k=>{
        actions.push(["get",k]);
        return db.has(k)?{text:async()=>db.get(k)}:null;
      },
      put:async(k,v)=>{
        actions.push(["put",k]);
        assert.ok(k.startsWith(PREFIX),"Only existing seven-day lifecycle prefix");
        db.set(k,v);
      },
      delete:async()=>{throw Error("Must not delete existing R2 data")},
      list:async options=>{
        actions.push(["list",options.prefix]);
        assert.equal(options.prefix,CAPTAIN_PREFIX);
        return {objects:[{key:key(1)},{key:key(2)},{key:key(3)}],
          truncated:false};
      }
    },
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:x=>x,
      get:x=>({fetch:async request=>{
        assert.equal((await request.json()).action,"access");
        return Response.json({status:"active",accessToken:
          "TOKEN"+Number(x.slice(CAPTAIN_PREFIX.length))});
      }})
    }
  };
  const fakeFetch=async(uri,options)=>{
    calls.push([uri,options.headers.Authorization]);
    assert.equal(uri,"https://api.marvelstrikeforce.com/player/v1/alliance/card");
    const id=Number(options.headers.Authorization.replace("Bearer TOKEN",""));
    const cards={
      1:{id:"zeus:old",name:"Zeus",warRank:201,raidRank:33,
        warTrophies:2649,warLeague:{id:"D2",name:"DIAMOND II"},
        privateFlag:"hidden"},
      2:{id:"zeus:new",name:"Zeus",warRank:201,raidRank:33,
        warTrophies:2649,warLeague:{id:"D2",name:"DIAMOND II"}},
      3:{id:"kronos:old",name:"Kronos",warRank:157,raidRank:30,
        warTrophies:2900,warLeague:{id:"D1",name:"DIAMOND I"}}
    };
    return Response.json({data:cards[id],meta:{secret:"not-exported"}});
  };
  const post=(timestamp,headers={Origin:ORIGIN,
      "Content-Type":"application/json"})=>
    handleAllianceSeasonRanks(new Request(URL,{
      method:"POST",headers,body:'{"action":"capture"}'
    }),env,fakeFetch,timestamp);
  const get=()=>handleAllianceSeasonRanks(new Request(URL),env,fakeFetch);
  return {env,db,actions,calls,post,get};
}
test("snapshot captures only permitted AllianceCards, de-duplicates and saves under 7-day lifecycle",async()=>{
  const f=fixture();
  const now=Date.parse("2026-10-21T00:00:00Z");
  const response=await f.post(now);
  assert.equal(response.status,200);
  const {snapshot,status}=await response.json();
  assert.equal(status,"captured");
  assert.equal(snapshot.connectedAlliances,2);
  assert.equal(snapshot.validSessions,3);
  assert.equal(snapshot.seasonId,null);
  assert.equal(snapshot.seasonVerified,false);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").connectedSessions,2);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").warRank,201);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").raidRank,33);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").warTrophies,2649);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").warLeague.name,"DIAMOND II");
  assert.equal(snapshot.alliances.find(a=>a.name==="Kronos").warRank,157);
  assert.equal(f.calls.length,3);
  assert.equal(f.db.size,3);
  assert.ok(f.db.has(PREFIX+"latest.json"));
  assert.ok([...f.db.keys()].filter(k=>k!==ROSTER_APPROVAL_KEY).every(k=>k.startsWith(PREFIX)));
  const saved=[...f.db.values()].join("");
  assert.ok(!saved.includes("TOKEN"));
  assert.ok(!saved.includes("privateFlag"));
  assert.ok(!saved.includes("not-exported"));
  assert.ok(!saved.includes("zeus:old"));
  assert.ok(!saved.includes("kronos:old"));
  assert.equal((await (await f.get()).json()).snapshot.capturedAt,
    "2026-10-21T00:00:00.000Z");
  assert.equal(f.calls.length,3,"GET latest must not re-fetch Scopely");
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
});

test("outside alliance rank is never stored while LoSP ranks remain",async()=>{
  const f=fixture();
  f.db.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:createHash("sha256").update("zeus").digest("hex"),name:"Zeus"}
  ]}));
  const report=await(await f.post(Date.now())).json();
  assert.equal(report.snapshot.connectedAlliances,1);
  assert.deepEqual(report.snapshot.alliances.map(a=>a.name),["Zeus"]);
  assert.ok(!JSON.stringify(report).includes("Kronos"));
});

test("repeated click within ten minutes does not repeat provider API calls or R2 writes",async()=>{
  const f=fixture(),base=Date.parse("2026-10-21T00:00:00Z");
  await f.post(base);
  const result=await (await f.post(base+60_000)).json();
  assert.equal(result.status,"recent-capture");
  assert.equal(f.calls.length,3);
  assert.equal(f.db.size,3);
  const next=await (await f.post(base+11*60_000)).json();
  assert.equal(next.status,"captured");
  assert.equal(f.calls.length,6);
  assert.equal(f.db.size,4);
});

test("no authenticated captain means no misleading successful capture",async()=>{
  const f=fixture();
  f.env.CAPTAIN_BUCKET.list=async()=>({objects:[],truncated:false});
  const res=await f.post(Date.now());
  assert.equal(res.status,409);
  assert.equal((await res.json()).error,"no-connected-alliances");
  assert.equal(f.db.size,1);
});

test("POST cannot be triggered cross-origin and admin authentication precedes bucket reads",async()=>{
  const f=fixture();
  const res=await f.post(Date.now(),{"Content-Type":"application/json"});
  assert.equal(res.status,403);
  assert.equal(f.db.size,1);
  const forbiddenEnv={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const forbidden=await handleAdmin(new Request(URL),forbiddenEnv);
  assert.equal(forbidden.status,403);
  assert.equal(f.actions.length,0);
});

test("unavailable sessions remain visible rather than manufactured as rank zero",async()=>{
  const f=fixture();
  const original=f.env.CAPTAIN_REFRESH_COORDINATOR.get;
  f.env.CAPTAIN_REFRESH_COORDINATOR.get=x=>
    Number(x.slice(CAPTAIN_PREFIX.length))===3?
      {fetch:async()=>new Response(null,{status:503})}:original(x);
  const report=await (await f.post(Date.now())).json();
  assert.equal(report.status,"partial-capture");
  assert.equal(report.snapshot.connectedAlliances,1);
  assert.equal(report.snapshot.unavailableSessions,1);
  assert.equal(report.snapshot.completeSessionScan,false);
  assert.ok(!JSON.stringify(report.snapshot).includes('"raidRank":0'));
});
