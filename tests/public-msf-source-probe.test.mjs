import {test} from "node:test";
import assert from "node:assert/strict";
import {handleAdmin} from "../src/admin-routes.js";
import {handlePublicSourceProbe,PUBLIC_SOURCE_ROUTES,PUBLIC_SOURCE_ROOT,
  PUBLIC_SOURCE_MAX_BYTES} from "../src/public-msf-source-probe.js";

const base="https://losp-roster-service.deliriousfan7.workers.dev";
const endpoint=base+"/admin/api/msf-secondary-probe";
const req=(body,origin=base)=>new Request(endpoint,{method:"POST",
  headers:{Origin:origin,"Content-Type":"application/json"},
  body:JSON.stringify(body)});
const now=Date.UTC(2026,9,19,14);
function fixture(){
 const stored=new Map(),calls=[];
 const env={CAPTAIN_BUCKET:{
   get:async key=>stored.has(key)?{text:async()=>stored.get(key)}:null,
   createMultipartUpload:async key=>{
     const chunks=new Map();
     return {
       uploadPart:async(i,data)=>{
         chunks.set(i,new Uint8Array(data));return {partNumber:i,etag:"test-"+i};
       },
       complete:async parts=>{
         const bytes=new Uint8Array(parts.reduce((n,p)=>n+chunks.get(p.partNumber).length,0));
         let offset=0;
         for(const p of parts){const c=chunks.get(p.partNumber);bytes.set(c,offset);offset+=c.length;}
         stored.set(key,new TextDecoder().decode(bytes));
       },
       abort:async()=>{}
     };
   },
   put:async(key,raw)=>{stored.set(key,typeof raw==="string"?raw:
     new TextDecoder().decode(raw))}
 }};
 const provider=async(url,opts)=>{
   calls.push({url,opts});
   assert.equal(opts.method,"GET");
   assert.equal(new URL(url).host,"api-prod.marvelstrikeforce.com");
   assert.equal(opts.headers.Authorization,undefined);
   assert.equal(opts.headers.Cookie,undefined);
   return new Response('{"data":[{"raw":"preserved"}],"meta":{"unknown":{"deep":true}},"newField":[9,3]}',{
     status:200,headers:{"Content-Type":"application/json"}
   });
 };
 return {env,stored,calls,provider};
}
test("only 11 researched secondary read-only services are allowlisted",()=>{
 assert.equal(PUBLIC_SOURCE_ROUTES.length,11);
 assert.ok(PUBLIC_SOURCE_ROUTES.every(r=>r.path.startsWith("/services/api/")));
 assert.equal(new Set(PUBLIC_SOURCE_ROUTES.map(r=>r.id)).size,11);
 assert.ok(PUBLIC_SOURCE_ROUTES.every(r=>!r.path.includes("{")&&!r.path.includes("..")));
});
test("archives the FULL byte-exact site response as immutable private R2 object",async()=>{
 const f=fixture(),id="get-character-list";
 const reply=await handlePublicSourceProbe(req({id}),f.env,f.provider,now);
 assert.equal(reply.status,200);
 const body=await reply.json();
 assert.equal(body.status,"archived");
 assert.equal(body.source,id);
 assert.equal(body.httpStatus,200);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].url,
   "https://api-prod.marvelstrikeforce.com/services/api/getCharacterList?lang=fr");
 const latest=JSON.parse(f.stored.get(PUBLIC_SOURCE_ROOT+id+"/latest.json"));
 assert.match(latest.sha256,/^[a-f0-9]{64}$/);
 assert.equal(latest.bytes,body.bytes);
 const raw=f.stored.get(latest.key);
 assert.equal(raw,'{"data":[{"raw":"preserved"}],"meta":{"unknown":{"deep":true}},"newField":[9,3]}');
 assert.equal(JSON.parse(raw).meta.unknown.deep,true);
 assert.ok(!JSON.stringify(body).includes("raw"));
 assert.ok(!JSON.stringify(body).includes("preserved"));
 assert.ok(!JSON.stringify(body).includes("newField"));
});
test("cooldown prevents repetitive probes, identical provider payload deduplicates archive",async()=>{
 const f=fixture(),id="get-gear";
 assert.equal((await (await handlePublicSourceProbe(req({id}),f.env,f.provider,now)).json()).status,"archived");
 const archive=f.stored.get(PUBLIC_SOURCE_ROOT+id+"/latest.json");
 const retry=await (await handlePublicSourceProbe(req({id}),f.env,f.provider,now+60000)).json();
 assert.equal(retry.status,"cooldown");
 assert.equal(f.calls.length,1);
 assert.equal((await (await handlePublicSourceProbe(req({id}),f.env,f.provider,now+11*60000)).json()).status,"archived");
 assert.equal(f.calls.length,2);
 assert.equal(f.stored.get(PUBLIC_SOURCE_ROOT+id+"/latest.json")!==archive,true);
 assert.equal([...f.stored.keys()].filter(k=>k.includes("/sha256-")).length,1);
});
test("429 never archives, but large source bytes are preserved with unindexed receipt",async()=>{
 const f=fixture(),id="get-upgrade-tokens";
 const forbidden=async()=>new Response("nope",{status:429});
 const first=await (await handlePublicSourceProbe(req({id}),f.env,forbidden,now)).json();
 assert.equal(first.status,"rate-limited");
 assert.equal(first.httpStatus,429);
 assert.equal([...f.stored.keys()].some(k=>k.includes("/sha256-")),false);
 const big=JSON.stringify({data:["X".repeat(PUBLIC_SOURCE_MAX_BYTES+10)]});
 const next=await (await handlePublicSourceProbe(req({id:"get-traits"}),f.env,
   async()=>new Response(big),now)).json();
 assert.equal(next.status,"archived-unindexed");
 assert.equal(next.bytes,new TextEncoder().encode(big).length);
 const latest=JSON.parse(f.stored.get(PUBLIC_SOURCE_ROOT+"get-traits/latest.json"));
 assert.equal(latest.indexed,false);
 assert.equal(f.stored.get(latest.key),big);
 assert.equal(latest.sha256,null);
});
test("unknown URLs, non-JSON request and foreign origin fail before outbound GET",async()=>{
 const f=fixture();
 for(const [request,code] of [
   [new Request(endpoint),405],
   [req({id:"../../api/secret"}),400],
   [req({id:"get-traits",path:"/secret"}),400],
   [req({id:"get-traits"},"https://evil.invalid"),403],
   [new Request(endpoint,{method:"POST",headers:{Origin:base,
     "Content-Type":"application/json"},body:"!"}),400]
 ]){
   const res=await handlePublicSourceProbe(request,f.env,f.provider,now);
   assert.equal(res.status,code);
 }
 assert.equal(f.calls.length,0);
 assert.equal(f.stored.size,0);
});
test("the admin route requires a valid Cloudflare Access JWT before testing secondary sources",async()=>{
 const f=fixture();
 const env={...f.env,MSF_ADMIN_ENABLED:"true",
   CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
   CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
 const response=await handleAdmin(req({id:"get-traits"}),env,f.provider);
 assert.equal(response.status,403);
 assert.equal(f.calls.length,0);
 assert.equal(f.stored.size,0);
});
