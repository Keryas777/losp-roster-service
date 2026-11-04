import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {publicEvents,buildPublicEvents} from "../src/public-events.js";

const NOW=Date.parse("2026-11-04T09:00:00Z");
const BASE="game-archive/v1/";
const RUN="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const URL="https://losp-roster-service.deliriousfan7.workers.dev/api/public/events";
const hash=x=>createHash("sha256").update(x).digest("hex");
function setup(total=150){
  const store=new Map(),calls={get:[],put:[]};
  const bucket={get:async key=>{
    calls.get.push(key);
    const raw=store.get(key);return raw===undefined?null:{
      size:Buffer.byteLength(raw),text:async()=>raw
    };
  },put:async()=>{calls.put.push("bad");throw Error("unexpected-write");}};
  const events=Array.from({length:total},(_,i)=>({
    id:i.toString(16).padStart(24,"0"),type:"milestone",
    startTime:1792000000,endTime:1793000000,name:"Event "+i,
    milestone:{type:"solo",scoring:{methods:[{
      description:"Play War",points:5
    }]},brackets:[{id:"default"}]}
  }));
  const add=(page,overrides={})=>{
    const path="/game/v1/events?page="+page+"&perPage=100";
    const key=BASE+"diff/latest/"+hash(path)+".json";
    const storedAt=new Date(NOW-86400000).toISOString();
    const source=JSON.stringify({data:events.slice((page-1)*100,page*100),
      meta:{page,perPage:100,perTotal:total,hashes:{events:"a".repeat(20)}}});
    const sha=hash(source);
    const objectKey=BASE+"diff/runs/"+RUN+"/objects/"+sha+".json";
    const receiptKey=BASE+"diff/runs/"+RUN+"/checks/"+String(page).padStart(8,"0")+".json";
    const receipt={status:"changed",path,sha256:sha,objectKey,storedAt,
      checkedAt:storedAt,...overrides.receipt};
    const pointer={version:2,path,sha256:sha,objectKey,storedAt,receiptKey,
      checkedAt:storedAt,...overrides.pointer};
    store.set(objectKey,source);
    store.set(receiptKey,JSON.stringify(receipt));
    store.set(key,JSON.stringify(pointer));
    return {key,objectKey,receiptKey};
  };
  const refs=[];for(let page=1;page<=Math.ceil(total/100);page++)refs.push(add(page));
  const env={CAPTAIN_BUCKET:bucket};
  return {store,calls,events,refs,env,add};
}
test("publishes exactly the two verified pages, no Scopely GET or R2 write",async()=>{
  const f=setup();
  const resp=await publicEvents(new Request(URL),f.env,NOW);
  assert.equal(resp.status,200);
  assert.equal(resp.headers.get("access-control-allow-origin"),"*");
  const doc=await resp.json();
  assert.equal(doc.count,150);assert.equal(doc.pages,2);
  assert.equal(new Set(doc.events.map(x=>x.id)).size,150);
  assert.equal(doc.events[0].milestone.scoring.methods[0].points,5);
  assert.ok(f.calls.get.every(k=>k.startsWith(BASE)));
  assert.deepEqual(f.calls.put,[]);
  assert.ok(!JSON.stringify(doc).includes("objects/"));
  assert.ok(!JSON.stringify(doc).includes("receiptKey"));
});
test("supports automatically a third page when perTotal grows",async()=>{
  const f=setup(225);
  const data=await buildPublicEvents(f.env,NOW);
  assert.equal(data.pages,3);assert.equal(data.events.length,225);
});
test("fails closed when a page is missing",async()=>{
  const f=setup();f.store.delete(f.refs[1].key);
  const res=await publicEvents(new Request(URL),f.env,NOW);
  assert.equal(res.status,503);assert.equal((await res.json()).status,"unavailable");
});
test("fails closed when collection pages carry different event revisions",async()=>{
  const f=setup();
  const key=f.refs[1].objectKey;
  const value=JSON.parse(f.store.get(key));
  value.meta.hashes.events="b".repeat(20);
  const updated=JSON.stringify(value);
  const newHash=hash(updated);
  const newKey=BASE+"diff/runs/"+RUN+"/objects/"+newHash+".json";
  const receipt=JSON.parse(f.store.get(f.refs[1].receiptKey));
  receipt.sha256=newHash;receipt.objectKey=newKey;
  const pointer=JSON.parse(f.store.get(f.refs[1].key));
  pointer.sha256=newHash;pointer.objectKey=newKey;
  f.store.set(newKey,updated);
  f.store.set(f.refs[1].receiptKey,JSON.stringify(receipt));
  f.store.set(f.refs[1].key,JSON.stringify(pointer));
  assert.equal((await publicEvents(new Request(URL),f.env,NOW)).status,503);
});
test("fails closed on tampered bytes or expired source, ignoring new checkedAt",async()=>{
  const f=setup();
  f.store.set(f.refs[0].objectKey,f.store.get(f.refs[0].objectKey)+" ");
  assert.equal((await publicEvents(new Request(URL),f.env,NOW)).status,503);
  const g=setup();
  const pointer=JSON.parse(g.store.get(g.refs[0].key));
  pointer.storedAt=new Date(NOW-31*86400000).toISOString();
  g.store.set(g.refs[0].key,JSON.stringify(pointer));
  assert.equal((await publicEvents(new Request(URL),g.env,NOW)).status,503);
});
test("rejects duplicates, no private roster or provider calls",async()=>{
  const f=setup(150);
  const event=f.events[100];event.id=f.events[0].id;
  f.add(2);
  assert.equal((await publicEvents(new Request(URL),f.env,NOW)).status,503);
  assert.deepEqual(f.calls.put,[]);
});
test("public GET ignores browser tracking parameters, other methods fail",async()=>{
  const f=setup(150);
  const r=await publicEvents(new Request(URL+"?utm_source=chatgpt"),f.env,NOW);
  assert.equal(r.status,200);
  const p=await publicEvents(new Request(URL,{method:"POST"}),f.env,NOW);
  assert.equal(p.status,405);assert.equal(f.calls.get.length>0,true);
});
