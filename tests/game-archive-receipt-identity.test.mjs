import {test} from "node:test";
import assert from "node:assert/strict";
import {RosterBatchLock} from "../src/roster-batch-lock.js";
import {GAME_ARCHIVE_ROOT,startGameArchive,runGameArchiveTick,gameArchiveStatus} from "../src/game-catalog-archive.js";

const now=Date.UTC(2026,9,21,12);
const prefix=GAME_ARCHIVE_ROOT;
const game=path=>({path,root:"characters",mode:"detail"});
function fixture(){
  const objects=new Map(),locks=new Map();
  const guard=new RosterBatchLock({storage:{
    get:async key=>locks.get(key),
    put:async(key,value)=>{locks.set(key,value);},
    delete:async key=>{locks.delete(key);}
  }});
  const env={
    GAME_ARCHIVE_AUTO_ENABLED:"true",
    SCOPELY_CLIENT_ID:"unit-test-id",SCOPELY_CLIENT_SECRET:"unit-test-secret",
    CAPTAIN_BUCKET:{
      get:async key=>objects.has(key)?{text:async()=>objects.get(key)}:null,
      put:async(key,value)=>{
        objects.set(key,typeof value==="string"?value:
          new TextDecoder().decode(value));
      }
    },
    ROSTER_BATCH_LOCK:{
      idFromName:key=>key,
      get:()=>({fetch:req=>guard.fetch(req)})
    }
  };
  const calls=[];
  const provider=async url=>{
    calls.push(url);
    if(url.includes("/oauth2/token"))
      return Response.json({access_token:"TEST_TOKEN",token_type:"Bearer",expires_in:300});
    assert.match(url,/\/game\/v1\/characters\/Hero/);
    return Response.json({data:{id:new URL(url).pathname.split("/").at(-1)},meta:{}});
  };
  return {env,objects,calls,provider};
}
test("each queued chunk gets distinct receipt identity even when local cursor resets",async()=>{
  const f=fixture();
  const started=await startGameArchive(f.env,now);
  assert.equal(started.status,"started");
  const active=JSON.parse(f.objects.get(prefix+"active.json"));
  const location=prefix+"runs/"+active.runId+"/";
  const progressKey=location+"progress.json";
  const progress=JSON.parse(f.objects.get(progressKey));
  // Two one-task queue windows reproduce a boundary without 600 provider GETs.
  progress.tasks=[game("/game/v1/characters/HeroA")];
  progress.cursor=0;
  progress.pendingTasks=1;
  progress.spillRead=0;
  f.objects.set(progressKey,JSON.stringify(progress));
  f.objects.set(location+"queue/00000000.json",
    JSON.stringify([game("/game/v1/characters/HeroB")]));
  const result=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(result.status,"completed");
  const receipts=[...f.objects.entries()].filter(([key])=>
    key.startsWith(location+"receipts/"));
  assert.equal(receipts.length,2,
    "second chunk MUST NOT overwrite first chunk receipt");
  const names=receipts.map(([key])=>key.slice((location+"receipts/").length));
  assert.equal(new Set(names).size,2);
  assert.ok(names.some(name=>name.startsWith("0000000000-")));
  assert.ok(names.some(name=>name.startsWith("0000000001-")));
  const paths=receipts.map(([,value])=>JSON.parse(value).path).sort();
  assert.deepEqual(paths,["/game/v1/characters/HeroA",
    "/game/v1/characters/HeroB"]);
  assert.equal(f.calls.filter(url=>url.includes("/game/v1/")).length,2);
  const status=await gameArchiveStatus(f.env,now);
  assert.equal(status.archivedResponses,2);
  assert.equal(status.cursor,2);
  assert.equal(status.totalTasks,2);
});

test("legacy progress without completedOffset starts from zero without breaking receipt storage",async()=>{
  const f=fixture();
  await startGameArchive(f.env,now);
  const active=JSON.parse(f.objects.get(prefix+"active.json"));
  const location=prefix+"runs/"+active.runId+"/";
  const key=location+"progress.json";
  const state=JSON.parse(f.objects.get(key));
  state.tasks=[game("/game/v1/characters/HeroLegacy")];
  state.cursor=0;
  delete state.completedOffset;
  f.objects.set(key,JSON.stringify(state));
  const result=await runGameArchiveTick(f.env,f.provider,now);
  assert.equal(result.status,"completed");
  const receipts=[...f.objects.keys()].filter(k=>k.includes("/receipts/"));
  assert.equal(receipts.length,1);
  assert.match(receipts[0],/\/receipts\/0000000000-00000-s0\.json$/);
});
