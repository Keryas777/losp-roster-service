import {test} from "node:test";
import assert from "node:assert/strict";
import {handleGameArchiveInspect,inspectGameShape} from "../src/game-archive-inspector.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const run="11111111-2222-4333-8444-555555555555";
const base="https://losp-roster-service.deliriousfan7.workers.dev";
const endpoint=base+"/admin/api/game-archive-inspect";
const prefix=GAME_ARCHIVE_ROOT+"runs/"+run+"/";
const blob=letter=>prefix+"objects/"+letter.repeat(64)+".json";
function fixture(){
 const store=new Map(),reads=[],heads=[],lists=[];
 store.set(GAME_ARCHIVE_ROOT+"active.json",{runId:run});
 const receipts=[];
 const bucket={
   get:async key=>{
     reads.push(key);
     if(!store.has(key))return null;
     const val=JSON.stringify(store.get(key));
     return {size:val.length,text:async()=>val};
   },
   head:async key=>{
     heads.push(key);
     if(!store.has(key))return null;
     return {size:JSON.stringify(store.get(key)).length};
   },
   list:async options=>{
     lists.push(options);
     const all=receipts.slice().sort();
     const index=options.cursor?Number(options.cursor):0;
     const subset=all.slice(index,index+options.limit);
     return {objects:subset.map(key=>({key})),
       truncated:index+subset.length<all.length,
       cursor:String(index+subset.length)};
   },
   put:async()=>{throw Error("inspector must never write")},
   delete:async()=>{throw Error("inspector must never delete")}
 };
 function add(i,path,hash,document,options={}){
   const name=prefix+"receipts/"+String(i).padStart(5,"0")+".json";
   receipts.push(name);
   store.set(name,{status:options.status||200,path,
     objectKey:options.objectKey||blob(hash),
     capturedAt:"2026-10-20T16:00:00.000Z",
     bytes:JSON.stringify(document).length});
   if(!options.noObject)store.set(blob(hash),document);
 }
 return {store,reads,heads,lists,receipts,env:{CAPTAIN_BUCKET:bucket},add};
}
const get=async(f,q="")=>await handleGameArchiveInspect(new Request(endpoint+q),f.env);

test("shape extractor returns only field names, types and at most three IDs",()=>{
 const source={data:[{id:"Hero1",name:"Name",abilities:{secret:"private"}},
   {id:"Hero2"},{id:"Hero3"},{id:"Hero4"}],meta:{asOf:"date"},token:"secret"};
 const shape=inspectGameShape(source);
 assert.equal(shape.dataType,"array");
 assert.equal(shape.entryCount,4);
 assert.deepEqual(shape.entryKeys,["id","name","abilities"]);
 assert.deepEqual(shape.exampleIds,["Hero1","Hero2","Hero3"]);
 assert.deepEqual(shape.metaKeys,["asOf"]);
 assert.ok(!JSON.stringify(shape).includes("secret"));
 assert.deepEqual(inspectGameShape(null).exampleIds,[]);
});

test("one R2 sample page is read-only, bounded and restricted to current run",async()=>{
 const f=fixture();
 f.add(1,"/game/v1/characters","a",
   {data:[{id:"Hero1",name:"Hero"}],meta:{perTotal:1}});
 f.add(2,"/game/v1/items/ITEM1","b",
   {data:{id:"ITEM1",name:"Item"},meta:{asOf:"2026-10-20"}});
 f.add(3,"/game/v1/raids/R1","c",
   {data:{id:"R1",difficulty:4}});
 f.add(4,"/game/v1/events","d",
   {data:[{id:"Event1"}]});
 f.add(5,"/game/v1/traits","e",
   {data:{id:"T1"}});
 f.add(6,"/player/v1/roster","f",{data:{sensitive:"do-not-expose"}});
 f.add(7,"/game/v1/items/ITEM2","g",{
   data:{id:"ITEM2",bad:"X".repeat(760_000)}
 });
 f.add(8,"/game/v1/items/ITEM3","h",{data:42},{
   objectKey:"oauth-captains/v1/secret.json"
 });
 const res=await get(f);
 assert.equal(res.status,200);
 const out=await res.json();
 assert.equal(out.status,"sample-only");
 assert.equal(out.listed,8);
 assert.equal(out.validReceipts,7);
 assert.equal(out.samples.length,4);
 assert.equal(out.nextCursor,null);
 assert.equal(f.lists[0].prefix,prefix+"receipts/");
 assert.equal(f.lists[0].limit,20);
 assert.ok(out.receipts.every(x=>x.path.startsWith("/game/v1/")));
 assert.ok(!JSON.stringify(out).includes("do-not-expose"));
 assert.ok(!JSON.stringify(out).includes("oauth-captains"));
 assert.ok(!JSON.stringify(out).includes("secret.json"));
 assert.ok(!f.reads.includes(blob("g")),"no loading oversized sample");
 assert.ok(!f.reads.includes(blob("f")),"no player JSON read");
 assert.equal(res.headers.get("Cache-Control"),"private, no-store");
});
test("pagination uses R2 cursors and cannot request unrelated prefixes",async()=>{
 const f=fixture();
 for(let i=0;i<25;i++)
   f.add(i,"/game/v1/characters/Hero"+i,String.fromCharCode(97+i%26),
     {data:{id:"Hero"+i}});
 const first=await (await get(f)).json();
 assert.equal(first.listed,20);
 assert.equal(first.nextCursor,"20");
 const second=await (await get(f,"?cursor=20")).json();
 assert.equal(second.listed,5);
 assert.equal(second.nextCursor,null);
 assert.ok(f.lists.every(x=>x.prefix===prefix+"receipts/"));
 assert.equal((await get(f,"?cursor=..%2Fprivate")).status,400);
 assert.equal((await get(f,"?cursor="+("A".repeat(900)))).status,400);
});
test("missing R2 state does not invent archive results",async()=>{
 const f=fixture();
 f.store.delete(GAME_ARCHIVE_ROOT+"active.json");
 const result=await get(f);
 assert.equal(result.status,404);
 assert.equal((await result.json()).error,"no-active-run");
});
test("admin auth must succeed before any private R2 read",async()=>{
 const f=fixture();
 const guarded={...f.env,MSF_ADMIN_ENABLED:"true",
   CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
   CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
 const res=await handleAdmin(new Request(endpoint),guarded);
 assert.equal(res.status,403);
 assert.equal(f.reads.length,0);
 assert.equal(f.lists.length,0);
});
