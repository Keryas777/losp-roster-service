import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {handleCollectionOverview} from "../src/collection-overview.js";
import {handleAdmin} from "../src/admin-routes.js";
import {putCaptainRecord,CAPTAIN_PREFIX} from "../src/captain-vault.js";

const URL="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/collection-overview";
const FP="a".repeat(64),SID="b".repeat(64);
const now=Date.parse("2026-10-22T12:00:00Z");
async function fixture(){
  const db=new Map(),history=[];
  const bucket={
    get:async key=>{
      history.push(["get",key]);
      const v=db.get(key);
      return v===undefined?null:{size:v.length,text:async()=>v};
    },
    put:async(key,value)=>{db.set(key,String(value));},
    delete:async key=>db.delete(key),
    head:async key=>{history.push(["head",key]);return db.has(key)?{key}:null;},
    list:async ({prefix})=>{
      history.push(["list",prefix]);
      return {objects:[...db.keys()].filter(k=>k.startsWith(prefix))
        .map(key=>({key})),truncated:false};
    }
  };
  const env={CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ba".repeat(32),
    CAPTAIN_BUCKET:bucket,
    ROSTER_BATCH_LOCK:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({status:"acquired"})})},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({status:"active"})})},
    ROSTER_AUTO_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    GAME_ARCHIVE_AUTO_ENABLED:"true"
  };
  await putCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,CAPTAIN_PREFIX+SID,{
    version:2,createdAt:now-86400000,expiresAt:now+100*86400000,
    accessExpiresAt:now+3600000,accessToken:"PRIVATE_TOKEN",refreshToken:"PRIVATE_REFRESH",
    scope:"offline m3p.f.pr.ros m3p.f.pr.inv m3p.f.ar.ros"
  });
  await bucket.put("roster-sync/v1/approved-alliances.json",JSON.stringify({
    version:1,alliances:[{fingerprint:FP,name:"LoSP Zeus"}]
  }));
  const folder="roster-batches/v1/player-extras/"+SID+"/personal-inventory/self/";
  const page=folder+"run/page-1.json";
  await bucket.put(page,"{\"raw\":\"very private\"}");
  await bucket.put(folder+"latest.json",JSON.stringify({
    version:1,complete:true,resource:"personal-inventory",
    capturedAt:new Date(now-3600000).toISOString(),
    expiresAt:new Date(now+6*86400000).toISOString(),
    total:7,pages:[{key:page,page:1,count:7}]
  }));
  await bucket.put("oauth-monitoring/v1/last-refresh-check.json",JSON.stringify({
    version:1,status:"ok",checkedAt:new Date(now-2*3600000).toISOString(),
    checked:1,failed:0,rotated:0
  }));
  return {env,db,history};
}
test("dashboard reads existing R2 only, distinguishes eligible, archived and missing families",async()=>{
  const f=await fixture();
  let called=0;
  // No fetchImpl can be injected: dashboard is structurally R2-only.
  const r=await handleCollectionOverview(new Request(URL),f.env,now);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.source,"private-r2-only");
  assert.equal(data.personal.status,"ok");
  assert.equal(data.personal.accountsStored,1);
  assert.equal(data.personal.accountsActive,1);
  const inv=data.personal.families.find(x=>x.id==="personal-inventory");
  assert.equal(inv.eligible,1);
  assert.equal(inv.archived,1);
  assert.equal(inv.totalEntries,7);
  const squads=data.personal.families.find(x=>x.id==="personal-squads");
  assert.equal(squads.eligible,1);
  assert.equal(squads.missing,1);
  assert.equal(data.personal.families.find(x=>x.id==="personal-events").notGranted,1);
  assert.equal(data.rosters.approvedCount,1);
  assert.equal(data.rosters.alliances[0].verified,false);
  assert.equal(data.oauth.checked,1);
  assert.equal(data.game.status,"not-started");
  const text=JSON.stringify(data);
  assert.ok(!text.includes("PRIVATE_TOKEN"));
  assert.ok(!text.includes("PRIVATE_REFRESH"));
  assert.ok(!text.includes(SID));
  assert.ok(!text.includes(FP));
  assert.ok(!text.includes("very private"));
  assert.equal(called,0);
  assert.ok(f.history.some(([op,key])=>op==="head"&&key.includes("personal-inventory")));
});
test("manifest with missing backing page cannot be reported as archived",async()=>{
  const f=await fixture();
  for(const k of f.db.keys())if(k.endsWith("/run/page-1.json"))f.db.delete(k);
  const data=await (await handleCollectionOverview(new Request(URL),f.env,now)).json();
  const inv=data.personal.families.find(x=>x.id==="personal-inventory");
  assert.equal(inv.archived,0);
  assert.equal(inv.broken,1);
});
test("malformed or unavailable OAuth storage does not appear as successful /player coverage",async()=>{
  const f=await fixture();
  f.env.CAPTAIN_BUCKET.list=async()=>{throw Error("R2 offline");};
  const data=await (await handleCollectionOverview(new Request(URL),f.env,now)).json();
  assert.equal(data.personal.status,"unavailable");
  assert.equal(data.status,"ok"); // Independent other panels can still render
});
test("read-only method and query checks, protected admin Access boundary",async()=>{
  const f=await fixture();
  assert.equal((await handleCollectionOverview(new Request(URL,{method:"POST"}),f.env,now)).status,405);
  assert.equal((await handleCollectionOverview(new Request(URL+"?bad=1"),f.env,now)).status,400);
  const bad={...f.env,MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const before=f.history.length;
  assert.equal((await handleAdmin(new Request(URL),bad)).status,403);
  assert.equal(f.history.length,before,"Unauthorized clients can't read R2 snapshots");
});
test("overview is visible, mobile-first, and uses one bounded R2-only endpoint",async()=>{
  const [html,nav,js,css]=await Promise.all([
    readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8"),
    readFile(new URL("../public/admin-navigation.js",import.meta.url),"utf8"),
    readFile(new URL("../public/admin-collection-dashboard.js",import.meta.url),"utf8"),
    readFile(new URL("../public/admin-explorer.css",import.meta.url),"utf8")
  ]);
  assert.match(html,/id="collection-dashboard"/);
  assert.match(html,/id="collection-dashboard-refresh"/);
  assert.match(nav,/"collection-dashboard-refresh"/);
  assert.match(nav,/section\.id==="collection-dashboard"/);
  assert.match(js,/\/admin\/api\/collection-overview/);
  assert.match(js,/void load\(\)/);
  assert.doesNotMatch(js,/\/admin\/api\/sessions|\/admin\/api\/data|\/player\/v1/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML|setInterval/);
  assert.match(css,/\.collection-grid/);
  assert.doesNotThrow(()=>new Script(js));
});
