import test from "node:test";
import assert from "node:assert/strict";
import {preserveStandingsHistory} from "../src/durable-alliance-standings.js";

function fixture(){
  const data=new Map();
  return {data,env:{CAPTAIN_BUCKET:{
    async get(key){const value=data.get(key);return value===undefined?null:
      {size:value.length,text:async()=>value};},
    async put(key,value){data.set(key,value);}
  }}};
}
test("preserves old days when new observations arrive",async()=>{
  const f=fixture();
  const old={capturedAt:"2026-01-01T03:15:00Z",alliances:[{warRank:4}]};
  const recent={capturedAt:"2026-11-08T15:15:00Z",alliances:[{warRank:2}]};
  assert.equal((await preserveStandingsHistory(f.env,"losp-season",[old])).status,"preserved");
  assert.equal((await preserveStandingsHistory(f.env,"losp-season",[recent])).status,"preserved");
  assert.equal(f.data.size,2);
  assert.ok(f.data.has("alliance-standings-history/v1/losp-season/2026-01-01.json"));
});
test("same observation is idempotent; corrections append instead of replacing",async()=>{
  const f=fixture(),key="alliance-standings-history/v1/trophies/2026-11-07.json";
  const a={collectionDayUtc:"2026-11-07",alliances:[{warTrophies:100}]};
  const b={collectionDayUtc:"2026-11-07",alliances:[{warTrophies:101}]};
  await preserveStandingsHistory(f.env,"trophies",[a,a]);
  await preserveStandingsHistory(f.env,"trophies",[b]);
  assert.deepEqual(JSON.parse(f.data.get(key)).observations,[a,b]);
});
test("invalid existing archive fails closed",async()=>{
  const f=fixture(),key="alliance-standings-history/v1/guest-season/2026-11-08.json";
  f.data.set(key,'{"version":9}');
  const result=await preserveStandingsHistory(f.env,"guest-season",[
    {capturedAt:"2026-11-08T03:15:00Z",alliances:[]}]);
  assert.equal(result.status,"archive-integrity-error");
  assert.equal(f.data.get(key),'{"version":9}');
});
