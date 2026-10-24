import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {runGameDifferentialTick,gameDifferentialStatus} from "../src/game-differential-sync.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";
import {handleAdmin} from "../src/admin-routes.js";

const NOW=Date.UTC(2026,9,23,0,0,0);
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
test("weekly /game comparison stores changed objects only, ignoring meta.asOf",async()=>{
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
  const second=await finish(f,first.ts+7*86400000+60000);
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

test("failed receipt write cannot publish latest or claim task completed",async()=>{
  const f=fixture();await f.seed();
  let injected=0;
  const bucket=f.env.CAPTAIN_BUCKET,originalPut=bucket.put.bind(bucket);
  bucket.put=async(key,value)=>{
    if(key.includes("/checks/")&&injected++===0)
      throw Error("simulated-receipt-write-failure");
    return originalPut(key,value);
  };
  for(let i=0;i<3;i++)await runGameDifferentialTick(f.env,f.provider,NOW+i*60000);
  const interrupted=await runGameDifferentialTick(f.env,f.provider,NOW+3*60000);
  assert.equal(interrupted.status,"unavailable");
  assert.equal(checks(f).length,0);
  assert.equal([...f.store.keys()].filter(k=>k.startsWith(DIFF+"latest/")).length,0);
  const resumed=await runGameDifferentialTick(f.env,f.provider,NOW+4*60000);
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
  for(let i=0;i<3;i++)await runGameDifferentialTick(f.env,f.provider,NOW+i*60000);
  const interrupted=await runGameDifferentialTick(f.env,f.provider,NOW+3*60000);
  assert.equal(interrupted.status,"unavailable");
  const journals=checks(f);
  assert.equal(journals.length,1);
  const receipt=JSON.parse(journals[0][1]);
  assert.ok(f.store.has(receipt.objectKey),"stored object already exists");
  assert.equal(latestFor(f,receipt.path),null,"no early published pointer");
  const gameUrl="https://api.marvelstrikeforce.com"+receipt.path;
  const counted=()=>f.calls.filter(x=>x.url===gameUrl).length;
  const before=counted();
  const resumed=await runGameDifferentialTick(f.env,f.provider,NOW+4*60000);
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
