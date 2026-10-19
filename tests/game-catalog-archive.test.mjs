import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ROOTS,GAME_ARCHIVE_ROOT,GAME_ARCHIVE_DAILY_LIMIT,
  GAME_ARCHIVE_TICK_LIMIT,handleGameArchiveAdmin,runGameArchiveTick,
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
  assert.equal(result.processed,3);
  assert.match(gameCalls(f)[0].address,/perPage=100/);
  assert.match(gameCalls(f)[1].address,/perPage=50/);
  assert.equal((await gameArchiveStatus(f.env,now)).archivedResponses,2);
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
  assert.equal(t.processed,3);
  assert.ok(!JSON.stringify(t).includes("SERVER_ONLY_TOKEN"));
});
