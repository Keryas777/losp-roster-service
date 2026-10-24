import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {GAME_ARCHIVE_ROOT,startGameArchive,runGameArchiveTick,gameArchiveStatus} from "../src/game-catalog-archive.js";

const now=Date.UTC(2026,9,19,12);
function fixture(api=()=>Response.json({data:[],meta:{perTotal:0}})){
  const store=new Map(),calls=[],locks=new Map(),lockState=new Map();
  const env={
    GAME_ARCHIVE_AUTO_ENABLED:"true",
    SCOPELY_CLIENT_ID:"unit-client",SCOPELY_CLIENT_SECRET:"unit-secret",
    CAPTAIN_BUCKET:{
      get:async key=>store.has(key)?{text:async()=>store.get(key)}:null,
      createMultipartUpload:async(key)=>{
        const chunks=new Map();
        return {
          uploadPart:async(number,bytes)=>{
            chunks.set(number,new Uint8Array(bytes));
            return {partNumber:number,etag:"part-"+number};
          },
          complete:async parts=>{
            const size=parts.reduce((sum,p)=>sum+chunks.get(p.partNumber).byteLength,0);
            const data=new Uint8Array(size);let at=0;
            for(const part of parts){
              const chunk=chunks.get(part.partNumber);
              data.set(chunk,at);at+=chunk.byteLength;
            }
            store.set(key,new TextDecoder().decode(data));
            return {size};
          },
          abort:async()=>{}
        };
      },
      put:async(key,value)=>{
        let payload;
        if(typeof value==="string")payload=value;
        else if(value instanceof ReadableStream)payload=await new Response(value).text();
        else payload=new TextDecoder().decode(value);
        store.set(key,payload);
        return {size:new TextEncoder().encode(payload).byteLength};
      }
    },
    ROSTER_BATCH_LOCK:{
      idFromName:id=>id,
      get:id=>{
        if(!locks.has(id))locks.set(id,new RosterBatchLock({
          storage:{
            get:async k=>lockState.get(k),
            put:async(k,v)=>lockState.set(k,v),
            delete:async k=>lockState.delete(k)
          }
        }));
        return {fetch:request=>locks.get(id).fetch(request)};
      }
    }
  };
  const fetcher=async(url,options)=>{
    calls.push(url);
    if(url.endsWith("/oauth2/token"))
      return Response.json({access_token:"sample",token_type:"Bearer",expires_in:300});
    assert.equal(options.method,"GET");
    return api(url,calls);
  };
  const progress=()=>{
    const active=JSON.parse(store.get(GAME_ARCHIVE_ROOT+"active.json"));
    const key=GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json";
    return {key,value:JSON.parse(store.get(key))};
  };
  return {env,store,calls,fetcher,progress};
}
test("transient 503 retries automatically without replacing an active R2 run",async()=>{
  let failures=1;
  const f=fixture(()=>failures-- >0?
    new Response("temporary",{status:503}):
    Response.json({data:[],meta:{perTotal:0}}));
  await startGameArchive(f.env,now);
  const before=f.progress().value.runId;
  const first=await runGameArchiveTick(f.env,f.fetcher,now);
  assert.equal(first.status,"running");
  assert.equal(first.lastOutcome,"http-503");
  assert.equal((await runGameArchiveTick(f.env,f.fetcher,now+30_000)).status,"cooldown");
  const retried=await runGameArchiveTick(f.env,f.fetcher,now+60_000);
  assert.equal(retried.status,"running");
  assert.equal(f.progress().value.runId,before);
  assert.ok(retried.completedTasks>0);
});
test("an old blocked campaign resumes without pressing start",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const state=f.progress();
  state.value.status="blocked";
  state.value.lastOutcome="network-error";
  f.store.set(state.key,JSON.stringify(state.value));
  const run=await runGameArchiveTick(f.env,f.fetcher,now);
  assert.equal(run.status,"running");
  assert.equal(run.completedTasks,12);
});
test("overlapping IDs on distinct pages do not pass the pagination audit",async()=>{
  let attempts=0;
  const f=fixture(url=>{
    const u=new URL(url);
    if(u.pathname!=="/game/v1/characters")
      return Response.json({data:[],meta:{perTotal:0}});
    const page=Number(u.searchParams.get("page"));
    if(page===1){
      return Response.json({data:Array.from({length:100},(_,i)=>({id:"Hero"+i})),
        meta:{perTotal:101,page:1}});
    }
    attempts++;
    return Response.json({data:[{id:attempts===1?"Hero0":"Hero100"}],
      meta:{perTotal:101,page:2}});
  });
  await startGameArchive(f.env,now);
  const state=f.progress();state.value.cursor=7;
  f.store.set(state.key,JSON.stringify(state.value));
  const first=await runGameArchiveTick(f.env,f.fetcher,now);
  assert.equal(first.status,"running");
  assert.equal(first.lastOutcome,"pagination-overlapping-ids");
  assert.equal(f.progress().value.tasks[7].page,1);
  assert.equal((await gameArchiveStatus(f.env,now)).cursor,7);
  const second=await runGameArchiveTick(f.env,f.fetcher,now+60_000);
  assert.ok(second.completedTasks>7);
  assert.ok([...f.store.keys()].some(k=>k.includes("/receipts/")));
});
test("responses above former 8MB cap are streamed into private R2 instead of blocked",async()=>{
  const huge=JSON.stringify({data:{text:"X".repeat(8_000_200)},meta:{}});
  const f=fixture(url=>url.endsWith("/game/v1/characters/LargeHero")?
    new Response(huge,{headers:{"Content-Type":"application/json"}}):
    Response.json({data:[],meta:{perTotal:0}}));
  await startGameArchive(f.env,now);
  const state=f.progress();
  state.value.tasks=[{path:"/game/v1/characters/LargeHero",root:"characters",mode:"detail"}];
  state.value.cursor=0;
  f.store.set(state.key,JSON.stringify(state.value));
  const result=await runGameArchiveTick(f.env,f.fetcher,now);
  assert.equal(result.status,"completed-with-gaps");
  assert.equal(result.lastOutcome,"completed-with-gaps");
  assert.equal((await gameArchiveStatus(f.env,now)).gapCount,1);
  const raw=[...f.store.entries()].filter(([k])=>k.includes("/raw/"));
  assert.equal(raw.length,1);
  assert.equal(raw[0][1],huge);
});
test("discovery beyond 12000 details spills to R2 without losing tasks",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const state=f.progress();
  state.value.tasks=[{
    path:"/game/v1/characters",root:"characters",mode:"list",page:1,perPage:100,
    discovered:Array.from({length:12_010},(_,i)=>"Hero"+i)
  }];
  state.value.cursor=0;
  f.store.set(state.key,JSON.stringify(state.value));
  const result=await runGameArchiveTick(f.env,f.fetcher,now);
  assert.equal(result.status,"running");
  assert.equal(result.totalTasks,12_011);
  assert.ok(f.progress().value.pendingTasks>11_000);
  assert.ok([...f.store.keys()].some(k=>k.includes("/queue/")));
  assert.ok(result.completedTasks>0);
});
