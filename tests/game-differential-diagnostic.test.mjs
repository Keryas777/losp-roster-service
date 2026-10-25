import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {handleGameDifferentialFailureDiagnostic} from "../src/game-differential-diagnostic.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=HOST+"/admin/api/game-differential-failures";
const ROOT=GAME_ARCHIVE_ROOT+"diff/";
const RUN="11111111-2222-4333-8444-555555555555";
function fixture(records=[],stateOverrides={}){
  const store=new Map(),calls=[];
  store.set(ROOT+"state.json",JSON.stringify({
    runId:RUN,status:"checking",checked:9635,failed:1340,
    recoveryBackfill:{cursor:1800,end:2576},...stateOverrides
  }));
  for(const [i,record] of records.entries())
    store.set(ROOT+"recovery/pending/"+i.toString(16).padStart(64,"0")+".json",
      JSON.stringify(record));
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      return store.has(key)?{text:async()=>store.get(key)}:null;
    },
    list:async({prefix,limit,cursor})=>{
      calls.push(["list",prefix,limit,cursor]);
      assert.equal(prefix,ROOT+"recovery/pending/");
      assert.equal(limit,40);
      const keys=[...store.keys()].filter(k=>k.startsWith(prefix)).sort();
      const from=cursor?Number(cursor):0,ends=Math.min(from+limit,keys.length);
      return {objects:keys.slice(from,ends).map(key=>({key})),
        truncated:ends<keys.length,cursor:ends<keys.length?String(ends):undefined};
    },
    put:async()=>{throw Error("diagnostic must never write R2");}
  };
  return {env:{CAPTAIN_BUCKET:bucket},store,calls};
}
const row=(path,reason,status="pending",options={})=>({
  version:1,path,reason,status,attempts:1,
  lastRun:RUN,lastSeenAt:"2026-10-25T20:00:00Z",
  nextAt:"2026-11-01T20:00:00Z",...options
});
const request=(f,query="")=>handleGameDifferentialFailureDiagnostic(
  new Request(ENDPOINT+query),f.env);

test("R2-only diagnostic distinguishes pending, exhausted, resolved and partial variant success",async()=>{
  const f=fixture([
    row("/game/v1/characters/Foo","http-472","pending",{
      attempts:3,recoveredParts:[
        "/game/v1/characters/Foo?abilityKits=basic",
        "/game/v1/characters/Foo?abilityKits=basic",
        "/game/v1/characters/Foo?abilityKits=passive"
      ]}),
    row("/game/v1/upgradeData","http-503"),
    row("/game/v1/traits","network-error","resolved",{
      resolvedAt:"2026-10-25T21:00:00Z"}),
    row("/game/v1/items/Some","http-404")
  ]);
  const response=await request(f);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.status,"ok");
  assert.equal(result.entries.length,4);
  assert.equal(result.checkpoint.failed,1340);
  assert.equal(result.checkpoint.backfillScanned,1800);
  assert.equal(result.checkpoint.backfillTotal,2576);
  const first=result.entries.find(x=>x.path==="/game/v1/characters/Foo");
  assert.equal(first.group,"http-472");
  assert.equal(first.recoveredVariants,2);
  assert.equal(first.status,"pending");
  assert.equal(first.exhausted,true);
  assert.equal(result.entries.find(x=>x.status==="resolved").exhausted,false);
  assert.equal(result.entries.find(x=>x.reason==="http-503").group,"http-5xx");
  assert.equal(result.entries.find(x=>x.reason==="http-404").group,"http-4xx");
  assert.equal(result.nextCursor,null);
  assert.equal(f.calls.filter(x=>x[0]==="get").length,5);
  assert.equal(f.calls.filter(x=>x[0]==="list").length,1);
  assert.ok(!JSON.stringify(result).includes("privateBucket"));
});

test("large registries are paginated at exactly 40 R2 items, with strict cursors",async()=>{
  const entries=Array.from({length:91},(_,i)=>
    row("/game/v1/items/Item"+i,i%2?"http-472":"http-404"));
  const f=fixture(entries);
  const first=await (await request(f)).json();
  assert.equal(first.entries.length,40);
  assert.equal(first.nextCursor,"40");
  const second=await (await request(f,"?cursor="+first.nextCursor)).json();
  assert.equal(second.entries.length,40);
  assert.equal(second.nextCursor,"80");
  const third=await (await request(f,"?cursor="+second.nextCursor)).json();
  assert.equal(third.entries.length,11);
  assert.equal(third.nextCursor,null);
  const unique=new Set([...first.entries,...second.entries,...third.entries]
    .map(x=>x.path));
  assert.equal(unique.size,91);
  assert.equal((await request(f,"?cursor=../sessions")).status,400);
  assert.equal((await request(f,"?cursor="+("a".repeat(2050)))).status,400);
  assert.equal(f.calls.filter(x=>x[0]==="list").length,3);
});

test("invalid records are flagged rather than invented as recoveries",async()=>{
  const f=fixture([
    {path:"/player/v1/card?accessToken=secret",status:"resolved"},
    {path:"/game/v1/characters/Foo",status:"resolved",
      recoveredParts:["/player/v1/secret","/game/v1/characters/Foo?mode=basic"],
      objectKey:"privateBucket/secret"},
    {path:"/game/v1/items/Bar",status:"pending",
      attempts:3,reason:"http-472",recoveredParts:[]}
  ]);
  const result=await (await request(f)).json();
  assert.equal(result.rejected,1);
  assert.equal(result.entries.length,2);
  assert.ok(!JSON.stringify(result).includes("accessToken"));
  assert.ok(!JSON.stringify(result).includes("privateBucket"));
  assert.equal(result.entries.find(x=>x.status==="resolved").recoveredVariants,1);
  assert.equal(result.entries.find(x=>x.status==="pending").exhausted,true);
});

test("R2 read errors never look like an empty, successful audit",async()=>{
  const f=fixture([row("/game/v1/languages","http-472")]);
  f.env.CAPTAIN_BUCKET.get=async()=>{throw Error("R2 inaccessible");};
  const response=await request(f);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,"diagnostic-r2-unavailable");
});

test("new diagnostic remains behind Cloudflare Access, without reading R2 on unauthorized calls",async()=>{
  const f=fixture([row("/game/v1/languages","http-472")]);
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const response=await handleAdmin(new Request(ENDPOINT),env);
  assert.equal(response.status,403);
  assert.equal(f.calls.length,0);
});

test("diagnostic UI is manual, on Archives R2, and avoids unsafe HTML",async()=>{
  const html=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const nav=await readFile(new URL("../public/admin-navigation.js",import.meta.url),"utf8");
  const ui=await readFile(new URL(
    "../public/admin-game-differential-diagnostic.js",import.meta.url),"utf8");
  assert.match(html,/game-diff-diagnostic-refresh/);
  assert.match(html,/admin-game-differential-diagnostic\.js/);
  assert.match(html,/admin\/api\/game-differential-failures/);
  assert.match(nav,/archives[\s\S]*game-diff-diagnostic-refresh/);
  assert.match(ui,/run\.addEventListener\("click"/);
  assert.doesNotMatch(ui,/void load\(\);/);
  assert.doesNotMatch(ui,/\.innerHTML\s*=/);
  assert.match(ui,/nextCursor/);
  assert.doesNotMatch(ui,/\/game\/v1\/.*fetch/);
});
