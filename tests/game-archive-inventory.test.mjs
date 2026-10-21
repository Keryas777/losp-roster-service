import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {handleGameArchiveInventory} from "../src/game-archive-inventory.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const base="https://losp-roster-service.deliriousfan7.workers.dev";
const uri=base+"/admin/api/game-archive-inventory";
const run="11111111-2222-4333-8444-555555555555";
const old="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const root=GAME_ARCHIVE_ROOT+"runs/"+run+"/";
const sha=n=>n.toString(16).padStart(64,"0")+".json";
const id="12345678-1234-4234-8234-123456789abc.json";
const receipt=i=>root+"receipts/"+String(i).padStart(10,"0")+".json";
const obj=n=>root+"objects/"+sha(n);
const raw=root+"raw/"+id;
function fixture(){
  const files=new Map(),calls=[],writes=[];
  const put=(key,value)=>files.set(key,typeof value==="string"?value:JSON.stringify(value));
  put(GAME_ARCHIVE_ROOT+"active.json",{version:1,runId:run});
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      if(!files.has(key))return null;
      const data=files.get(key);
      return {size:data.length,text:async()=>data};
    },
    list:async ({prefix,limit,cursor})=>{
      calls.push(["list",prefix,limit,cursor]);
      const keys=[...files.keys()].filter(k=>k.startsWith(prefix)).sort();
      const start=cursor?Number(cursor):0;
      const slice=keys.slice(start,start+limit);
      return {objects:slice.map(key=>({key,size:files.get(key).length})),
        truncated:start+slice.length<keys.length,
        cursor:start+slice.length<keys.length?String(start+slice.length):null};
    },
    put:async(...args)=>{writes.push(args);throw Error("no write allowed");},
    delete:async(...args)=>{writes.push(args);throw Error("no deletion allowed");}
  };
  return {files,put,calls,writes,env:{CAPTAIN_BUCKET:bucket}};
}
const get=(f,query)=>handleGameArchiveInventory(new Request(uri+"?"+query),f.env);

test("read-only R2 inventory pages isolate active run and return hashes but no game data",async()=>{
  const f=fixture();
  for(let i=0;i<205;i++){
    f.put(obj(i),{data:{secret:"GAME_DATA_NOT_FOR_BROWSER"}});
    f.put(receipt(i),{status:200,path:"/game/v1/characters/Hero"+i,
      objectKey:obj(i),bytes:123});
  }
  f.put(raw,"GAME_BIG_PRIVATE_JSON");
  f.put(receipt(205),{status:200,path:"/game/v1/characters/LargeHero",
    objectKey:raw,bytes:10_000_000});
  f.put(obj(500),{data:{orphan:"GAME_DATA_NOT_FOR_BROWSER"}});
  f.put(root+"receipts/broken.json","{corrupted");
  f.put(GAME_ARCHIVE_ROOT+"runs/"+old+"/objects/"+sha(999),"OTHER_CAMPAIGN");
  const initial=await (await get(f,"kind=overview")).json();
  assert.equal(initial.status,"ready");
  assert.equal(initial.runId,run);
  let scan=await (await get(f,"kind=receipts&runId="+run)).json();
  assert.equal(scan.listed,200);
  assert.equal(scan.validReceipts,200);
  assert.equal(scan.references.length,200);
  assert.equal(scan.nextCursor,"200");
  let page2=await (await get(f,"kind=receipts&runId="+run+"&cursor=200")).json();
  assert.equal(page2.listed,7);
  assert.equal(page2.validReceipts,6);
  assert.equal(page2.unreadableReceipts,1);
  scan=await (await get(f,"kind=objects&runId="+run)).json();
  assert.equal(scan.listed,200);
  assert.equal(scan.ids.length,200);
  assert.equal(scan.nextCursor,"200");
  const objs2=await (await get(f,"kind=objects&runId="+run+"&cursor=200")).json();
  assert.equal(objs2.listed,6);
  assert.equal(objs2.nextCursor,null);
  scan=await (await get(f,"kind=raw&runId="+run)).json();
  assert.deepEqual(scan.ids,[id]);
  assert.ok(!JSON.stringify(scan).includes("GAME_DATA_NOT_FOR_BROWSER"));
  assert.ok(!JSON.stringify(page2).includes("GAME_DATA_NOT_FOR_BROWSER"));
  assert.ok(f.calls.every(call=>call[1]===GAME_ARCHIVE_ROOT+"active.json"||
    call[1].startsWith(root)));
  assert.equal(f.calls.filter(call=>call[0]==="get"&&call[1].startsWith(root+"objects/")).length,0);
  assert.equal(f.calls.filter(call=>call[0]==="get"&&call[1].startsWith(root+"raw/")).length,0);
  assert.deepEqual(f.writes,[]);
});

test("receipt validation excludes invalid provider paths and wrong-run references",async()=>{
  const f=fixture();
  f.put(receipt(1),{status:200,path:"/game/v1/characters/A",
    objectKey:obj(1)});
  f.put(receipt(2),{status:200,path:"/player/v1/roster",
    objectKey:obj(1)});
  f.put(receipt(3),{status:200,path:"/game/v1/characters/A",
    objectKey:GAME_ARCHIVE_ROOT+"runs/"+old+"/objects/"+sha(1)});
  f.put(receipt(4),{status:472,path:"/game/v1/characters/A",
    objectKey:obj(1)});
  f.put(receipt(5),{status:200,path:"/game/v1/characters/A",
    objectKey:"roster-batches/v1/secret"});
  const p=await(await get(f,"kind=receipts&runId="+run)).json();
  assert.equal(p.listed,5);
  assert.equal(p.validReceipts,1);
  assert.equal(p.invalidReceipts,4);
  assert.equal(p.unreadableReceipts,0);
  assert.deepEqual(p.references,[{type:"objects",id:sha(1)}]);
});

test("rejects arbitrary prefixes, unexpected parameters, cursor forgery, changed active run",async()=>{
  const f=fixture();
  for(const query of ["kind=other","kind=receipts","kind=objects&runId=oops",
    "kind=raw&runId="+run+"&cursor=..%2Fsecret",
    "kind=overview&cursor=2","kind=overview&runId="+run,
    "kind=objects&runId="+run+"&other=x",
    "kind=objects&runId="+run+"&kind=raw"]){
    assert.equal((await get(f,query)).status,400,query);
  }
  const conflict=await get(f,"kind=raw&runId="+old);
  assert.equal(conflict.status,409);
  f.files.delete(GAME_ARCHIVE_ROOT+"active.json");
  assert.equal((await get(f,"kind=overview")).status,404);
  assert.deepEqual(f.writes,[]);
});

test("Cloudflare Access gates inventory before any bucket read or R2 list",async()=>{
  const f=fixture();
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"unit.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.invalid"};
  const res=await handleAdmin(new Request(uri+"?kind=overview"),env,async()=>{
    throw Error("No network expected");
  });
  assert.equal(res.status,403);
  assert.deepEqual(f.calls,[]);
});

test("mobile UI is plain JS, no player data persistence or Scopely request",async()=>{
  const source=await readFile(
    new URL("../public/admin-game-r2-inventory.js",import.meta.url),"utf8");
  const html=await readFile(
    new URL("../src/admin-routes.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(source));
  assert.match(source,/textContent/);
  assert.match(source,/new Set\(/);
  assert.doesNotMatch(source,/innerHTML|localStorage|sessionStorage|indexedDB|eval\(/);
  assert.match(html,/\/admin\/api\/game-archive-inventory/);
  assert.match(html,/admin-game-r2-inventory\.js/);
  assert.match(html,/game-r2-inventory-start/);
});
