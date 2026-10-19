import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext,Script} from "node:vm";
import {PUBLIC_SOURCE_ROUTES} from "../src/public-msf-source-probe.js";

const jsFile=new URL("../public/admin-secondary-probes.js",import.meta.url);
const adminFile=new URL("../src/admin-routes.js",import.meta.url);

async function setup(provider){
  const events=new Map();
  const element=(name)=>({name,disabled:false,textContent:"",
    addEventListener:(_type,cb)=>events.set(name,cb)});
  const elements={
    "msf-secondary-source":{...element("msf-secondary-source"),
      value:"get-character-list",options:PUBLIC_SOURCE_ROUTES.map(r=>({value:r.id}))},
    "msf-secondary-probe":element("msf-secondary-probe"),
    "msf-secondary-result":element("msf-secondary-result"),
    "msf-secondary-batch":element("msf-secondary-batch"),
    "msf-secondary-batch-status":element("msf-secondary-batch-status"),
    "msf-secondary-batch-results":{children:[],
      replaceChildren(){this.children=[]},
      appendChild(node){this.children.push(node)}}
  };
  const calls=[];
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    assert.equal(url,"/admin/api/msf-secondary-probe");
    assert.equal(opts.method,"POST");
    assert.equal(opts.credentials,"same-origin");
    assert.equal(opts.headers.Authorization,undefined);
    return provider(JSON.parse(opts.body).id,calls.length);
  };
  const script=await readFile(jsFile,"utf8");
  runInNewContext(script,{
    document:{getElementById:id=>elements[id]||null,
      createElement:tag=>({tag,textContent:""})},fetch,
    Set,Array,Number,Math,JSON,Error
  });
  return {elements,events,calls};
}

test("all nine complementary services are audited in one admin action, with archive progress",async()=>{
 const f=await setup(async()=>({ok:true,json:async()=>({
   status:"archived",httpStatus:200,bytes:350,sha256:"a".repeat(64)
 })}));
 await f.events.get("msf-secondary-batch")();
 const ids=f.calls.map(x=>JSON.parse(x.opts.body).id);
 assert.equal(ids.length,9);
 assert.equal(new Set(ids).size,9);
 assert.ok(!ids.includes("get-character-list"));
 assert.ok(!ids.includes("get-localization-heroes"));
 assert.equal(f.elements["msf-secondary-batch-results"].children.length,9);
 assert.match(f.elements["msf-secondary-batch-status"].textContent,/9\/9 services examinés, 9 archivés/);
 assert.equal(f.elements["msf-secondary-batch"].disabled,false);
 assert.equal(f.elements["msf-secondary-probe"].disabled,false);
 assert.equal(f.elements["msf-secondary-source"].disabled,false);
 assert.ok(f.calls.every(x=>JSON.stringify(x.opts).includes('"id"')));
});

test("a 429 stops remaining probes and doesn't send more requests",async()=>{
 const f=await setup(async(_,n)=>({ok:true,json:async()=>n===2?
   {status:"rate-limited",httpStatus:429}:
   {status:"archived",httpStatus:200,bytes:410}
 }));
 await f.events.get("msf-secondary-batch")();
 assert.equal(f.calls.length,2);
 assert.equal(f.elements["msf-secondary-batch-results"].children.length,2);
 assert.match(f.elements["msf-secondary-batch-status"].textContent,/Arrêt anticipé/);
});

test("network failure ends audit safely and resets controls",async()=>{
 const f=await setup(async()=>{throw Error("network")});
 await f.events.get("msf-secondary-batch")();
 assert.equal(f.calls.length,1);
 assert.equal(f.elements["msf-secondary-batch"].disabled,false);
 assert.match(f.elements["msf-secondary-batch-status"].textContent,/Arrêt anticipé/);
 assert.equal(f.elements["msf-secondary-batch-results"].children.length,1);
});

test("single route probing remains available after grouped audit",async()=>{
 const f=await setup(async()=>({ok:true,json:async()=>({
   status:"cooldown",source:"get-character-list",retryAfterSeconds:310
 })}));
 await f.events.get("msf-secondary-batch")();
 await f.events.get("msf-secondary-probe")();
 assert.equal(f.calls.length,10);
 assert.equal(JSON.parse(f.calls.at(-1).opts.body).id,"get-character-list");
 assert.match(f.elements["msf-secondary-result"].textContent,/Prochain test/);
});

test("HTML and vanilla JS use only textContent; no build or privileged browser APIs",async()=>{
 const [route,source]=await Promise.all([
  readFile(adminFile,"utf8"),readFile(jsFile,"utf8")]);
 assert.match(route,/id="msf-secondary-batch"/);
 assert.match(route,/id="msf-secondary-batch-results"/);
 assert.doesNotThrow(()=>new Script(source));
 assert.doesNotMatch(source,/innerHTML|localStorage|sessionStorage|eval\(|window\.location/);
 assert.match(source,/replaceChildren/);
 assert.match(source,/status==="rate-limited"/);
});
