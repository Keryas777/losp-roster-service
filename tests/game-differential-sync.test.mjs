import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
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
