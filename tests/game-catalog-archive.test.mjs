import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ROOTS,GAME_ARCHIVE_ROOT,GAME_ARCHIVE_DAILY_LIMIT,
  GAME_ARCHIVE_CRON,GAME_ARCHIVE_TICK_LIMIT,handleGameArchiveAdmin,runGameArchiveTick,
  gameArchiveStatus,startGameArchive} from "../src/game-catalog-archive.js";

const base="https://losp-roster-service.deliriousfan7.workers.dev";
const url=base+"/admin/api/game-archive";
const now=Date.UTC(2026,9,19,12);
const req=(action,origin=base)=>new Request(url,{
  method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
  body:JSON.stringify({action})
});
function fixture(overrides={}){
  const store=new Map(),calls=[];
  const locks=new Map(),storage=new Map();
  const env={
    GAME_ARCHIVE_AUTO_ENABLED:"true",
    SCOPELY_CLIENT_ID:"client-for-test",
    SCOPELY_CLIENT_SECRET:"secret-for-test",
    CAPTAIN_BUCKET:{
      get:async key=>store.has(key)?{
        text:async()=>store.get(key),arrayBuffer:async()=>new TextEncoder().encode(store.get(key)).buffer
      }:null,
      put:async(key,v)=>store.set(key,typeof v==="string"?v:new TextDecoder().decode(v))
    },
    ROSTER_BATCH_LOCK:{
      idFromName:id=>id,
      get:id=>{
        if(!locks.has(id))locks.set(id,new RosterBatchLock({
          storage:{
            get:async k=>storage.get(k),
            put:async(k,v)=>storage.set(k,v),
            delete:async k=>storage.delete(k)
          }
        }));
        return {fetch:request=>locks.get(id).fetch(request)};
      }
    }
  };
  const provider=async(address,opts)=>{
    calls.push({address,opts});
    if(address.endsWith("/oauth2/token")){
      assert.equal(opts.method,"POST");
      assert.equal(opts.body,"grant_type=client_credentials");
      assert.match(opts.headers.Authorization,/^Basic /);
      return Response.json({access_token:"SERVER_ONLY_TOKEN",token_type:"Bearer",expires_in:300});
    }
    assert.equal(opts.method,"GET");
    assert.match(address,/^https:\/\/api\.marvelstrikeforce\.com\/game\/v1\//);
    assert.equal(opts.headers.Authorization,"Bearer SERVER_ONLY_TOKEN");
    assert.ok(opts.headers["x-api-key"]);
    return overrides.api?overrides.api(address,opts,calls):
      Response.json({data:[],meta:{perTotal:0}});
  };
  return {env,provider,store,calls};
}
const gameCalls=f=>f.calls.filter(x=>x.address.includes("/game/v1/"));

test("17 official game GET collections are allowlisted and no player path is accepted",()=>{
  assert.equal(GAME_ROOTS.length,17);
  assert.ok(GAME_ROOTS.every(x=>x.path.startsWith("/game/v1/")));
  assert.equal(new Set(GAME_ROOTS.map(x=>x.path)).size,GAME_ROOTS.length);
  assert.ok(GAME_ROOTS.some(x=>x.id==="characters"&&x.detail.includes("{id}")));
  assert.ok(!GAME_ROOTS.some(x=>x.path.includes("player/")));
});
test("one admin start + ticks create a finite private completed catalog without publishing",async()=>{
  const f=fixture();
  assert.equal((await startGameArchive(f.env,now)).status,"started");
  assert.equal((await startGameArchive(f.env,now)).status,"already-running");
  for(let i=0;i<8;i++){
    const result=await runGameArchiveTick(f.env,f.provider,now+600000*i);
    assert.ok(result.processed<=GAME_ARCHIVE_TICK_LIMIT);
    if(result.status==="completed")break;
  }
  const status=await gameArchiveStatus(f.env,now);
  assert.equal(status.status,"completed");
  assert.equal(status.totalTasks,17);
  assert.equal(status.cursor,17);
  assert.equal(status.archivedResponses,17);
  assert.equal(status.gapCount,0);
  assert.equal(status.requestsToday,17);
  assert.equal(gameCalls(f).length,17);
  assert.ok([...f.store.keys()].some(k=>k.startsWith(GAME_ARCHIVE_ROOT+"runs/")&&k.includes("/receipts/")));
  assert.ok([...f.store.keys()].some(k=>k.startsWith(GAME_ARCHIVE_ROOT+"runs/")&&k.includes("/objects/")));
  assert.ok(![...f.store.keys()].some(k=>k.startsWith("roster-batches/")));
  assert.ok(!JSON.stringify(status).includes("SERVER_ONLY_TOKEN"));
});
test("localization string IDs are discovered and fetch full detail after roots",async()=>{
  const f=fixture({api:address=>address.includes("/localizations?")?
    Response.json({data:["heroes"],meta:{perTotal:1}}):
    address.includes("/localizations/heroes")?
      Response.json({data:{en:"https://example.invalid/file.csv"},meta:{asOf:"v1"}}):
      Response.json({data:[],meta:{perTotal:0}})});
  await startGameArchive(f.env,now);
  for(let i=0;i<8;i++)await runGameArchiveTick(f.env,f.provider,now+100000*i);
  const status=await gameArchiveStatus(f.env,now);
  assert.equal(status.status,"completed");
  assert.equal(status.totalTasks,18);
  assert.ok(gameCalls(f).some(c=>c.address.endsWith("/game/v1/localizations/heroes")));
  const active=JSON.parse(f.store.get(GAME_ARCHIVE_ROOT+"active.json"));
  const prefix=GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/";
  const state=JSON.parse(f.store.get(prefix+"progress.json"));
  assert.equal(state.cursor,state.tasks.length);
});
test("a provider 472 retries same list with smaller page size without declaring false completeness",async()=>{
  const f=fixture({api:address=>{
    const u=new URL(address);
    if(u.pathname==="/game/v1/languages"&&u.searchParams.get("perPage")==="100")
      return new Response("huge",{status:472});
    return Response.json({data:[],meta:{perTotal:0}});
  }});
  await startGameArchive(f.env,now);
  const result=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(result.status,"running");
  assert.equal(result.processed,GAME_ARCHIVE_TICK_LIMIT);
  assert.match(gameCalls(f)[0].address,/perPage=100/);
  assert.match(gameCalls(f)[1].address,/perPage=50/);
  assert.equal((await gameArchiveStatus(f.env,now)).archivedResponses,GAME_ARCHIVE_TICK_LIMIT-1);
});
test("rate limit pauses run without retry loop and preserves resumability",async()=>{
  const f=fixture({api:()=>new Response("rate limit",{status:429})});
  await startGameArchive(f.env,now);
  const first=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(first.lastOutcome,"rate-limited");
  assert.equal(gameCalls(f).length,1);
  const retry=await runGameArchiveTick(f.env,f.provider,now+60000);
  assert.equal(retry.status,"cooldown");
  assert.equal(gameCalls(f).length,1);
});
test("missing detail becomes explicit completed-with-gaps, not silent success",async()=>{
  const f=fixture({api:address=>address.includes("/characters?")?
    Response.json({data:[{id:"Hero01"}],meta:{perTotal:1}}):
    address.endsWith("/game/v1/characters/Hero01")?
      new Response("gone",{status:404}):
      Response.json({data:[],meta:{perTotal:0}})});
  await startGameArchive(f.env,now);
  for(let i=0;i<8;i++)await runGameArchiveTick(f.env,f.provider,now+i*60000);
  const status=await gameArchiveStatus(f.env,now);
  assert.equal(status.status,"completed-with-gaps");
  assert.equal(status.gapCount,1);
  assert.equal(status.totalTasks,18);
});
test("no credentials or ungranted client-credentials OAuth never uses player tokens",async()=>{
  const f=fixture();
  f.env.SCOPELY_CLIENT_SECRET=undefined;
  await startGameArchive(f.env,now);
  const res=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(res.status,"app-oauth-unavailable");
  assert.equal(gameCalls(f).length,0);
  assert.equal(f.calls.length,0);
});
test("isolated game daily cap protects API independently from roster service",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const budget=GAME_ARCHIVE_ROOT+"budget/2026-10-19.json";
  f.store.set(budget,JSON.stringify({date:"2026-10-19",used:GAME_ARCHIVE_DAILY_LIMIT}));
  const result=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(result.status,"daily-limit");
  assert.equal(f.calls.length,0);
});
test("admin API rejects forged origin, unexpected action and missing Access authentication",async()=>{
  const f=fixture();
  assert.equal((await handleGameArchiveAdmin(req("start","https://evil.invalid"),f.env,f.provider,now)).status,403);
  assert.equal((await handleGameArchiveAdmin(req("delete"),f.env,f.provider,now)).status,400);
  assert.equal(f.store.size,0);
  const auth={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"test.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const denied=await handleAdmin(req("start"),auth,f.provider);
  assert.equal(denied.status,403);
  assert.equal(f.store.size,0);
});
test("admin read and write status routes return only bounded aggregate fields",async()=>{
  const f=fixture();
  assert.equal((await handleGameArchiveAdmin(new Request(url),f.env,f.provider,now)).status,200);
  const s=await (await handleGameArchiveAdmin(req("start"),f.env,f.provider,now)).json();
  assert.equal(s.status,"started");
  const t=await (await handleGameArchiveAdmin(req("tick"),f.env,f.provider,now)).json();
  assert.equal(t.processed,GAME_ARCHIVE_TICK_LIMIT);
  assert.ok(!JSON.stringify(t).includes("SERVER_ONLY_TOKEN"));
});
test("documented object-map details for upgrades, ISO-8 and team order are discovered",async()=>{
  const expected={
    "/game/v1/upgradeData":"playerLevelTotalXp",
    "/game/v1/iso8Abilities":"striker",
    "/game/v1/analysis/teamOrder":"roster"
  };
  const f=fixture({api:address=>{
    const pathname=new URL(address).pathname;
    if(expected[pathname])return Response.json({
      data:{[expected[pathname]]:{any:"field"}},meta:{}
    });
    return Response.json({data:[],meta:{perTotal:0}});
  }});
  await startGameArchive(f.env,now);
  for(let i=0;i<6;i++)await runGameArchiveTick(f.env,f.provider,now+60000*i);
  const paths=gameCalls(f).map(x=>new URL(x.address).pathname);
  assert.ok(paths.includes("/game/v1/upgradeData/playerLevelTotalXp"));
  assert.ok(paths.includes("/game/v1/iso8Abilities/striker"));
  assert.ok(paths.includes("/game/v1/analysis/teamOrder/roster"));
  assert.equal((await gameArchiveStatus(f.env,now)).totalTasks,41);
});

test("one-minute production schedule is used without touching existing roster cron triggers",async()=>{
  const wrangler=JSON.parse(await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
  const schedule=wrangler.triggers.crons;
  assert.equal(GAME_ARCHIVE_CRON,"* * * * *");
  assert.ok(schedule.includes(GAME_ARCHIVE_CRON));
  assert.ok(!schedule.includes("*/15 * * * *"));
  assert.ok(schedule.includes("* 2-3,14-15 * * *"));
  assert.ok(schedule.includes("15 3 * * *"));
  assert.ok(schedule.includes("15 * * * *"));
  assert.equal(new Set(schedule).size,schedule.length);
  assert.equal(GAME_ARCHIVE_TICK_LIMIT,12);
  assert.equal(GAME_ARCHIVE_DAILY_LIMIT,9000);
  assert.ok(GAME_ARCHIVE_DAILY_LIMIT>GAME_ARCHIVE_TICK_LIMIT);
  assert.equal(wrangler.vars.ROSTER_AUTO_ENABLED,"true");
});

test("an existing R2 campaign proceeds immediately beyond former 600/day cap",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const key=GAME_ARCHIVE_ROOT+"budget/2026-10-19.json";
  f.store.set(key,JSON.stringify({date:"2026-10-19",used:600}));
  const first=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(first.status,"running");
  assert.equal(first.processed,GAME_ARCHIVE_TICK_LIMIT);
  assert.equal(first.requestsToday,612);
  const status=await gameArchiveStatus(f.env,now);
  assert.equal(status.cursor,12);
  assert.equal(status.archivedResponses,12);
  const next=await runGameArchiveTick(f.env,f.provider,now+60_000);
  assert.equal(next.processed,5);
  assert.equal(next.requestsToday,617);
  assert.equal((await gameArchiveStatus(f.env,now)).cursor,17);
  assert.equal(gameCalls(f).length,17);
});

test("the game collector still blocks a true 9000 daily overflow without OAuth",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const key=GAME_ARCHIVE_ROOT+"budget/2026-10-19.json";
  f.store.set(key,JSON.stringify({date:"2026-10-19",used:GAME_ARCHIVE_DAILY_LIMIT}));
  const outcome=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(outcome.status,"daily-limit");
  assert.equal(gameCalls(f).length,0);
  assert.equal(f.calls.length,0);
});

test("same Worker isolate can reuse app OAuth token for minute-spaced game ticks",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  await runGameArchiveTick(f.env,f.provider,now);
  await runGameArchiveTick(f.env,f.provider,now+60_000);
  assert.equal(gameCalls(f).length,17);
  assert.equal(f.calls.filter(c=>c.address.endsWith("/oauth2/token")).length,1);
  // The faster run has already finished; do not refresh an unused token.
  await runGameArchiveTick(f.env,f.provider,now+250_000);
  assert.equal(f.calls.filter(c=>c.address.endsWith("/oauth2/token")).length,1);
  assert.equal(gameCalls(f).length,17);
  assert.equal((await gameArchiveStatus(f.env,now)).status,"completed");
});

test("completed game campaign performs no more Scopely GET or OAuth despite cron ticks",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  for(let i=0;i<3;i++)await runGameArchiveTick(f.env,f.provider,now+i*60_000);
  assert.equal((await gameArchiveStatus(f.env,now)).status,"completed");
  const count=f.calls.length;
  for(let i=3;i<60;i++){
    const r=await runGameArchiveTick(f.env,f.provider,now+i*60_000);
    assert.equal(r.status,"completed");
  }
  assert.equal(f.calls.length,count);
});

test("429 does not get accelerated by a one-minute cron",async()=>{
  const f=fixture({api:()=>new Response("busy",{status:429})});
  await startGameArchive(f.env,now);
  const first=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(first.lastOutcome,"rate-limited");
  assert.equal(gameCalls(f).length,1);
  for(let minute=1;minute<=59;minute++){
    const r=await runGameArchiveTick(f.env,f.provider,now+minute*60_000);
    assert.equal(r.status,"cooldown");
  }
  assert.equal(gameCalls(f).length,1);
});

test("legacy R2 upgradeData HTTP 472 at perPage=1 falls back to all documented fields",async()=>{
  const f=fixture({api:address=>{
    const u=new URL(address);
    if(u.pathname==="/game/v1/upgradeData"){
      assert.equal(u.searchParams.has("page"),false);
      assert.equal(u.searchParams.has("perPage"),false);
      return new Response("large",{status:472});
    }
    return Response.json({data:[],meta:{perTotal:0}});
  }});
  await startGameArchive(f.env,now);
  const active=JSON.parse(f.store.get(GAME_ARCHIVE_ROOT+"active.json"));
  const key=GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json";
  const state=JSON.parse(f.store.get(key));
  state.cursor=3;
  state.tasks[3].perPage=1;
  state.tasks[3].retries=6;
  state.pauseUntil=new Date(now-1000).toISOString();
  state.lastOutcome="http-472-minimum-page";
  f.store.set(key,JSON.stringify(state));
  const first=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(first.status,"running");
  assert.equal(first.completedTasks,15);
  assert.equal(first.totalTasks,29);
  const saved=JSON.parse(f.store.get(key));
  assert.equal(saved.gaps.length,1);
  assert.equal(saved.gaps[0].reason,"unpageable-root-detail-fallback");
  assert.equal(saved.tasks.filter(t=>t.path.startsWith("/game/v1/upgradeData/")).length,12);
  for(let i=1;i<12;i++){
    const r=await runGameArchiveTick(f.env,f.provider,now+i*60_000);
    if(r.status==="completed-with-gaps")break;
  }
  const end=await gameArchiveStatus(f.env,now+12*60_000);
  assert.equal(end.status,"completed-with-gaps");
  assert.equal(end.cursor,29);
  assert.equal(end.gapCount,1);
  assert.equal(JSON.parse(f.store.get(GAME_ARCHIVE_ROOT+"active.json")).runId,active.runId);
  assert.ok(gameCalls(f).some(c=>c.address.includes("/game/v1/upgradeData/playerLevelTotalXp")));
});
test("documented non-pageable game roots do not receive unsupported pagination",async()=>{
  const f=fixture({api:address=>{
    const u=new URL(address);
    if(["decorations","upgradeData","iso8Abilities","analysis/teamOrder"]
      .some(root=>u.pathname==="/game/v1/"+root)){
      assert.equal(u.searchParams.has("page"),false);
      assert.equal(u.searchParams.has("perPage"),false);
    }
    return Response.json({data:[],meta:{perTotal:0}});
  }});
  await startGameArchive(f.env,now);
  for(let i=0;i<3;i++)await runGameArchiveTick(f.env,f.provider,now+i*60_000);
  assert.equal((await gameArchiveStatus(f.env,now)).status,"completed");
});
