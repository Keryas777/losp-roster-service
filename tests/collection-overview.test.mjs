import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";
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
    readFile(new globalThis.URL("../src/admin-routes.js",import.meta.url),"utf8"),
    readFile(new globalThis.URL("../public/admin-navigation.js",import.meta.url),"utf8"),
    readFile(new globalThis.URL("../public/admin-collection-dashboard.js",import.meta.url),"utf8"),
    readFile(new globalThis.URL("../public/admin-explorer.css",import.meta.url),"utf8")
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

test("missing complete roster manifest is explained when a co-member opts out",async()=>{
  const f=await fixture();
  const run="11111111-2222-4333-8444-555555555555";
  const started=now-3600000;
  await f.env.CAPTAIN_BUCKET.put("roster-batches/v1/"+FP+"/progress.json",
    JSON.stringify({version:1,fingerprint:FP,runId:run,
      membershipDigest:"c".repeat(64),
      startedAt:new Date(started).toISOString(),
      expiresAt:new Date(started+7*86400000).toISOString(),
      completed:22,totalEligible:22,observedMembers:24,selfCompleted:true,
      campaign:"2026-10-22-am"}));
  await f.env.CAPTAIN_BUCKET.put("roster-batches/v1/"+FP+"/"+run+
    "/member-self.json","{}");
  const result=await (await handleCollectionOverview(new Request(URL),f.env,now)).json();
  const alliance=result.rosters.alliances[0];
  assert.equal(alliance.progress,"partial-consent");
  assert.equal(alliance.completed,22);
  assert.equal(alliance.eligible,22);
  assert.equal(alliance.observedMembers,24);
  assert.equal(alliance.noShareCount,1);
  assert.equal(alliance.personalRosterCollected,true);
  assert.equal(alliance.personalFilePresent,true);
  assert.equal(alliance.snapshot,"missing");
  assert.ok(!JSON.stringify(result).includes(FP),
    "The overview must not leak alliance fingerprints");
});

test("roster alliance color tags are rendered as bounded CSS colors without HTML injection",async()=>{
  const files=await Promise.all([
    readFile(new globalThis.URL("../public/admin-collection-dashboard.js",import.meta.url),"utf8"),
    readFile(new globalThis.URL("../public/admin-roster-r2-coverage.js",import.meta.url),"utf8")
  ]);
  const js=files[0];
  const start=js.indexOf("  function allianceNameParts(");
  const end=js.indexOf("  function renderProgress(",start);
  assert.ok(start>=0&&end>start);
  const parse=runInNewContext(js.slice(start,end)+"\nallianceNameParts");
  const athena=parse("LoSP <#F28C28>Athena");
  assert.equal(athena.prefix,"LoSP ");
  assert.equal(athena.name,"Athena");
  assert.equal(athena.color,"#F28C28");
  const kronos=parse("LoSP <#FFFFFF>LoSP <#E10D17>Kronos");
  assert.equal(kronos.prefix,"LoSP ");
  assert.equal(kronos.name,"Kronos");
  assert.equal(kronos.color,"#E10D17");
  const poseidon=parse("LoSP <#00D0FF>Poseidon");
  assert.equal(poseidon.name,"Poseidon");
  assert.equal(poseidon.color,"#00D0FF");
  const unmarked=parse("LoSP Dionysos");
  assert.equal(unmarked.color,null);
  assert.equal(unmarked.name,"Dionysos");
  assert.ok(files.every(script=>!script.includes("innerHTML")));
  assert.ok(files.every(script=>!script.includes("eval(")));
  assert.ok(files[1].includes("membre(s) ne partagent pas leur roster"));
});
