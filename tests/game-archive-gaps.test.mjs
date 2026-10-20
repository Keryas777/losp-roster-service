import {test} from "node:test";
import assert from "node:assert/strict";
import {handleGameArchiveGapAudit} from "../src/game-archive-gaps.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const base="https://losp-roster-service.deliriousfan7.workers.dev";
const endpoint=base+"/admin/api/game-archive-gaps";
const id="11111111-2222-4333-8444-555555555555";
function fixture(gaps,overrides={}){
  const store=new Map(),calls=[];
  const active=GAME_ARCHIVE_ROOT+"active.json";
  store.set(active,JSON.stringify({version:1,runId:id}));
  store.set(GAME_ARCHIVE_ROOT+"runs/"+id+"/progress.json",
    JSON.stringify({runId:id,version:1,status:"running",
      completedOffset:500,cursor:130,count:2070,gaps}));
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      return store.has(key)?{text:async()=>store.get(key)}:null;
    },
    put:async()=>{throw Error("audit must never write")},
    list:async()=>{throw Error("audit must not scan unrelated R2 prefixes")}
  };
  return {env:{CAPTAIN_BUCKET:bucket,...overrides},store,calls};
}
const get=async(f,query="")=>(await handleGameArchiveGapAudit(
  new Request(endpoint+query),f.env)).json();

test("audit aggregates active R2 gaps with no Scopely GET, R2 writes or secret leakage",async()=>{
  const gaps=[
    {path:"/game/v1/upgradeData",status:472,
      reason:"unpageable-root-detail-fallback"},
    {path:"/game/v1/items/OrbOne",status:404},
    {path:"/game/v1/items/OrbOne",status:404,
      reason:"retry-exhausted",attempts:16,outcome:"http-503"},
    {path:"/game/v1/raids/RaidOne",reason:"archived-but-unindexed",
      objectKey:"private/r2/path"},
    {path:"/game/v1/events",reason:"undiscoverable-detail-id",count:2},
    {path:"/game/v1/characters/Phoenix",status:403},
    {path:"/game/v1/analysis/teamOrder/war",status:422}
  ];
  const f=fixture(gaps);
  const data=await get(f);
  assert.equal(data.status,"running");
  assert.equal(data.total,7);
  assert.equal(data.distinctPaths,6);
  assert.equal(data.tasksProcessed,630);
  assert.equal(data.archivedResponses,2070);
  assert.equal(data.matching,7);
  assert.equal(data.entries.length,7);
  assert.deepEqual(data.byHttpStatus.find(x=>x.value==="404"),
    {value:"404",count:2});
  assert.deepEqual(data.byCategory.find(x=>x.value==="alternative-partielle"),
    {value:"alternative-partielle",count:1});
  assert.deepEqual(data.byFamily.find(x=>x.value==="analysis/teamOrder"),
    {value:"analysis/teamOrder",count:1});
  assert.equal(data.entries.find(x=>x.reason==="undiscoverable-detail-id").affectedCount,2);
  assert.equal(data.entries.find(x=>x.reason==="retry-exhausted").attempts,16);
  assert.deepEqual(f.calls.map(x=>x[0]),["get","get"]);
  assert.ok(!JSON.stringify(data).includes("private/r2/path"));
  assert.ok(!JSON.stringify(data).includes("outcome"));
  assert.ok(data.note.includes("résolution actuelle"));
});
test("filters and pagination operate on recorded entries, not provider requests",async()=>{
  const gaps=Array.from({length:125},(_,i)=>({
    path:"/game/v1/items/Item"+i,status:i%2?404:472,
    reason:i%2?"undiscoverable-detail-id":"provider-472-not-pageable"
  }));
  const f=fixture(gaps);
  const first=await get(f,"?limit=20&offset=0&family=items");
  assert.equal(first.total,125);
  assert.equal(first.matching,125);
  assert.equal(first.entries.length,20);
  assert.equal(first.nextOffset,20);
  assert.equal(first.entries[0].path,"/game/v1/items/Item124");
  const second=await get(f,"?limit=20&offset=20&cause=undiscoverable-detail-id");
  assert.equal(second.matching,62);
  assert.equal(second.entries.length,20);
  assert.equal(second.nextOffset,40);
  const last=await get(f,"?limit=25&offset=60&cause=undiscoverable-detail-id");
  assert.equal(last.entries.length,2);
  assert.equal(last.nextOffset,null);
  assert.equal(f.calls.length,6);
});
test("untrusted or corrupt R2 path cannot leak secrets or expand unrelated R2 prefixes",async()=>{
  const f=fixture([
    {path:"/player/v1/card?accessToken=secret",reason:"retry-exhausted",
      objectKey:"oauth-captains/v1/private"},
    {path:"/game/v1/characters/ok",status:404},
    {path:42,reason:"invalid\\\nreason"}
  ]);
  const data=await get(f);
  assert.equal(data.total,3);
  assert.equal(data.entries.filter(x=>x.path===null).length,2);
  assert.ok(!JSON.stringify(data).includes("accessToken"));
  assert.ok(!JSON.stringify(data).includes("oauth-captains"));
  assert.equal(data.byFamily.find(x=>x.value==="inconnue").count,2);
  assert.equal((await handleGameArchiveGapAudit(new Request(endpoint+
    "?limit=9999"),f.env)).status,400);
  assert.equal((await handleGameArchiveGapAudit(new Request(endpoint+
    "?family=../player"),f.env)).status,400);
  assert.equal(f.calls.length,2);
});
test("an empty archive does not invent missing or complete data",async()=>{
  const f=fixture([]);
  f.store.delete(GAME_ARCHIVE_ROOT+"active.json");
  const result=await get(f);
  assert.equal(result.status,"not-started");
  assert.equal(result.total,0);
  assert.deepEqual(result.entries,[]);
});
test("R2 failures remain visible and do not silently return zero gaps",async()=>{
  const f=fixture([]);
  f.store.delete(GAME_ARCHIVE_ROOT+"runs/"+id+"/progress.json");
  const result=await handleGameArchiveGapAudit(new Request(endpoint),f.env);
  assert.equal(result.status,503);
  assert.equal((await result.json()).error,"missing-progress");
});
test("only the Cloudflare Access-protected admin handler exposes diagnostics",async()=>{
  const f=fixture([{path:"/game/v1/items/ItemA",status:472}]);
  const guarded={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const forbidden=await handleAdmin(new Request(endpoint),guarded);
  assert.equal(forbidden.status,403);
  assert.equal(f.calls.length,0);
});
