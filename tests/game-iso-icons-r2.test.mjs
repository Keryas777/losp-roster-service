import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {inspectIsoIconsR2,handleGameIsoIconsR2} from "../src/game-iso-icons-r2.js";
import {handleAdmin} from "../src/admin-routes.js";

const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=HOST+"/admin/api/game-iso-icons-r2";
const ROOT="game-archive/v1/";
const GAME="/game/v1/iso8Abilities";
const RUN="12345678-1234-4234-8234-123456789abc";
const AT=Date.parse("2026-10-29T10:00:00Z");
const stamp=new Date(AT-3600000).toISOString();
const checksum=s=>createHash("sha256").update(s).digest("hex");
const official=name=>"https://assets.marvelstrikeforce.com/imgs/"+
  "ICON_EXTRA_ABILITY_ISO8_"+name+"_4_ae128ffa.png";
function fixture(){
  const db=new Map(),calls=[],uploads=new Map();
  const put=(key,value)=>db.set(key,JSON.stringify(value));
  const bucket={
    get:async key=>{
      calls.push(["get",key]);
      const content=db.get(key);
      return content===undefined?null:{size:content.length,text:async()=>content};
    },
    head:async key=>{
      calls.push(["head",key]);
      const raw=db.get(key);
      return raw===undefined?null:{size:raw.length,
        uploaded:new Date(uploads.get(key)||stamp)};
    },
    list:async()=>{throw Error("unexpected R2 listing");},
    put:async()=>{throw Error("unexpected R2 write");},
    delete:async()=>{throw Error("unexpected R2 deletion");}
  };
  const archive=(path,data,properties={})=>{
    const sha=checksum(JSON.stringify(data));
    const objectKey=ROOT+"diff/runs/"+RUN+"/objects/"+sha+".json";
    const ordinal=[GAME,...["striker","raider","skirmisher","healer",
      "fortifier"].map(id=>GAME+"/"+id)].indexOf(path)+1;
    const receiptKey=ROOT+"diff/runs/"+RUN+"/checks/"+
      String(ordinal).padStart(8,"0")+".json";
    // Shared immutable fixture object and receipt are fine for one route.
    put(objectKey,{data,meta:{asOf:"PRIVATE_METADATA"}});
    const receipt={version:2,path,status:"changed",sha256:sha,
      objectKey,checkedAt:stamp,storedAt:stamp,...properties};
    put(receiptKey,receipt);
    const pointer={version:2,path,sha256:sha,objectKey,receiptKey,
      checkedAt:stamp,storedAt:stamp,...properties};
    put(ROOT+"diff/latest/"+checksum(path)+".json",pointer);
    return {pointer,receipt};
  };
  return {db,put,bucket,calls,uploads,archive};
}
const get=(f,url=ENDPOINT)=>handleGameIsoIconsR2(new Request(url),{
  CAPTAIN_BUCKET:f.bucket},AT);

test("read-only ISO-8 root returns five real-looking tier-four URLs without player data",async()=>{
  const f=fixture(),classes=["striker","raider","skirmisher","healer","fortifier"];
  const data=Object.fromEntries(classes.map(id=>[id,{name:"PRIVATE_NAME",
    icons:["", "", "", "", official(id.toUpperCase())]}]));
  f.archive(GAME,data);
  const res=await get(f),body=await res.json();
  assert.equal(res.status,200);
  assert.equal(body.status,"ok");
  assert.equal(body.source,"private-r2-only");
  assert.equal(body.classes.length,5);
  assert.ok(body.classes.every(c=>c.tier4.status==="official-url"));
  assert.deepEqual(body.classes.map(c=>c.tier4.url),
    classes.map(x=>official(x.toUpperCase())));
  assert.ok(body.classes.every(x=>x.sourcePath===GAME));
  assert.equal(body.sources.length,6);
  assert.equal(body.sources.filter(x=>x.status==="not-indexed").length,5);
  assert.ok(f.calls.length<=8);
  assert.ok(f.calls.every(c=>c[0]==="get"&&c[1].startsWith(ROOT)));
  const output=JSON.stringify(body);
  assert.doesNotMatch(output,/PRIVATE_NAME|PRIVATE_METADATA|oauth-captains|roster-batches/);
  assert.match(res.headers.get("cache-control"),/no-store/);
});

test("verified detail wins over root; nonofficial image URLs are never exposed",async()=>{
  const f=fixture();
  const bad="https://unsafe.invalid/SECRET_ACCESS_TOKEN.png";
  f.archive(GAME,{striker:{icons:[null,null,null,null,bad]},
    raider:{icons:[null,null,null,null,bad]}});
  f.archive(GAME+"/striker",{icons:[null,null,null,null,official("STRIKER")]});
  const a=await get(f);
  const entries=(await a.json()).classes;
  const first=entries.find(x=>x.id==="striker");
  assert.equal(first.tier4.url,official("STRIKER"));
  assert.equal(first.sourcePath,GAME+"/striker");
  const rejected=entries.find(x=>x.id==="raider");
  assert.equal(rejected.tier4.url,null);
  assert.equal(rejected.tier4.status,"unrecognized-url");
  assert.doesNotMatch(JSON.stringify(entries),/SECRET_ACCESS_TOKEN/);
});

test("tampered and expired pointers fail closed with no fallback Scopely request",async()=>{
  const f=fixture();
  const {pointer}=f.archive(GAME,{striker:{icons:[null,null,null,null,official("STRIKER")]}});
  f.put(ROOT+"diff/latest/"+checksum(GAME)+".json",
    {...pointer,objectKey:"roster-batches/v1/PRIVATE_SECRET"});
  let result=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(result.sources[0].status,"invalid-pointer");
  assert.equal(result.classes[0].tier4.url,null);
  f.archive(GAME,{striker:{icons:[null,null,null,null,official("STRIKER")]}},
    {storedAt:"2026-08-01T00:00:00Z"});
  result=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(result.sources[0].status,"expired");
  assert.equal(result.classes[0].tier4.url,null);
  const report=JSON.stringify(result);
  assert.doesNotMatch(report,/PRIVATE_SECRET|oauth|Bearer/);
});

test("legacy V1 pointers are diagnosed from actual R2 bytes and upload date",async()=>{
  const f=fixture();
  const data={striker:{icons:[null,null,null,null,official("STRIKER")]}};
  const raw=JSON.stringify({data});
  const storedSha=checksum(raw);
  const objectKey=ROOT+"runs/"+RUN+"/objects/"+storedSha+".json";
  f.db.set(objectKey,raw);
  // Historical V1 could record the observed hash rather than the stored hash.
  f.put(ROOT+"diff/latest/"+checksum(GAME)+".json",{
    version:1,path:GAME,sha256:"a".repeat(64),objectKey,
    checkedAt:stamp,runId:RUN
  });
  const result=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(result.sources[0].status,"legacy-byte-verified");
  assert.equal(result.sources[0].provenance,"legacy-path-not-receipt-certified");
  assert.equal(result.classes[0].tier4.url,official("STRIKER"));
  assert.equal(result.classes[0].sourceStatus,"legacy-byte-verified");
  assert.equal(result.classes[0].observedHashMatchesStorage,false);
  assert.ok(f.calls.some(([action,key])=>action==="head"&&key===objectKey));
  assert.ok(f.calls.every(([action,key])=>
    ["get","head"].includes(action)&&key.startsWith(ROOT)));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_NAME|PRIVATE_TOKEN|roster-batches/);
});

test("legacy pointers reject mismatched bytes, missing upload timestamp, and expired data",async()=>{
  const f=fixture();
  const data={striker:{icons:[null,null,null,null,official("STRIKER")]}};
  const raw=JSON.stringify({data}),storedSha=checksum(raw);
  const objectKey=ROOT+"runs/"+RUN+"/objects/"+storedSha+".json";
  const pointerKey=ROOT+"diff/latest/"+checksum(GAME)+".json";
  f.db.set(objectKey,raw);
  f.put(pointerKey,{version:1,path:GAME,sha256:storedSha,
    objectKey,checkedAt:stamp,runId:RUN});
  f.db.set(objectKey,raw+" ");
  let report=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(report.sources[0].status,"legacy-content-hash-mismatch");
  assert.equal(report.classes[0].tier4.url,null);
  f.db.set(objectKey,raw);
  f.uploads.set(objectKey,"2026-08-01T00:00:00Z");
  report=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(report.sources[0].status,"legacy-upload-date-unavailable-or-expired");
  assert.equal(report.classes[0].tier4.url,null);
  f.uploads.delete(objectKey);
  f.put(pointerKey,{version:1,path:GAME,sha256:storedSha,
    objectKey,checkedAt:"2026-08-01T00:00:00Z",runId:RUN});
  report=await inspectIsoIconsR2(f.bucket,AT);
  assert.equal(report.sources[0].status,"legacy-expired");
  assert.equal(report.classes[0].tier4.url,null);
});

test("R2 structure diagnostics distinguish missing icons from nested fields without exposing values",async()=>{
  const f=fixture();
  const data={striker:{name:"PRIVATE_NAME_OF_ABILITY",
    ability:{icons:[null,null,null,null,official("STRIKER")]},
    nested:{asset:"SECRET_ASSET_VALUE"}},
    raider:{name:"PRIVATE_RAIDER_NAME",icons:[]}};
  f.archive(GAME,data);
  const response=await get(f),report=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(report.rootStructure.fields,["striker","raider"]);
  const striker=report.classes.find(x=>x.id==="striker");
  assert.equal(striker.status,"missing-icons");
  assert.equal(striker.structure.root.kind,"object");
  assert.equal(striker.structure.root.iconsKind,"undefined");
  assert.deepEqual(striker.structure.root.fields,["name","ability","nested"]);
  assert.deepEqual(striker.structure.root.children.find(x=>x.field==="ability").fields,
    ["icons"]);
  assert.equal(striker.tier4.url,null);
  const raider=report.classes.find(x=>x.id==="raider");
  assert.equal(raider.status,"ok");
  assert.equal(raider.structure.root.iconsKind,"array");
  assert.equal(raider.iconCount,0);
  assert.equal(raider.tier4.url,null);
  assert.doesNotMatch(JSON.stringify(report),
    /PRIVATE_NAME_OF_ABILITY|PRIVATE_RAIDER_NAME|SECRET_ASSET_VALUE|ICON_EXTRA_ABILITY_ISO8_STRIKER_4/);
  assert.ok(f.calls.every(([action,key])=>["get","head"].includes(action)&&
    key.startsWith(ROOT)));
});

test("HTTP methods, query strings and missing storage reject requests",async()=>{
  const f=fixture();
  assert.equal((await handleGameIsoIconsR2(new Request(ENDPOINT,{method:"POST"}),
    {CAPTAIN_BUCKET:f.bucket},AT)).status,405);
  assert.equal((await get(f,ENDPOINT+"?key=anything")).status,400);
  assert.equal((await handleGameIsoIconsR2(new Request(ENDPOINT),{},AT)).status,503);
  assert.deepEqual(f.calls,[]);
  // Gate must reject unauthenticated requests before touching the bucket.
  const protectedResponse=await handleAdmin(new Request(ENDPOINT),{CAPTAIN_BUCKET:f.bucket});
  assert.notEqual(protectedResponse.status,200);
  assert.deepEqual(f.calls,[]);
});

test("private admin is wired and UI never triggers a Scopely request",async()=>{
  const [routes,ui]=await Promise.all([
    readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8"),
    readFile(new URL("../public/admin-game-iso-icons-r2.js",import.meta.url),"utf8")
  ]);
  assert.match(routes,/handleGameIsoIconsR2\(request,env\)/);
  assert.match(routes,/admin-game-iso-icons-r2\.js/);
  assert.ok(routes.includes("/admin-game-iso-icons-r2.js?v=20261029b"));
  assert.match(ui,/raider:"Fantassin"/);
  assert.match(ui,/skirmisher:"Tirailleur"/);
  assert.doesNotMatch(ui,/raider:"Pillard"|skirmisher:"Escarmoucheur"/);
  assert.match(ui,/Structure du JSON R2 principal/);
  assert.match(routes,/id="game-iso-r2-check"/);
  assert.match(routes,/img-src https:\/\/assets\.marvelstrikeforce\.com/);
  assert.match(ui,/\/admin\/api\/game-iso-icons-r2/);
  assert.doesNotMatch(ui,/api\.marvelstrikeforce\.com|\/login\/|\/player\/v1\/|setInterval/);
});
