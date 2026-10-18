import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";
const jsFile=new URL("../public/admin-pid-diagnostic.js",import.meta.url);
const routesFile=new URL("../src/admin-routes.js",import.meta.url);

async function inspect(){
  const js=await readFile(jsFile,"utf8");
  const start=js.indexOf("const PID_SCHEMA_FIELDS=");
  const end=js.indexOf("\nfunction pidText(",start);
  assert.ok(start>=0 && end>start);
  const pure=js.slice(start,end);
  const analyzer=runInNewContext(pure+"\nanalyzePidCard");
  return {js,analyzer};
}

test("PID diagnosis stays vanilla JS, no token or PID persistence",async()=>{
  const js=await readFile(jsFile,"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.doesNotMatch(js,/innerHTML|localStorage|sessionStorage|console\.|indexedDB/);
  assert.match(js,/credentials:"same-origin"/);
  assert.match(js,/cache:"no-store"/);
  assert.match(js,/resource=player-card&session=/);
  assert.doesNotMatch(js,/url\s*\+\s*raw|url\.searchParams\.set\(["']pid/);
  const routes=await readFile(routesFile,"utf8");
  assert.match(routes,/Diagnostic du PID joueur/);
  assert.match(routes,/admin-pid-diagnostic\.js/);
  assert.match(routes,/id="pid-expected"/);
});

test("analyzer detects verified numeric PID values including undocumented card fields",async()=>{
  const {analyzer}=await inspect();
  const card={
    name:"TestPlayer",tcp:400123123,aid:100,rosterShare:"shared",
    pid:12345678,account:{playerId:"12345678",note:"test"},
    nested:[{uid:"77777777"}],extraField:{secret:"PRIVATE_TOKEN"}
  };
  const result=analyzer(card,"12345678");
  assert.equal(result.name,"TestPlayer");
  assert.deepEqual([...result.matches],["data.pid","data.account.playerId"]);
  assert.deepEqual([...result.unknownFields],["pid","account","nested","extraField"]);
  assert.equal(result.candidates.length,3);
  assert.ok(result.candidates.some(c=>c.field==="data.pid"&&c.value==="12345678"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
});

test("without a known in-game PID, numeric candidate fields are only hypotheses",async()=>{
  const {analyzer}=await inspect();
  const card={name:"TestPlayer",tcp:431716516,aid:1027,xxExtra:"abc",foo:{id:"12345678"}};
  const result=analyzer(card);
  assert.equal(result.matches.length,0);
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].field,"data.foo.id");
  const unrelated=analyzer(card,"50072723");
  assert.equal(unrelated.matches.length,0);
  assert.equal(analyzer(null,"12345678").error,"invalid-card");
});

test("very large nested cards are bounded and unknown values never dumped",async()=>{
  const {analyzer}=await inspect();
  const card={name:"VeryLarge"};
  for(let i=0;i<900;i++)card["f"+i]={anything:"private-information-"+i};
  const result=analyzer(card);
  assert.ok(result.examined<=401);
  assert.ok(result.unknownFields.length<=30);
  assert.doesNotMatch(JSON.stringify(result),/private-information/);
});
