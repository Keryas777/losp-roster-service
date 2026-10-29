import {test} from "node:test";
import assert from "node:assert/strict";
import {handleGameArchiveItemSearch} from "../src/game-archive-item-search.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const NOW=Date.parse("2026-10-29T12:00:00.000Z");
const STAMP="2026-10-28T12:00:00.000Z";
const RUN="11111111-2222-4333-8444-555555555555";
const DIFF_RUN="aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ROOT=GAME_ARCHIVE_ROOT,BASE="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=BASE+"/admin/api/game-archive-item-search";
const hash=async raw=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(raw)))]
  .map(v=>v.toString(16).padStart(2,"0")).join("");
const detail=id=>"/game/v1/items/"+id;
function fixture(){
  const values=new Map(),reads=[],heads=[],lists=[],receiptKeys=[];
  function put(key,value){values.set(key,typeof value==="string"?value:JSON.stringify(value));}
  put(ROOT+"active.json",{runId:RUN});
  const b={
    get:async key=>{
      reads.push(key);
      const raw=values.get(key);
      return raw===undefined?null:
        {size:Buffer.byteLength(raw),text:async()=>raw};
    },
    head:async key=>{
      heads.push(key);
      const raw=values.get(key);
      return raw===undefined?null:
        {size:Buffer.byteLength(raw),uploaded:new Date(STAMP)};
    },
    list:async options=>{
      lists.push(options);
      const all=receiptKeys.slice().sort();
      const offset=options.cursor?Number(options.cursor):0;
      const keys=all.slice(offset,offset+options.limit);
      return {objects:keys.map(key=>({key})),
        truncated:offset+keys.length<all.length,
        cursor:String(offset+keys.length)};
    },
    put:async()=>{throw Error("must never write R2")},
    delete:async()=>{throw Error("must never delete R2")}
  };
  async function original(id,ordinal=1,opts={}){
    const path=detail(id),raw=JSON.stringify({data:{id,name:"Official Item"}});
    const digest=await hash(raw);
    const key=ROOT+"runs/"+RUN+"/objects/"+digest+".json";
    const receiptKey=ROOT+"runs/"+RUN+"/receipts/"+
      String(ordinal).padStart(10,"0")+"-00000-s0.json";
    put(key,raw);
    put(receiptKey,{version:1,path,status:200,sha256:digest,
      objectKey:opts.objectKey||key,
      capturedAt:opts.capturedAt||STAMP,bytes:Buffer.byteLength(raw)});
    receiptKeys.push(receiptKey);
    return {path,key,receiptKey,raw,digest};
  }
  async function latest(id,opts={}){
    const path=detail(id),raw=JSON.stringify({data:{id,name:"Latest official item"}});
    const digest=await hash(raw);
    const key=ROOT+"diff/runs/"+DIFF_RUN+"/objects/"+digest+".json";
    const receiptKey=ROOT+"diff/runs/"+DIFF_RUN+"/checks/00000001.json";
    const index=ROOT+"diff/latest/"+await hash(path)+".json";
    put(key,raw);
    const receipt={version:2,path,status:"changed",sha256:digest,
      objectKey:key,storedAt:STAMP,checkedAt:STAMP};
    put(receiptKey,receipt);
    put(index,{version:2,path,sha256:digest,objectKey:key,
      storedAt:STAMP,checkedAt:STAMP,receiptKey,...opts});
    return {path,key,index,receiptKey};
  }
  return {values,reads,heads,lists,receiptKeys,env:{CAPTAIN_BUCKET:b},
    put,original,latest};
}
const search=(f,id,cursor=null,now=NOW)=>{
  const q=new URLSearchParams({id});
  if(cursor)q.set("cursor",cursor);
  return handleGameArchiveItemSearch(new Request(ENDPOINT+"?"+q),f.env,now);
};

test("exact differential lookup verifies receipt and bytes without scanning",async()=>{
  const f=fixture();
  const {path}=await f.latest("ability_material_green");
  const res=await search(f,"ability_material_green");
  assert.equal(res.status,200);
  const out=await res.json();
  assert.equal(out.status,"found");
  assert.equal(out.source,"differential");
  assert.equal(out.path,path);
  assert.equal(out.payload.data.id,"ability_material_green");
  assert.equal(out.scope,"verified-archived-json");
  assert.equal(f.lists.length,0);
  assert.equal(res.headers.get("Cache-Control"),"private, no-store");
  assert.ok(!JSON.stringify(out).includes("objectKey"));
});

test("original receipts are searched by exact route with resumable cursor",async()=>{
  const f=fixture();
  for(let i=1;i<=20;i++)await f.original("Other"+i,i);
  const item=await f.original("ability_material_blue",21);
  const first=await (await search(f,"ability_material_blue")).json();
  assert.equal(first.status,"searching");
  assert.equal(first.examined,20);
  assert.equal(first.nextCursor,"20");
  const second=await (await search(f,"ability_material_blue",first.nextCursor)).json();
  assert.equal(second.status,"found");
  assert.equal(second.source,"original");
  assert.equal(second.payload.data.id,"ability_material_blue");
  assert.ok(f.lists.every(x=>x.prefix===ROOT+"runs/"+RUN+"/receipts/"));
  assert.ok(f.lists.every(x=>x.limit===20));
  assert.ok(f.reads.includes(item.key));
});

test("no pointer or receipt is not proof that an item is absent",async()=>{
  const f=fixture();
  const result=await (await search(f,"ability_material_purple")).json();
  assert.equal(result.status,"not-indexed");
  assert.equal(result.examined,0);
  assert.equal(result.nextCursor,null);
  assert.ok(result.note.includes("Orphaned"));
});

test("never read a private object from a forged original receipt",async()=>{
  const f=fixture();
  await f.original("ability_material_orange",1,{objectKey:"oauth-captains/v1/secret.json"});
  f.put("oauth-captains/v1/secret.json",{data:{secret:"private"}});
  const result=await (await search(f,"ability_material_orange")).json();
  assert.equal(result.status,"not-indexed");
  assert.equal(result.issue,"invalid-original-receipt");
  assert.ok(!f.reads.includes("oauth-captains/v1/secret.json"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("mismatched differential evidence is never returned as a valid item",async()=>{
  const f=fixture();
  const proof=await f.latest("ability_material_green",{sha256:"a".repeat(64)});
  const result=await (await search(f,"ability_material_green")).json();
  assert.equal(result.status,"not-indexed");
  assert.equal(result.issue,"invalid-differential-pointer");
  assert.ok(!f.reads.includes(proof.key));
});

test("expired original receipts cannot expose archived JSON",async()=>{
  const f=fixture();
  const item=await f.original("ability_material_blue",1,
    {capturedAt:"2026-08-01T00:00:00.000Z"});
  const result=await (await search(f,"ability_material_blue")).json();
  assert.equal(result.status,"not-indexed");
  assert.equal(result.issue,"expired-or-unknown-date");
  assert.ok(!f.reads.includes(item.key));
});

test("invalid IDs and cursors are rejected before any R2 read",async()=>{
  const f=fixture();
  for(const q of ["?id=..%2Fsecret","?id=ability_material_green&cursor=..%2F",
    "?id=abc&path=%2Fplayer%2Fv1%2Froster","?id="]){
    const r=await handleGameArchiveItemSearch(new Request(ENDPOINT+q),f.env,NOW);
    assert.equal(r.status,400);
  }
  assert.equal(f.reads.length,0);
  assert.equal(f.lists.length,0);
});

test("admin Access authentication happens before any R2 lookup",async()=>{
  const f=fixture();
  const guarded={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const r=await handleAdmin(new Request(ENDPOINT+"?id=ability_material_green"),guarded);
  assert.equal(r.status,403);
  assert.equal(f.reads.length,0);
});

test("UI is wired inside the existing Archives R2 section",async()=>{
  const {readFile}=await import("node:fs/promises");
  const html=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const js=await readFile(new URL("../public/admin-game-archive-item-search.js",import.meta.url),"utf8");
  assert.ok(html.includes('id="game-item-id"'));
  assert.ok(html.includes('src="/admin-game-archive-item-search.js"'));
  assert.ok(html.includes('pathname==="/admin/api/game-archive-item-search"'));
  assert.ok(js.includes("/admin/api/game-archive-item-search?"));
});
