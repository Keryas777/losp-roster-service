import test from "node:test";
import assert from "node:assert/strict";
import {dispatchCompleteRosterCampaign} from "../src/roster-github-dispatch.js";
import {campaignCompleteKey} from "../src/private-roster-batches.js";

const a="a".repeat(64),b="b".repeat(64),digest="c".repeat(64);
const slot={date:"2026-10-28",campaign:"2026-10-28-am",tick:60};
function ready(fp){
  const runId="01234567-89ab-cdef-0123-456789abcdef";
  return {version:1,campaign:slot.campaign,
    progress:{version:1,fingerprint:fp,campaign:slot.campaign,
      runId,membershipDigest:digest,completed:1,totalEligible:1,
      selfCompleted:true},
    manifest:{version:1,fingerprint:fp,runId,membershipDigest:digest,
      capturedAt:"2026-10-28T03:00:00Z",expiresAt:"2099-01-01T00:00:00Z",
      total:2,includesPersonal:true}
  };
}
function fixture(){
  const values=new Map(),calls=[];
  values.set(campaignCompleteKey(a,slot.campaign),JSON.stringify(ready(a)));
  values.set(campaignCompleteKey(b,slot.campaign),JSON.stringify(ready(b)));
  const env={ROSTER_GITHUB_DISPATCH_ENABLED:"true",ROSTER_GITHUB_DISPATCH_TOKEN:"TEST_SECRET",
    CAPTAIN_BUCKET:{
      get:async k=>values.has(k)?{text:async()=>values.get(k)}:null,
      put:async(k,v)=>{values.set(k,v);}
    }};
  const fetchGithub=async(url,options)=>{
    calls.push({url,options});return {status:204};
  };
  return {env,values,calls,fetchGithub};
}
test("dispatch requires both complete R2 receipts and runs exactly once",async()=>{
 const f=fixture();
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub),"dispatched");
 assert.equal(f.calls.length,1);
 assert.match(f.calls[0].url,/github\.com\/repos\/Keryas777\/msf\/actions\/workflows/);
 assert.equal(f.calls[0].options.headers.Authorization,"Bearer TEST_SECRET");
 const payload=JSON.parse(f.calls[0].options.body);
 assert.deepEqual(payload,{ref:"main",inputs:{
   date:"2026-10-28",period:"am",publish:"true",strict:"true"
 }});
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub),"already-dispatched");
 assert.equal(f.calls.length,1);
 assert.doesNotMatch(JSON.stringify([...f.values]),/TEST_SECRET/);
});
test("an incomplete, missing or malformed R2 receipt never wakes GitHub",async()=>{
 for(const kind of ["missing","partial","wrong-campaign","outside-window"]){
   const f=fixture();
   const key=campaignCompleteKey(b,slot.campaign);
   if(kind==="missing")f.values.delete(key);
   else {
     const data=ready(b);
     if(kind==="partial")data.progress.selfCompleted=false;
     if(kind==="wrong-campaign")data.campaign="2026-10-27-am";
     if(kind==="outside-window")data.manifest.capturedAt="2026-10-28T04:00:00Z";
     f.values.set(key,JSON.stringify(data));
   }
   const result=await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub);
   assert.ok(["awaiting-all","invalid-receipt"].includes(result),result);
   assert.equal(f.calls.length,0);
 }
});
test("no configured token or opt-in means no outgoing Github request",async()=>{
 const f=fixture();
 f.env.ROSTER_GITHUB_DISPATCH_ENABLED="false";
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub),"disabled");
 f.env.ROSTER_GITHUB_DISPATCH_ENABLED="true";
 delete f.env.ROSTER_GITHUB_DISPATCH_TOKEN;
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub),"not-configured");
 assert.equal(f.calls.length,0);
});
test("GitHub rejection does not mark the campaign as dispatched; retry works",async()=>{
 const f=fixture(),fail=async()=>({status:503});
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],fail),"github-unavailable");
 assert.equal(await dispatchCompleteRosterCampaign(f.env,slot,[a,b],f.fetchGithub),"dispatched");
 assert.equal(f.calls.length,1);
});
