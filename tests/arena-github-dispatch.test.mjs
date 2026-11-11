import {test} from "node:test";
import assert from "node:assert/strict";
import {dispatchArenaPublication} from "../src/arena-github-dispatch.js";
function fixture(){
  const values=new Map(),puts=[];
  return {puts,env:{ROSTER_GITHUB_DISPATCH_TOKEN:"test-token",CAPTAIN_BUCKET:{
    get:async key=>values.has(key)?{text:async()=>values.get(key)}:null,
    put:async(key,value)=>{puts.push(key);values.set(key,value);}
  }}};
}
test("Arena GitHub dispatch retries temporary failures until the permanent file appears",async()=>{
  const f=fixture(),requests=[];
  const fail=await dispatchArenaPublication(f.env,"2026-11-11",async(url,options)=>{
    requests.push({url,options});return new Response(null,{status:503});
  },Date.parse("2026-11-11T16:15:00Z"));
  assert.equal(fail.status,"retry-pending");
  assert.equal(f.puts.length,0);
  const success=await dispatchArenaPublication(f.env,"2026-11-11",async(url,options)=>{
    requests.push({url,options});return new Response(null,{status:204});
  },Date.parse("2026-11-11T16:16:00Z"));
  assert.equal(success.status,"dispatched");
  assert.equal(f.puts.length,1);
  assert.match(requests[1].url,/snapshot-arena\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(requests[1].options.body),
    {ref:"main",inputs:{source_date:"2026-11-11"}});
  const duplicate=await dispatchArenaPublication(f.env,"2026-11-11",async()=>{
    throw Error("same-minute retry must be suppressed");
  },Date.parse("2026-11-11T16:17:00Z"));
  assert.equal(duplicate.status,"already-dispatched");
  assert.equal(requests.length,2);
  const retry=await dispatchArenaPublication(f.env,"2026-11-11",async(url,options)=>{
    requests.push({url,options});
    return new Response(null,{status:url.includes("/contents/")?404:204});
  },Date.parse("2026-11-11T16:26:00Z"));
  assert.equal(retry.status,"dispatched");
  assert.match(requests[2].url,/contents\/docs\/data\/arena-history\/snapshots/);
  assert.match(requests[3].url,/snapshot-arena\.yml\/dispatches$/);
  const acknowledged=await dispatchArenaPublication(f.env,"2026-11-11",async(url,options)=>{
    requests.push({url,options});return new Response(null,{status:200});
  },Date.parse("2026-11-11T16:36:00Z"));
  assert.equal(acknowledged.status,"published");
  assert.equal(requests.length,5);
});
test("Arena GitHub dispatch rejects invalid dates and missing credentials without requests",async()=>{
  const f=fixture();let calls=0;
  assert.equal((await dispatchArenaPublication(f.env,"2026-02-30",async()=>{calls++;})).status,
    "invalid-campaign");
  delete f.env.ROSTER_GITHUB_DISPATCH_TOKEN;
  assert.equal((await dispatchArenaPublication(f.env,"2026-11-11",async()=>{calls++;})).status,
    "unavailable");
  assert.equal(calls,0);
});
