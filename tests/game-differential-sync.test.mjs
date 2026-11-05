import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {runGameDifferentialTick,gameDifferentialStatus,gameScheduledSlot,nextGameScheduledAt} from "../src/game-differential-sync.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";
import {publicAwakenedMaterials} from "../src/awakened-material-catalog.js";
import {handleAdmin} from "../src/admin-routes.js";

const NOW=Date.UTC(2026,9,23,0,0,0);
const MON_SLOT=Date.parse("2026-10-26T00:00:00Z");
const THU_SLOT=Date.parse("2026-10-29T12:00:00Z");
const ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const SOURCE="a1bcde22-1234-4a22-8b33-aabbccddeeff";
const RUN=GAME_ARCHIVE_ROOT+"runs/"+SOURCE+"/";
function fixture({baseline="completed",api}={}){
  const storage=new Map(),locks=new Map(),store=new Map(),calls=[];
  const bucket={
    get:async key=>store.has(key)?{
      size:String(store.get(key)).length,text:async()=>store.get(key)
    }:null,
    head:async key=>store.has(key)?{key}:null,
    put:async(key,value)=>{
      store.set(key,typeof value==="string"?value:new TextDecoder().decode(value));
    },
    list:async({prefix,limit=50,cursor})=>{
      const all=[...store.keys()].filter(k=>k.startsWith(prefix)).sort();
      const start=cursor?Number(cursor):0;
      const selected=all.slice(start,start+limit);
      return {objects:selected.map(key=>({key})),
        truncated:start+limit<all.length,
        cursor:start+limit<all.length?String(start+limit):undefined};
    }
  };
  const env={GAME_DIFF_ENABLED:"true",GAME_ARCHIVE_AUTO_ENABLED:"true",
    SCOPELY_CLIENT_ID:"client",SCOPELY_CLIENT_SECRET:"secret",
    CAPTAIN_BUCKET:bucket,ROSTER_BATCH_LOCK:{
      idFromName:x=>x,
      get:x=>{
        if(!locks.has(x))locks.set(x,new RosterBatchLock({
          storage:{
            get:async k=>storage.get(x+"|"+k),
            put:async(k,v)=>{storage.set(x+"|"+k,v);},
            delete:async k=>{storage.delete(x+"|"+k);}
          }
        }));
        return {fetch:request=>locks.get(x).fetch(request)};
      }
    }};
  const provider=async(url,opts)=>{
    calls.push({url,method:opts.method});
    if(url.endsWith("/oauth2/token"))
      return Response.json({access_token:"TOKEN_DO_NOT_LEAK",
        token_type:"Bearer",expires_in:7200});
    assert.match(url,/^https:\/\/api\.marvelstrikeforce\.com\/game\/v1\//);
    assert.equal(opts.headers.Authorization,"Bearer TOKEN_DO_NOT_LEAK");
    return api?api(url,calls):Response.json({
      data:[],meta:{asOf:"2026-10-23T00:00:00Z",perTotal:0}
    });
  };
  async function seed(){
    await bucket.put(ACTIVE,JSON.stringify({version:1,runId:SOURCE}));
    await bucket.put(RUN+"progress.json",JSON.stringify({
      version:1,runId:SOURCE,status:baseline,phase2:{status:"done"}
    }));
    const old={data:[],meta:{asOf:"2026-10-20T00:00:00Z",perTotal:0}};
    const key=RUN+"objects/"+("a".repeat(64))+".json";
    await bucket.put(key,JSON.stringify(old));
    await bucket.put(RUN+"receipts/0000000001-00001-s0.json",JSON.stringify({
      version:1,path:"/game/v1/languages?page=1&perPage=100",
      status:200,objectKey:key,sha256:"b".repeat(64)
    }));
  }
  return {env,store,calls,seed,provider};
}
async function finish(f,start=NOW){
  let last,ts=start;
  for(let i=0;i<120;i++){
    ts=start+i*60000;
    last=await runGameDifferentialTick(f.env,f.provider,ts);
    const status=await gameDifferentialStatus(f.env);
    if(["completed","partial"].includes(status.status))return {last,status,ts};
    if(last.status==="unavailable"||last.status==="invalid-state"||
       last.status==="invalid-queue"||last.status==="invalid-path")
      throw Error("broken differential: "+JSON.stringify(last));
  }
  throw Error("diff did not finish: "+JSON.stringify(last));
}
test("verified scheduled differential automatically publishes new awakened icons",async()=>{
  const icon="https://assets.marvelstrikeforce.com/imgs/NEW_HERO_SPECIAL_aa112233.png";
  const id="ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_NEW_HERO_SPECIAL";
  const api=()=>Response.json({data:{
    rewards:{allOf:[{item:{id,name:"New Hero Special Awakened Material",
      icon},quantity:50}]}},meta:{asOf:"2026-10-29T08:00:00Z"}});
  const f=fixture({api});await f.seed();
  const {status,ts}=await finish(f);
  assert.equal(status.status,"completed");
  const response=await publicAwakenedMaterials(new Request(
    "https://losp-roster-service.deliriousfan7.workers.dev/api/public/awakened-materials"
  ),f.env,ts);
  assert.equal(response.status,200);
  const catalog=await response.json();
  assert.equal(catalog.materials.length,1);
  assert.deepEqual(catalog.materials[0],{
    id,characterId:"NEW_HERO",abilityType:"SPECIAL",
    name:"New Hero Special Awakened Material",
    description:null,iconUrl:icon
  });
  assert.ok(f.calls.some(call=>call.url.includes("/game/v1/")));
  assert.ok([...f.store.keys()].some(key=>
    key==="game-archive/v1/materials/public/v1/differential.json"));
});

test("no initial archive or unfinished baseline: zero /game requests",async()=>{
  const f=fixture();
  assert.equal((await runGameDifferentialTick(f.env,f.provider,NOW)).status,
    "awaiting-initial-archive");
  assert.equal(f.calls.length,0);
  await f.seed();
  f.store.set(RUN+"progress.json",JSON.stringify({
    version:1,runId:SOURCE,status:"running",phase2:{status:"done"}
  }));
  assert.equal((await runGameDifferentialTick(f.env,f.provider,NOW)).status,
    "awaiting-initial-completion");
  assert.equal(f.calls.length,0);
});
test("scheduled /game comparison stores changed objects only, ignoring meta.asOf",async()=>{
  const f=fixture();await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  assert.ok(first.status.unchanged>=1);
  assert.ok(first.status.changed>=1);
  const objects=[...f.store.keys()].filter(x=>x.includes("/diff/runs/")&&
    x.includes("/objects/"));
  assert.ok(objects.length>0&&objects.length<=first.status.changed,
    "identical payload bytes across URLs share one content-addressed object");
  const today=await runGameDifferentialTick(f.env,f.provider,first.ts+3600000);
  assert.equal(today.status,"completed");
  assert.ok(!f.calls.some(x=>x.url.includes("/player/v1")));
  const old=objects.length;
  const second=await finish(f,MON_SLOT);
  assert.equal(second.status.status,"completed");
  assert.equal(second.status.changed,0);
  assert.ok(second.status.unchanged>=first.status.changed);
  const objectsAfter=[...f.store.keys()].filter(x=>x.includes("/diff/runs/")&&
    x.includes("/objects/"));
  assert.equal(objectsAfter.length,old,"no duplicate provider JSON for unchanged routes");
  const state=await gameDifferentialStatus(f.env);
  assert.ok(!JSON.stringify(state).includes("TOKEN_DO_NOT_LEAK"));
  assert.ok(state.completedAt);
  const budget=[...f.store.keys()].filter(x=>x.includes("/budget/"));
  assert.ok(budget.length>0,"share original game budget");
});
test("a changed root list discovers genuinely new characters during a delta",async()=>{
  const f=fixture({api:url=>url.includes("/characters?page=1")?
    Response.json({data:[{id:"BrandNewMSF"}],
      meta:{page:1,perTotal:1,asOf:"2026-10-23"}}):
    Response.json({data:[],meta:{perTotal:0}})});
  await f.seed();
  const r=await finish(f);
  assert.equal(r.status.status,"completed");
  assert.ok(f.calls.some(x=>x.url.endsWith("/game/v1/characters/BrandNewMSF")),
    "new character details discovered without starting a full new archive");
  const checks=[...f.store.values()].filter(x=>
    typeof x==="string"&&x.includes('"status":"changed"'));
  assert.ok(checks.length>0);
});
test("429 protects provider, resumes after 1h, and does not claim completed",async()=>{
  const f=fixture({api:()=>new Response("rate limited",{status:429})});
  await f.seed();
  for(let i=0;i<4;i++)
    await runGameDifferentialTick(f.env,f.provider,NOW+i*60000);
  const check=await runGameDifferentialTick(f.env,f.provider,NOW+4*60000);
  assert.equal(check.status,"cooldown");
  const n=f.calls.length;
  const again=await runGameDifferentialTick(f.env,f.provider,NOW+5*60000);
  assert.equal(again.status,"cooldown");
  assert.equal(f.calls.length,n);
  const status=await gameDifferentialStatus(f.env);
  assert.equal(status.status,"checking");
  assert.ok(status.pauseUntil);
});
test("diff is opt-in and does not consume OAuth with disabled configuration",async()=>{
  const f=fixture();await f.seed();
  f.env.GAME_DIFF_ENABLED="false";
  assert.equal((await runGameDifferentialTick(f.env,f.provider,NOW)).status,"disabled");
  assert.equal(f.calls.length,0);
});
test("admin and default overview never allow unauthenticated differential status",async()=>{
  const f=fixture();
  const url="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/game-differential";
  const res=await handleAdmin(new Request(url),{
    ...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"tests.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"
  });
  assert.equal(res.status,403);
  const wrangler=JSON.parse(await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
  assert.equal(wrangler.vars.GAME_DIFF_ENABLED,"true");
  assert.ok(wrangler.triggers.crons.includes("* * * * *"));
  assert.equal(f.calls.length,0);
});

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const DIFF=GAME_ARCHIVE_ROOT+"diff/";
async function correctSeedHash(f,capturedAt="2026-10-20T00:00:00.000Z"){
  // Source fixture must faithfully represent an SHA-addressed initial archive.
  const bytes=JSON.stringify({data:[],meta:{asOf:"2026-10-20T00:00:00Z",perTotal:0}});
  const h=sha(bytes);
  const objectKey=RUN+"objects/"+h+".json";
  const original=RUN+"objects/"+"a".repeat(64)+".json";
  f.store.delete(original);f.store.set(objectKey,bytes);
  f.store.set(RUN+"receipts/0000000001-00001-s0.json",JSON.stringify({
    version:1,path:"/game/v1/languages?page=1&perPage=100",status:200,
    objectKey,sha256:h,capturedAt
  }));
  return {objectKey,sha256:h};
}
function checks(f){return [...f.store.entries()].filter(([key])=>
  key.startsWith(DIFF+"runs/")&&key.includes("/checks/"));}
function latestFor(f,path){
  const key=DIFF+"latest/"+sha(path)+".json";
  return f.store.get(key)?JSON.parse(f.store.get(key)):null;
}

test("meta.asOf-only change keeps the SHA of STORED bytes and exposes observed SHA separately",async()=>{
  const f=fixture();await f.seed();
  const original=await correctSeedHash(f);
  const completed=await finish(f);
  assert.equal(completed.status.status,"completed");
  const path="/game/v1/languages?page=1&perPage=100";
  const latest=latestFor(f,path);
  assert.ok(latest,"official route is indexed after the check");
  assert.equal(latest.version,2);
  assert.equal(latest.objectKey,original.objectKey,
    "no unnecessary R2 object for a metadata-only change");
  assert.equal(latest.sha256,original.sha256,
    "SHA pointer describes stored content, never newly observed bytes");
  assert.notEqual(latest.observedSha256,latest.sha256,
    "the newly fetched asOf produced different raw response bytes");
  assert.equal(sha(f.store.get(latest.objectKey)),latest.sha256);
  assert.ok(latest.receiptKey&&f.store.has(latest.receiptKey));
  const receipt=JSON.parse(f.store.get(latest.receiptKey));
  assert.equal(receipt.status,"unchanged");
  assert.equal(receipt.sha256,latest.sha256);
  assert.equal(receipt.observedSha256,latest.observedSha256);
  assert.equal(latest.storedAt,"2026-10-20T00:00:00.000Z");
});

test("old bytes are re-materialized before the 30-day limit even without semantic change",async()=>{
  const f=fixture();await f.seed();
  const source=await correctSeedHash(f,"2026-09-25T00:00:00.000Z");
  const completed=await finish(f);
  assert.equal(completed.status.status,"completed");
  const path="/game/v1/languages?page=1&perPage=100";
  const latest=latestFor(f,path);
  assert.notEqual(latest.objectKey,source.objectKey);
  assert.equal(latest.refreshed,true);
  assert.equal(latest.sha256,latest.observedSha256);
  assert.ok(Date.parse(latest.storedAt)>=NOW,
    "renewed object must carry the capture time of fresh bytes");
  assert.equal(sha(f.store.get(latest.objectKey)),latest.sha256);
  const receipt=JSON.parse(f.store.get(latest.receiptKey));
  assert.equal(receipt.status,"unchanged");
  assert.equal(receipt.refreshed,true);
  assert.ok(completed.status.refreshed>=1);
});

async function tickUntilSimulatedFailure(f){
  // The Cron GET ceiling can evolve; do not tie the crash fixture to
  // a magic number of scan/GET ticks.
  for(let i=0;i<20;i++){
    const result=await runGameDifferentialTick(f.env,f.provider,NOW+i*60000);
    if(result.status==="unavailable")return i;
    assert.notEqual(result.status,"invalid-state");
  }
  throw Error("simulated R2 write failure was never reached");
}

test("failed receipt write cannot publish latest or claim task completed",async()=>{
  const f=fixture();await f.seed();
  let injected=0;
  const bucket=f.env.CAPTAIN_BUCKET,originalPut=bucket.put.bind(bucket);
  bucket.put=async(key,value)=>{
    if(key.includes("/checks/")&&injected++===0)
      throw Error("simulated-receipt-write-failure");
    return originalPut(key,value);
  };
  const interruptedTick=await tickUntilSimulatedFailure(f);
  assert.equal(checks(f).length,0);
  assert.equal([...f.store.keys()].filter(k=>k.startsWith(DIFF+"latest/")).length,0);
  const resumed=await runGameDifferentialTick(f.env,f.provider,
    NOW+(interruptedTick+1)*60000);
  assert.notEqual(resumed.status,"unavailable");
  assert.ok(checks(f).length>0);
});

test("pointer-write failure replays its durable receipt without repeating the upstream GET",async()=>{
  const f=fixture();await f.seed();
  let failed=false;
  const bucket=f.env.CAPTAIN_BUCKET,originalPut=bucket.put.bind(bucket);
  bucket.put=async(key,value)=>{
    if(key.startsWith(DIFF+"latest/")&&!failed){
      failed=true;throw Error("simulated-latest-write-failure");
    }
    return originalPut(key,value);
  };
  const interruptedTick=await tickUntilSimulatedFailure(f);
  const journals=checks(f);
  assert.equal(journals.length,1);
  const receipt=JSON.parse(journals[0][1]);
  assert.ok(f.store.has(receipt.objectKey),"stored object already exists");
  assert.equal(latestFor(f,receipt.path),null,"no early published pointer");
  const gameUrl="https://api.marvelstrikeforce.com"+receipt.path;
  const counted=()=>f.calls.filter(x=>x.url===gameUrl).length;
  const before=counted();
  const resumed=await runGameDifferentialTick(f.env,f.provider,
    NOW+(interruptedTick+1)*60000);
  assert.notEqual(resumed.status,"unavailable");
  assert.equal(counted(),before,"a committed task must never consume a repeat GET");
  assert.deepEqual(checks(f).filter(([key])=>key===journals[0][0]),journals);
  const latest=latestFor(f,receipt.path);
  assert.equal(latest.receiptKey,journals[0][0]);
  assert.equal(latest.sha256,receipt.sha256);
  assert.equal(sha(f.store.get(latest.objectKey)),latest.sha256);
});

test("missing or mismatched legacy references do not become falsely fresh",async()=>{
  const f=fixture();await f.seed();
  const done=await finish(f);
  assert.equal(done.status.status,"completed");
  const path="/game/v1/languages?page=1&perPage=100";
  const latest=latestFor(f,path);
  assert.ok(latest);
  assert.equal(latest.sha256,sha(f.store.get(latest.objectKey)));
  const receipt=JSON.parse(f.store.get(latest.receiptKey));
  assert.equal(receipt.status,"unchanged");
  assert.equal(receipt.refreshed,true,"the bad baseline SHA must be replaced");
});


test("HTTP 472 on an unpageable root immediately schedules its documented finite details",async()=>{
  const f=fixture({api:url=>url.endsWith("/game/v1/upgradeData")?
    new Response("representation too large",{status:472}):
    Response.json({data:[],meta:{perTotal:0}})});
  await f.seed();
  const result=await finish(f);
  assert.equal(result.status.status,"partial","root 472 remains an explicit gap");
  assert.ok(f.calls.some(x=>x.url.endsWith(
    "/game/v1/upgradeData/playerLevelTotalXp")));
  const pending=[...f.store.entries()].filter(([k])=>
    k.includes("/diff/recovery/pending/")).map(([,v])=>JSON.parse(v));
  const root=pending.find(x=>x.path==="/game/v1/upgradeData");
  assert.equal(root?.reason,"http-472");
  assert.equal(root?.status,"pending");
  assert.equal(root?.attempts,1);
  assert.ok(result.status.recoveryQueued>=12,"the existing finite-ID recovery was reused");
  assert.notEqual(result.status.lastOutcome,"cooldown");
});

test("HTTP 472 on pageable list halves perPage and resets to page one without waiting",async()=>{
  const f=fixture({api:url=>url.includes(
    "/game/v1/characters?page=1&perPage=100")?
    new Response("oversized",{status:472}):
    Response.json({data:[],meta:{perTotal:0,page:1}})});
  await f.seed();
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  assert.ok(f.calls.some(x=>x.url.includes(
    "/game/v1/characters?page=1&perPage=50")));
  assert.equal(result.status.pauseUntil,null);
});

test("character 472 uses the already-approved split abilities, with bounded tasks",async()=>{
  const f=fixture({api:url=>{
    if(url.includes("/game/v1/characters?page=1"))
      return Response.json({data:[{id:"ExampleMSF"}],meta:{page:1,perTotal:1}});
    if(url.endsWith("/game/v1/characters/ExampleMSF")||
       url.includes("/game/v1/characters/ExampleMSF?")&&
         url.includes("abilityKits=full"))
      return new Response("too large",{status:472});
    return Response.json({data:{id:"ExampleMSF"},meta:{}});
  }});
  await f.seed();
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  for(const ability of ["basic","special","ultimate","passive"])
    assert.ok(f.calls.some(x=>x.url.includes(
      "/game/v1/characters/ExampleMSF?")&&x.url.includes(
      "abilityKits="+ability)),"split not collected: "+ability);
  assert.ok(result.status.queued<100,"strictly finite documented recovery");
});

test("previously failed checks are backfilled in place without resetting the active run",async()=>{
  const f=fixture();await f.seed();
  const run="70aa2222-3333-4333-8333-aabbccddeeff";
  const root=GAME_ARCHIVE_ROOT+"diff/";
  f.store.set(root+"state.json",JSON.stringify({
    version:1,runId:run,sourceRun:SOURCE,status:"checking",
    scanPhase:"done",writeIndex:0,readIndex:0,readOffset:0,
    queued:0,checked:1,changed:0,unchanged:0,failed:1,
    retries:0,pauseUntil:null,startedAt:new Date(NOW-3600000).toISOString()
  }));
  f.store.set(root+"runs/"+run+"/checks/00000000.json",
    JSON.stringify({version:1,path:"/game/v1/upgradeData",
      reason:"http-472",status:"failed"}));
  const status=await runGameDifferentialTick(f.env,f.provider,NOW);
  assert.notEqual(status.status,"unavailable");
  const state=JSON.parse(f.store.get(root+"state.json"));
  assert.equal(state.runId,run,"existing runId retained");
  assert.equal(state.recoveryBackfill.cursor,1);
  assert.equal(state.recoveryBackfill.end,1);
  assert.ok(state.queued>=12,"historical 472 generated finite-detail tasks");
  assert.ok(f.store.has(root+"recovery/pending/"+
    sha("/game/v1/upgradeData")+".json"));
});

test("recovery ledger feeds a later run and a successful check marks it resolved",async()=>{
  const f=fixture();await f.seed();
  const path="/game/v1/characters/LegacyFailed";
  const k=GAME_ARCHIVE_ROOT+"diff/recovery/pending/"+sha(path)+".json";
  f.store.set(k,JSON.stringify({version:1,path,status:"pending",
    attempts:1,reason:"http-472",lastRun:"different",
    nextAt:new Date(NOW-60000).toISOString(),
    firstSeenAt:new Date(NOW-WEEK_MS).toISOString()}));
  const result=await finish(f);
  assert.equal(result.status.status,"completed");
  assert.ok(f.calls.some(x=>x.url.endsWith(path)),"pending URL is retried");
  assert.equal(JSON.parse(f.store.get(k)).status,"resolved");
});
const WEEK_MS=7*86400000;


async function seedItemAssociation(f,itemId="SHARD_TEST"){
  const parent="/game/v1/items/"+itemId;
  const doc={data:{id:itemId},meta:{}};
  const bytes=JSON.stringify(doc);
  const h=sha(bytes);
  const key=RUN+"objects/"+h+".json";
  f.store.set(key,bytes);
  f.store.set(RUN+"receipts/0000000002-00002-s0.json",JSON.stringify({
    version:1,path:parent,status:200,objectKey:key,sha256:h,
    capturedAt:new Date(NOW-86400000).toISOString()
  }));
  const semanticHash=sha(bytes);
  f.store.set(DIFF+"latest/"+sha(parent)+".json",JSON.stringify({
    version:2,path:parent,semanticHash,objectKey:key,sha256:h,
    storedAt:new Date(NOW-86400000).toISOString()
  }));
  return {parent,association:parent+"/characters?charInfo=full",semanticHash};
}

test("unchanged item 404 associations are suppressed without suppressing item updates",async()=>{
  const api=changed=>url=>{
    if(url.includes("/game/v1/items/SHARD_TEST/characters"))
      return new Response("not found",{status:404});
    if(url.endsWith("/game/v1/items/SHARD_TEST"))
      return Response.json({data:{id:"SHARD_TEST",...(changed?{updated:1}:{})},meta:{}});
    return Response.json({data:[],meta:{perTotal:0}});
  };
  const f=fixture({api:api(false)});await f.seed();
  const {association,semanticHash}=await seedItemAssociation(f);
  const ledger=DIFF+"recovery/pending/"+sha(association)+".json";
  f.store.set(ledger,JSON.stringify({version:2,path:association,
    status:"pending",reason:"http-404",attempts:1,
    associationSourceHash:semanticHash,lastRun:"prior-run",
    lastSeenAt:new Date(NOW-86400000).toISOString(),
    nextAt:new Date(NOW+14*86400000).toISOString()}));
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  assert.equal(f.calls.filter(x=>x.url.includes("/items/SHARD_TEST/characters")).length,0);
  assert.ok(f.calls.some(x=>x.url.endsWith("/items/SHARD_TEST")),
    "item itself must still be checked");

  const g=fixture({api:api(true)});await g.seed();
  await seedItemAssociation(g);
  g.store.set(ledger,f.store.get(ledger));
  const changed=await finish(g);
  assert.equal(changed.status.status,"partial");
  assert.ok(g.calls.some(x=>x.url.includes("/items/SHARD_TEST/characters")),
    "updated source must immediately re-enable associated URL");
  const updated=JSON.parse(g.store.get(ledger));
  assert.equal(updated.reason,"http-404");
  assert.notEqual(updated.associationSourceHash,semanticHash);
  assert.ok(Date.parse(updated.nextAt)>=NOW+20*86400000,
    "repeat 404 is postponed, never permanently forgotten");
});

test("new failure preserves 472 recovery provenance from preceding campaigns",async()=>{
  const path="/game/v1/characters/LegacyLarge";
  const oldPart=path+"?abilityKits=basic";
  const f=fixture({api:url=>url.endsWith(path)?
    new Response("too large",{status:472}):
    Response.json({data:{id:"LegacyLarge"},meta:{perTotal:0}})});
  await f.seed();
  const ledger=DIFF+"recovery/pending/"+sha(path)+".json";
  f.store.set(ledger,JSON.stringify({version:1,path,status:"pending",
    reason:"http-472",attempts:1,lastRun:"older",
    nextAt:new Date(NOW-60000).toISOString(),
    recoveredParts:[oldPart],lastPartialAt:new Date(NOW-86400000).toISOString()}));
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  const row=JSON.parse(f.store.get(ledger));
  assert.equal(row.status,"pending");
  assert.ok(row.recoveredParts.includes(oldPart),
    "a fresh failure must not erase already archived split-part evidence");
  assert.equal(row.attempts,2);
  assert.ok(row.lastPartialAt);
});

test("a previously resolved association returns to pending on a later 404",async()=>{
  const f=fixture({api:url=>url.includes("/items/SHARD_TEST/characters")?
    new Response("not found",{status:404}):
    url.endsWith("/game/v1/items/SHARD_TEST")?
      Response.json({data:{id:"SHARD_TEST"},meta:{}}):
      Response.json({data:[],meta:{perTotal:0}})});
  await f.seed();
  const {association}=await seedItemAssociation(f);
  const ledger=DIFF+"recovery/pending/"+sha(association)+".json";
  f.store.set(ledger,JSON.stringify({version:1,path:association,status:"resolved",
    reason:"http-404",attempts:2,lastRun:"last-week",
    resolvedAt:new Date(NOW-2*86400000).toISOString()}));
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  const row=JSON.parse(f.store.get(ledger));
  assert.equal(row.status,"pending");
  assert.equal(row.attempts,1);
  assert.ok(row.lastResolvedAt);
});

test("completed scheduled /game differential skips DO locks until renewal",async()=>{
  const f=fixture();
  await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  const original=f.env.ROSTER_BATCH_LOCK.get;
  let leases=0;
  f.env.ROSTER_BATCH_LOCK.get=id=>{leases++;return original(id);};
  const calls=f.calls.length;
  for(let i=1;i<=30;i++){
    const r=await runGameDifferentialTick(f.env,f.provider,first.ts+i*60_000);
    assert.equal(r.status,"completed");
  }
  assert.equal(leases,0,"idle scheduled status must not open a DO lock");
  assert.equal(f.calls.length,calls);
  const renew=await runGameDifferentialTick(f.env,f.provider,
    MON_SLOT);
  assert.notEqual(renew.status,"unavailable");
  assert.ok(leases>0,"scheduled renewal immediately resumes locked work");
});

test("a newly selected /game baseline invalidates the scheduled idle shortcut",async()=>{
  const f=fixture();
  await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  const original=f.env.ROSTER_BATCH_LOCK.get;
  let leases=0;
  f.env.ROSTER_BATCH_LOCK.get=id=>{leases++;return original(id);};
  f.store.set(ACTIVE,JSON.stringify({
    version:1,runId:"bbbbbbbb-1234-4122-8333-aabbccddeeff"
  }));
  const r=await runGameDifferentialTick(f.env,f.provider,first.ts+60_000);
  assert.equal(r.status,"awaiting-initial-completion");
  assert.ok(leases>0,"a new baseline cannot remain hidden until the next scheduled slot");
});


function fullCharacterPath(id){
  return "/game/v1/characters/"+id+
    "?abilityKits=full&costumes=full&gearTiers=full"+
    "&pieceInfo=full&pieceDirectCost=full&pieceFlatCost=full";
}
function characterScenario({missingSection=false}={}){
  let revision=1;
  const id="RECOVERY_HERO",full=fullCharacterPath(id);
  const api=url=>{
    if(url.includes("/game/v1/characters?page=1"))
      return Response.json({data:[{id}],meta:{page:1,perTotal:1}});
    if(url.endsWith("/game/v1/characters/"+id))
      return Response.json({data:{id,revision},meta:{}});
    if(url.endsWith(full))return new Response("large",{status:472});
    if(missingSection&&url.includes("/game/v1/characters/"+id+"?")&&
       url.includes("pieceFlatCost=full")&&url.includes("pieceInfo=none"))
      return new Response("large",{status:472});
    return Response.json({data:{id,revision},meta:{perTotal:0}});
  };
  return {api,id,full,setRevision:x=>{revision=x;}};
}

test("verified five-section 472 recovery defers redundant full GET in the following scheduled run",async()=>{
  const scenario=characterScenario();
  const f=fixture({api:scenario.api});await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"partial",
    "full response is still refused, never labelled successful");
  const key=DIFF+"recovery/pending/"+sha(scenario.full)+".json";
  const before=JSON.parse(f.store.get(key));
  assert.equal(before.status,"pending");
  assert.equal(Object.keys(before.verifiedParts||{}).length,5);
  assert.ok(before.expandedSourceHash);
  assert.ok(Date.parse(before.nextAt)-first.ts>=20*86400000);
  const calls=f.calls.length;
  const second=await finish(f,MON_SLOT);
  const newCalls=f.calls.slice(calls);
  assert.equal(newCalls.some(x=>x.url.endsWith(scenario.full)),false,
    "fresh five sections and unchanged character source defer known bad full");
  assert.ok(newCalls.some(x=>x.url.endsWith("/game/v1/characters/"+scenario.id)),
    "the source character is still synchronized");
  assert.equal(second.status.status,"completed");
  assert.equal(JSON.parse(f.store.get(key)).status,"pending",
    "deferred full is not artificially marked as resolved");
});

test("a changed character base immediately re-enables full URL and resets exhausted attempts",async()=>{
  const scenario=characterScenario();
  const f=fixture({api:scenario.api});await f.seed();
  const first=await finish(f);
  const key=DIFF+"recovery/pending/"+sha(scenario.full)+".json";
  const previous=JSON.parse(f.store.get(key));
  f.store.set(key,JSON.stringify({...previous,attempts:3}));
  scenario.setRevision(2);
  const priorCalls=f.calls.length;
  const second=await finish(f,MON_SLOT);
  assert.equal(second.status.status,"partial");
  assert.ok(f.calls.slice(priorCalls).some(x=>x.url.endsWith(scenario.full)),
    "changed parent must override prior defer and attempt exhaustion");
  const newer=JSON.parse(f.store.get(key));
  assert.notEqual(newer.expandedSourceHash,previous.expandedSourceHash);
  assert.equal(newer.attempts,1,"changed source starts a new attempt horizon");
});

test("partial 472 alternatives cannot suppress full retrieval on the next pass",async()=>{
  const scenario=characterScenario({missingSection:true});
  const f=fixture({api:scenario.api});await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"partial");
  const key=DIFF+"recovery/pending/"+sha(scenario.full)+".json";
  const pending=JSON.parse(f.store.get(key));
  assert.ok(Object.keys(pending.verifiedParts||{}).length<5);
  const before=f.calls.length;
  await finish(f,MON_SLOT);
  assert.ok(f.calls.slice(before).some(x=>x.url.endsWith(scenario.full)),
    "missing section requires an honest recheck of the original route");
});

test("an expired item source is not sufficient evidence to suppress an association 404",async()=>{
  const f=fixture({api:url=>url.includes("/items/AGE_TEST/characters")?
    new Response("not found",{status:404}):
    Response.json({data:[],meta:{perTotal:0}})});
  await f.seed();
  const {association,semanticHash}=await seedItemAssociation(f,"AGE_TEST");
  const parent="/game/v1/items/AGE_TEST",k=DIFF+"latest/"+sha(parent)+".json";
  const old=JSON.parse(f.store.get(k));
  f.store.set(k,JSON.stringify({...old,
    storedAt:new Date(NOW-40*86400000).toISOString()}));
  // Simulate an association from a historical receipt, scanned BEFORE the
  // parent item can be refreshed by the current differential.
  f.store.set(RUN+"receipts/0000000000-00000-s0.json",
    JSON.stringify({version:1,path:association,status:200}));
  f.store.set(DIFF+"recovery/pending/"+sha(association)+".json",
    JSON.stringify({version:2,path:association,reason:"http-404",
      status:"pending",attempts:1,lastRun:"prior-run",
      associationSourceHash:semanticHash,
      nextAt:new Date(NOW+14*86400000).toISOString()}));
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  assert.ok(f.calls.some(x=>x.url.endsWith(association)),
    "stale metadata cannot hide 404s on their next scheduled check");
});

test("a changed item parent resets attempts without hiding the original association 404",async()=>{
  const f=fixture({api:url=>{
    if(url.includes("/items/SHARD_TEST/characters"))
      return new Response("not found",{status:404});
    if(url.endsWith("/game/v1/items/SHARD_TEST"))
      return Response.json({data:{id:"SHARD_TEST",revision:2},meta:{}});
    return Response.json({data:[],meta:{perTotal:0}});
  }});
  await f.seed();
  const {association,semanticHash}=await seedItemAssociation(f);
  const key=DIFF+"recovery/pending/"+sha(association)+".json";
  f.store.set(key,JSON.stringify({path:association,status:"pending",
    reason:"http-404",associationSourceHash:semanticHash,
    nextAt:new Date(NOW+14*86400000).toISOString(),
    attempts:3,lastRun:"prior-run"}));
  const result=await finish(f);
  assert.equal(result.status.status,"partial");
  assert.equal(JSON.parse(f.store.get(key)).attempts,1);
});

test("global meta.hashes changes do not create new per-route game-data versions",async()=>{
  let globalRevision=1;
  const payload=()=>({data:{id:"STABLE",power:100},meta:{
    asOf:"2026-11-04T04:00:00Z",perTotal:1,
    hashes:{events:"events-"+globalRevision,
      drops:"drops-"+globalRevision,locs:"locs-"+globalRevision,
      nodes:"nodes-"+globalRevision,chars:"chars-"+globalRevision,
      other:"other-"+globalRevision,all:"all-"+globalRevision}
  }});
  const f=fixture({api:()=>Response.json(payload())});
  await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  const path="/game/v1/languages?page=1&perPage=100";
  const latestKey=DIFF+"latest/"+sha(path)+".json";
  const prior=JSON.parse(f.store.get(latestKey));
  assert.ok(prior?.objectKey);
  assert.equal(prior.semanticVersion,2);
  const stored=JSON.parse(f.store.get(prior.objectKey));
  assert.equal(stored.meta.hashes.events,"events-1",
    "the original official JSON must remain intact");
  const initialObjects=[...f.store.keys()].filter(x=>
    x.includes("/diff/runs/")&&x.includes("/objects/")).length;
  globalRevision=2;
  const second=await finish(f,MON_SLOT);
  const updated=JSON.parse(f.store.get(latestKey));
  const receipt=JSON.parse(f.store.get(updated.receiptKey));
  assert.equal(receipt.status,"unchanged");
  assert.equal(updated.semanticVersion,2);
  assert.equal(updated.semanticHash,prior.semanticHash);
  assert.equal(updated.objectKey,prior.objectKey,
    "global hash churn alone should not create a new R2 object");
  assert.notEqual(updated.observedSha256,updated.sha256,
    "observed raw SHA still records different official response bytes");
  assert.ok(second.status.unchanged>=1);
  assert.equal([...f.store.keys()].filter(x=>
    x.includes("/diff/runs/")&&x.includes("/objects/")).length,initialObjects);
  assert.equal(JSON.parse(f.store.get(updated.objectKey)).meta.hashes.all,"all-1");
});

test("legacy semantic V1 pointer is migrated without rewriting old R2 files",async()=>{
  let currentHashes="A";
  const f=fixture({api:()=>Response.json({
    data:{id:"UNCHANGED_CHARACTER",traits:["MSF"]},
    meta:{asOf:"2026-11-04T04:00:00Z",
      hashes:{chars:currentHashes,all:currentHashes}}
  })});
  await f.seed();
  const first=await finish(f);
  const path="/game/v1/languages?page=1&perPage=100";
  const key=DIFF+"latest/"+sha(path)+".json";
  const pointer=JSON.parse(f.store.get(key));
  const raw=JSON.parse(f.store.get(pointer.objectKey));
  const legacy={...raw,meta:{...raw.meta}};
  delete legacy.meta.asOf; // V1 included meta.hashes.
  const legacyHash=sha(JSON.stringify(legacy));
  f.store.set(key,JSON.stringify({...pointer,semanticHash:legacyHash,
    semanticVersion:undefined}));
  const beforeStored=f.store.get(pointer.objectKey);
  currentHashes="B";
  const second=await finish(f,MON_SLOT);
  const next=JSON.parse(f.store.get(key));
  const receipt=JSON.parse(f.store.get(next.receiptKey));
  assert.equal(receipt.status,"unchanged",
    "V1 vs V2 hashes must not cause a false changed");
  assert.equal(next.semanticVersion,2);
  assert.equal(next.objectKey,pointer.objectKey);
  assert.equal(f.store.get(pointer.objectKey),beforeStored,
    "migration does not rewrite prior immutable archives");
  assert.ok(second.status.unchanged>=1);
});

test("unknown metadata and actual data modifications remain detectable",async()=>{
  let power=20,perTotal=1;
  const f=fixture({api:()=>Response.json({data:{id:"MSF",power},
    meta:{asOf:"2026-11-04T00:00:00Z",perTotal,hashes:{all:"global"}}})});
  await f.seed();
  const first=await finish(f);
  const path="/game/v1/languages?page=1&perPage=100";
  const key=DIFF+"latest/"+sha(path)+".json";
  const previous=JSON.parse(f.store.get(key));
  perTotal=2;
  const second=await finish(f,MON_SLOT);
  const withMeta=JSON.parse(f.store.get(key));
  assert.notEqual(withMeta.objectKey,previous.objectKey);
  assert.equal(JSON.parse(f.store.get(withMeta.receiptKey)).status,"changed",
    "perTotal is route-specific metadata, unlike global hashes");
  power=21;
  const third=await finish(f,THU_SLOT);
  const withData=JSON.parse(f.store.get(key));
  assert.notEqual(withData.objectKey,withMeta.objectKey);
  assert.equal(JSON.parse(f.store.get(withData.receiptKey)).status,"changed");
  assert.ok(third.status.changed>=1);
});


test("French event page is queued only by the existing scheduled differential",async()=>{
  const f=fixture();await f.seed();
  const {status,ts}=await finish(f);
  assert.equal(status.status,"completed");
  const path="/game/v1/events?page=1&perPage=100&lang=fr";
  const url="https://api.marvelstrikeforce.com"+path;
  assert.ok(f.calls.some(call=>call.url===url));
  assert.ok(f.store.has("game-archive/v1/diff/latest/"+
    sha(path)+".json"));
  const before=f.calls.filter(call=>call.url===url).length;
  const state=await runGameDifferentialTick(f.env,f.provider,ts+3600000);
  assert.equal(state.status,"completed");
  assert.equal(f.calls.filter(call=>call.url===url).length,before,
    "No extra /game fetch between scheduled runs");
});



test("Monday 01:00 and Thursday 13:00 use Paris time through DST",()=>{
  const slot=x=>gameScheduledSlot(Date.parse(x));
  assert.equal(slot("2026-10-18T22:59:00Z"),null);
  assert.equal(slot("2026-10-18T23:00:00Z"),"2026-10-19T01:00");
  assert.equal(slot("2026-10-22T11:00:00Z"),"2026-10-22T13:00");
  assert.equal(slot("2026-10-23T00:00:00Z"),null,"Friday no longer starts a campaign");
  assert.equal(slot("2026-10-25T23:59:00Z"),null);
  assert.equal(slot("2026-10-26T00:00:00Z"),"2026-10-26T01:00");
  assert.equal(slot("2026-10-29T12:00:00Z"),"2026-10-29T13:00");
  assert.equal(nextGameScheduledAt(Date.parse("2026-10-23T00:00:00Z")),
    "2026-10-26T00:00:00.000Z");
  assert.equal(nextGameScheduledAt(MON_SLOT),"2026-10-29T12:00:00.000Z");
  assert.equal(nextGameScheduledAt(THU_SLOT),"2026-11-02T00:00:00.000Z");
});
test("two fixed slots replace weekly + Friday triggers without duplicates",async()=>{
  const f=fixture();await f.seed();
  const first=await finish(f);
  assert.equal(first.status.status,"completed");
  assert.equal(first.status.intervalHours,84);
  assert.equal(first.status.scheduleTrigger,"initial");
  const before=f.calls.length;
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT-60000)).status,
    "completed");
  assert.equal(f.calls.length,before);
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT)).status,
    "scanning");
  let state=JSON.parse(f.store.get(DIFF+"state.json"));
  assert.equal(state.scheduleTrigger,"scheduled");
  assert.equal(state.scheduledSlot,"2026-10-26T01:00");
  const monday=await finish(f,MON_SLOT+60000);
  assert.equal(monday.status.status,"completed");
  const completedCalls=f.calls.length;
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT+59*60000))
    .status,"completed");
  assert.equal(f.calls.length,completedCalls,"once per Monday slot");
  assert.equal((await runGameDifferentialTick(f.env,f.provider,THU_SLOT)).status,
    "scanning","Thursday starts without a seven-day wait");
  state=JSON.parse(f.store.get(DIFF+"state.json"));
  assert.equal(state.scheduledSlot,"2026-10-29T13:00");
  assert.equal((await finish(f,THU_SLOT+60000)).status.status,"completed");
  const beforeFriday=f.calls.length;
  assert.equal((await runGameDifferentialTick(f.env,f.provider,
    Date.parse("2026-10-30T00:00:00Z"))).status,"completed");
  assert.equal(f.calls.length,beforeFriday,"no legacy Friday trigger");
});
test("in-progress campaign consumes an overlapping slot",async()=>{
  const f=fixture();await f.seed();
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT-60000))
    .status,"scanning");
  const id=JSON.parse(f.store.get(DIFF+"state.json")).runId;
  const during=await runGameDifferentialTick(f.env,f.provider,MON_SLOT);
  assert.ok(["scanning","checking"].includes(during.status));
  const active=JSON.parse(f.store.get(DIFF+"state.json"));
  assert.equal(active.runId,id);
  assert.equal(active.scheduledSlot,"2026-10-26T01:00");
  assert.equal((await finish(f,MON_SLOT+60000)).status.status,"completed");
  const before=f.calls.length;
  await runGameDifferentialTick(f.env,f.provider,MON_SLOT+59*60000);
  assert.equal(JSON.parse(f.store.get(DIFF+"state.json")).runId,id);
  assert.equal(f.calls.length,before,"never restart after finishing in slot");
});
test("legacy weekly state migrates without resetting source archive",async()=>{
  const f=fixture();await f.seed();
  await finish(f);
  const key=DIFF+"state.json";
  const old=JSON.parse(f.store.get(key));
  delete old.scheduledSlot;
  old.weeklyCompletedAt=old.completedAt;old.fridaySlot="2026-10-23";
  f.store.set(key,JSON.stringify(old));
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT-60000))
    .status,"completed");
  assert.equal(JSON.parse(f.store.get(key)).runId,old.runId);
  assert.equal((await runGameDifferentialTick(f.env,f.provider,MON_SLOT))
    .status,"scanning");
  const updated=JSON.parse(f.store.get(key));
  assert.notEqual(updated.runId,old.runId);
  assert.equal(updated.scheduledSlot,"2026-10-26T01:00");
  assert.equal(updated.sourceRun,old.sourceRun);
});
