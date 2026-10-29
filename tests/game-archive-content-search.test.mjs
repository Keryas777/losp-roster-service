import {test} from "node:test";
import assert from "node:assert/strict";
import {handleGameArchiveContentSearch} from "../src/game-archive-content-search.js";
import {handleAdmin} from "../src/admin-routes.js";
import {GAME_ARCHIVE_ROOT} from "../src/game-catalog-archive.js";

const RUN="ced5b23f-504c-428b-9ca8-02171f2a21ef";
const NOW=Date.parse("2026-10-29T12:00:00.000Z");
const FRESH=new Date("2026-10-28T13:00:00.000Z");
const OLD=new Date("2026-07-01T12:00:00.000Z");
const BASE="https://losp-roster-service.deliriousfan7.workers.dev";
const ENDPOINT=BASE+"/admin/api/game-archive-content-search";
const PREFIX=GAME_ARCHIVE_ROOT+"runs/"+RUN+"/objects/";
const hash=async data=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(data)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
function fixture(){
  const stored=new Map(),calls={get:[],list:[],writes:0};
  const bucket={
    get:async key=>{
      calls.get.push(key);
      const entry=stored.get(key);
      return entry?{size:Buffer.byteLength(entry.raw),uploaded:entry.uploaded,
        text:async()=>entry.raw}:null;
    },
    list:async opts=>{
      calls.list.push(opts);
      const keys=[...stored.keys()].filter(key=>key.startsWith(opts.prefix)).sort();
      const offset=opts.cursor?Number(opts.cursor):0;
      const slice=keys.slice(offset,offset+opts.limit);
      return {objects:slice.map(key=>({
        key,size:Buffer.byteLength(stored.get(key).raw),
        uploaded:stored.get(key).uploaded
      })),truncated:offset+slice.length<keys.length,
      cursor:String(offset+slice.length)};
    },
    put:async()=>{calls.writes++;throw Error("read-only")},
    delete:async()=>{calls.writes++;throw Error("read-only")}
  };
  stored.set(GAME_ARCHIVE_ROOT+"active.json",{raw:JSON.stringify({runId:RUN}),uploaded:FRESH});
  async function add(doc,opts={}){
    const raw=typeof doc==="string"?doc:JSON.stringify(doc);
    const sha=await hash(raw);
    const key=PREFIX+(opts.sha||sha)+".json";
    stored.set(key,{raw,uploaded:opts.uploaded||FRESH});
    return {key,sha:opts.sha||sha};
  }
  return {stored,calls,env:{CAPTAIN_BUCKET:bucket},add};
}
async function query(f,q,now=NOW){
  return handleGameArchiveContentSearch(new Request(ENDPOINT+"?"+q),f.env,now);
}

test("searches original orphan blobs by JSON content, not by URL receipt",async()=>{
  const f=fixture();
  const item=await f.add({data:{type:"resource",internalId:"ability_material_green",
    values:{green:17}}});
  const response=await query(f,"q=ability_material_");
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.status,"complete");
  assert.equal(data.matches.length,1);
  assert.equal(data.matches[0].sha256,item.sha);
  assert.equal(data.matches[0].provenance,"original-request-unverified");
  assert.ok(data.matches[0].excerpts[0].includes("ability_material_green"));
  assert.equal(data.matches[0].payload,undefined);
  assert.equal(data.stats.searched,1);
  assert.ok(f.calls.list.every(x=>x.prefix===PREFIX));
  assert.equal(f.calls.writes,0);
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
});

test("finds all four distinct verified ability-material identifiers",async()=>{
  const f=fixture();
  await f.add({data:{items:[
    {item:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}},
    {item:{id:"ABILITY_MATERIAL_BLUE_ABILITY_MAT"}},
    {item:{id:"ABILITY_MATERIAL_PURPLE_ABILITY_MAT"}},
    {item:{id:"ABILITY_MATERIAL_ORANGE_ABILITY_MAT"}},
    {item:{id:"ABILITY_MATERIAL_GREEN_ABILITY_MAT"}}
  ]}});
  const response=await query(f,"q=ability_material_");
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.matches.length,1);
  assert.deepEqual(result.matches[0].materialIds,[
    "ABILITY_MATERIAL_BLUE_ABILITY_MAT",
    "ABILITY_MATERIAL_GREEN_ABILITY_MAT",
    "ABILITY_MATERIAL_ORANGE_ABILITY_MAT",
    "ABILITY_MATERIAL_PURPLE_ABILITY_MAT"
  ]);
});

test("only content SHA-256 and date-verified matches can open their full JSON",async()=>{
  const f=fixture();
  const expected={data:{id:"ability_material_orange",quantity:1000}};
  const item=await f.add(expected);
  const result=await (await query(f,"sha="+item.sha)).json();
  assert.equal(result.status,"found");
  assert.deepEqual(result.payload,expected);
  assert.equal(result.provenance,"original-request-unverified");
  assert.ok(!JSON.stringify(result).includes(PREFIX));
  const forged=await f.add({data:{id:"ability_material_blue"}},{sha:"f".repeat(64)});
  const bad=await query(f,"sha="+forged.sha);
  assert.equal(bad.status,404);
  assert.equal((await bad.json()).reason,"unverified");
});

test("bounded pagination, controlled prefix and no accidental R2 reads",async()=>{
  const f=fixture();
  for(let i=0;i<31;i++)await f.add({data:{id:"Other"+i}});
  f.stored.set("oauth-captains/v1/secret.json",{raw:JSON.stringify({
    data:{id:"ability_material_blue",secret:"PASSWORD"}}),uploaded:FRESH});
  const first=await (await query(f,"q=ability_material_blue")).json();
  assert.equal(first.status,"searching");
  assert.equal(first.stats.listed,30);
  assert.equal(first.matches.length,0);
  const next=await (await query(f,"q=ability_material_blue&cursor="+first.nextCursor)).json();
  assert.equal(next.status,"complete");
  assert.equal(next.stats.listed,1);
  assert.equal(next.matches.length,0);
  assert.ok(f.calls.list.every(x=>x.prefix===PREFIX&&x.limit===30));
  assert.ok(!f.calls.get.includes("oauth-captains/v1/secret.json"));
});

test("never inspect old or oversized archived objects",async()=>{
  const f=fixture();
  const expired=await f.add({data:{id:"ability_material_purple"}},{uploaded:OLD});
  const huge=await f.add({data:{id:"ability_material_orange",
    large:"X".repeat(760_000)}});
  const out=await (await query(f,"q=ability_material_")).json();
  assert.equal(out.matches.length,0);
  assert.equal(out.stats.expired,1);
  assert.equal(out.stats.tooLarge,1);
  assert.equal(out.stats.searched,0);
  assert.ok(!f.calls.get.includes(expired.key));
  assert.ok(!f.calls.get.includes(huge.key));
});

test("missing original receipt does not fabricate provenance, incorrect hash is excluded",async()=>{
  const f=fixture();
  const invalid=await f.add({data:{id:"ability_material_green"}},{sha:"a".repeat(64)});
  const good=await f.add({data:{id:"ability_material_purple"}});
  const result=await (await query(f,"q=ability_material_")).json();
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].sha256,good.sha);
  assert.equal(result.stats.unverified,1);
  assert.ok(!result.matches.some(x=>x.sha256===invalid.sha));
});

test("rejects unsafe query input before any R2 access",async()=>{
  const f=fixture();
  for(const suffix of ["?q=%2Fplayer%2Fv1%2Froster","?q=x","?q=abc&prefix=oauth-captains",
    "?q=abc&cursor=..%2F","?sha=%2Fprivate","?sha="+("x".repeat(64))]){
    const result=await query(f,suffix.slice(1));
    assert.equal(result.status,400);
  }
  assert.equal(f.calls.get.length,0);
  assert.equal(f.calls.list.length,0);
});

test("existing Access gate rejects search before reading archive",async()=>{
  const f=fixture();
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const result=await handleAdmin(new Request(ENDPOINT+"?q=ability_material_"),env);
  assert.equal(result.status,403);
  assert.equal(f.calls.get.length,0);
});

test("new controls are in the existing Archives R2 UI with safe DOM rendering",async()=>{
  const {readFile}=await import("node:fs/promises");
  const html=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const client=await readFile(new URL("../public/admin-game-archive-content-search.js",import.meta.url),"utf8");
  assert.ok(html.includes('id="game-content-query"'));
  assert.ok(html.includes('src="/admin-game-archive-content-search.js"'));
  assert.ok(html.includes('pathname==="/admin/api/game-archive-content-search"'));
  assert.ok(client.includes("/admin/api/game-archive-content-search?"));
  assert.ok(client.includes("textContent"));
  assert.ok(!client.includes("innerHTML"));
});
