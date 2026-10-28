import test from "node:test";
import assert from "node:assert/strict";
import {dispatchCompleteTrophyCards} from "../src/trophy-github-dispatch.js";
import {trophyCardKey,BATCH_PREFIX} from "../src/private-roster-batches.js";

const fps=Array.from("abcdef",c=>c.repeat(64));
const day="2026-10-22",campaign=day+"-am",slot={date:day,campaign,tick:6};
function pointer(fp){
  return {version:1,kind:"trophy-card-ready",fingerprint:fp,campaign,
    capturedAt:"2026-10-22T02:06:00Z",
    sourceKey:BATCH_PREFIX+fp+
      "/01234567-89ab-cdef-0123-456789abcdef/provider-source/"+
      "00000000-aaaa-4bbb-8ccc-111111111111/alliance-card.json"};
}
function fixture(){
 const store=new Map(),calls=[];
 for(const fp of fps)store.set(trophyCardKey(fp,campaign),JSON.stringify(pointer(fp)));
 const env={TROPHY_GITHUB_DISPATCH_ENABLED:"true",
   ROSTER_GITHUB_DISPATCH_TOKEN:"GITHUB_ONLY_TEST",
   CAPTAIN_BUCKET:{
     get:async k=>store.has(k)?{text:async()=>store.get(k)}:null,
     put:async(k,v)=>store.set(k,v)
   }};
 const github=async(url,opts)=>{calls.push({url,opts});return {status:204};};
 return {store,env,calls,github};
}
test("six approved alliance cards wake GitHub without waiting for any rosters",async()=>{
 const f=fixture();
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,f.github),"dispatched");
 assert.equal(f.calls.length,1);
 const {url,opts}=f.calls[0];
 assert.match(url,/pull-alliance-standings-r2.yml\/dispatches$/);
 assert.equal(opts.headers.Authorization,"Bearer GITHUB_ONLY_TEST");
 assert.deepEqual(JSON.parse(opts.body),{ref:"main",inputs:{
   date:day,publish:"true",early:"true"
 }});
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,f.github),"already-dispatched");
 assert.equal(f.calls.length,1);
 assert.doesNotMatch(JSON.stringify([...f.store]),/GITHUB_ONLY_TEST/);
});
test("no dispatch for missing, stale, forged or invalid markers",async()=>{
 for(const change of ["missing","fingerprint","campaign","old","late","bad-path"]){
  const f=fixture(),k=trophyCardKey(fps[5],campaign);
  if(change==="missing")f.store.delete(k);
  else{
   const m=pointer(fps[5]);
   if(change==="fingerprint")m.fingerprint=fps[4];
   if(change==="campaign")m.campaign="2026-10-21-am";
   if(change==="old")m.capturedAt="2026-10-22T01:59:00Z";
   if(change==="late")m.capturedAt="2026-10-22T04:00:00Z";
   if(change==="bad-path")m.sourceKey="../other.json";
   f.store.set(k,JSON.stringify(m));
  }
  const result=await dispatchCompleteTrophyCards(f.env,slot,fps,f.github);
  assert.ok(["awaiting-all","invalid-marker"].includes(result),change+": "+result);
  assert.equal(f.calls.length,0);
 }
});
test("opt-in and GitHub token must be present",async()=>{
 const f=fixture();
 f.env.TROPHY_GITHUB_DISPATCH_ENABLED="false";
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,f.github),"disabled");
 f.env.TROPHY_GITHUB_DISPATCH_ENABLED="true";
 delete f.env.ROSTER_GITHUB_DISPATCH_TOKEN;
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,f.github),"not-configured");
 assert.equal(f.calls.length,0);
});
test("only Thursday/Saturday AM can publish trophy readings",async()=>{
 const f=fixture();
 assert.equal(await dispatchCompleteTrophyCards(f.env,
   {date:"2026-10-21",campaign:"2026-10-21-am"},fps,f.github),"outside-trophy-day");
 assert.equal(await dispatchCompleteTrophyCards(f.env,
   {date:day,campaign:day+"-pm"},fps,f.github),"outside-trophy-day");
 assert.equal(f.calls.length,0);
});
test("GitHub failures leave no success marker and can retry",async()=>{
 const f=fixture();
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,
   async()=>({status:503})),"github-unavailable");
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,
   async()=>{throw Error("network");}),"github-unavailable");
 assert.equal(await dispatchCompleteTrophyCards(f.env,slot,fps,f.github),"dispatched");
 assert.equal(f.calls.length,1);
});
