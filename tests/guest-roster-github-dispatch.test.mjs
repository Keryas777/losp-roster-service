import test from "node:test";
import assert from "node:assert/strict";
import {dispatchGuestRosterCampaigns,guestRosterDispatchReceiptValid}
  from "../src/guest-roster-github-dispatch.js";
import {campaignCompleteKey} from "../src/private-roster-batches.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";

const marines="a".repeat(64),red="b".repeat(64),losp="c".repeat(64);
const slot={date:"2026-11-06",campaign:"2026-11-06-am",tick:0};
const runId="01234567-89ab-cdef-0123-456789abcdef";
const digest="d".repeat(64);
function receipt(fp,override={}){
  return {version:1,campaign:slot.campaign,
    progress:{version:1,fingerprint:fp,campaign:slot.campaign,
      runId,membershipDigest:digest,completed:1,totalEligible:1,
      selfCompleted:true},
    manifest:{version:1,fingerprint:fp,runId,membershipDigest:digest,
      capturedAt:"2026-11-06T03:05:00Z",expiresAt:"2099-01-01T00:00:00Z",
      total:2,coMembers:1,includesPersonal:true},...override};
}
function fixture(){
  const records=new Map(),calls=[];
  records.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:losp,name:"Zeus"}]}));
  records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
    {fingerprint:marines,allianceKey:"marines"},
    {fingerprint:red,allianceKey:"endgame-revolution-red"}
  ]}));
  for(const fp of [marines,red])
    records.set(campaignCompleteKey(fp,slot.campaign),
      JSON.stringify(receipt(fp)));
  const env={ROSTER_GITHUB_DISPATCH_ENABLED:"true",
    ROSTER_GITHUB_DISPATCH_TOKEN:"TEST_GITHUB_TOKEN",
    CAPTAIN_BUCKET:{
      get:async key=>records.has(key)?
        {size:records.get(key).length,text:async()=>records.get(key)}:null,
      put:async(key,raw)=>records.set(key,raw)
    }};
  const fetchGithub=async(url,options)=>{calls.push({url,options});return {status:204};};
  return {env,records,calls,fetchGithub};
}
test("each approved guest triggers its own serializable GitHub workflow",async()=>{
  const f=fixture();
  const result=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
  assert.equal(result.status,"ok");
  assert.equal(result.dispatched,2);
  assert.equal(f.calls.length,2);
  const names=[];
  for(const call of f.calls){
    const json=JSON.parse(call.options.body);
    names.push(json.inputs.guest_alliance);
    assert.equal(json.ref,"main");
    assert.equal(json.inputs.publish,"true");
    assert.equal(json.inputs.strict,"true");
    assert.equal(json.inputs.date,slot.date);
    assert.equal(call.options.headers.Authorization,"Bearer TEST_GITHUB_TOKEN");
    assert.ok(!call.options.body.includes(marines));
    assert.ok(!call.options.body.includes(red));
  }
  assert.deepEqual(names.sort(),["endgame-revolution-red","marines"]);
  const later=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
  assert.equal(later.already,2);
  assert.equal(f.calls.length,2);
});
test("a guest is independent of missing LoSP and of another incomplete guest",async()=>{
  const f=fixture();
  f.records.delete(campaignCompleteKey(red,slot.campaign));
  const result=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
  assert.equal(result.dispatched,1);
  assert.equal(result.awaiting,1);
  assert.equal(JSON.parse(f.calls[0].options.body).inputs.guest_alliance,"marines");
});
test("invalid, expired, partial or wrong-campaign receipt does not dispatch",async()=>{
  const f=fixture();
  for(const failure of [
    {...receipt(marines),campaign:"2026-11-05-am"},
    {...receipt(marines),progress:{...receipt(marines).progress,selfCompleted:false}},
    {...receipt(marines),manifest:{...receipt(marines).manifest,
      capturedAt:"2026-11-06T04:00:00Z"}},
    {...receipt(marines),manifest:{...receipt(marines).manifest,
      expiresAt:"2026-11-05T12:00:00Z"}},
  ])assert.equal(guestRosterDispatchReceiptValid(failure,marines,slot),false);
  f.records.set(campaignCompleteKey(marines,slot.campaign),
    JSON.stringify(receipt(marines,{campaign:"2026-11-05-am"})));
  f.records.delete(campaignCompleteKey(red,slot.campaign));
  const r=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
  assert.equal(r.dispatched,0);
  assert.equal(f.calls.length,0);
});
test("revoked, unbound, LoSP-overlapping and unconfigured approvals fail closed",async()=>{
  for(const kind of ["revoked","unbound","owned"]){
    const f=fixture();
    f.records.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[
      ...(kind==="revoked"?[]:[{
        fingerprint:kind==="owned"?losp:marines,
        ...(kind==="unbound"?{}:{allianceKey:"marines"})
      }])]}));
    const r=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
    assert.equal(r.status,"no-bound-guests");
    assert.equal(f.calls.length,0);
  }
  const disabled=fixture();
  delete disabled.env.ROSTER_GITHUB_DISPATCH_TOKEN;
  assert.equal((await dispatchGuestRosterCampaigns(disabled.env,slot,
    disabled.fetchGithub)).status,"not-configured");
  assert.equal(disabled.calls.length,0);
});
test("GitHub rejects an import: marker not written, later tick retries",async()=>{
  const f=fixture();
  f.records.delete(campaignCompleteKey(red,slot.campaign));
  const fail=async()=>({status:503});
  const first=await dispatchGuestRosterCampaigns(f.env,slot,fail);
  assert.equal(first.failed,1);
  assert.equal(first.dispatched,0);
  const second=await dispatchGuestRosterCampaigns(f.env,slot,f.fetchGithub);
  assert.equal(second.dispatched,1);
});
test("separate recovery receipts are accepted only within their UTC day",()=>{
  const late=receipt(marines,{
    manualRecovery:true,
    progress:{...receipt(marines).progress,manualRecovery:true},
    manifest:{...receipt(marines).manifest,
      capturedAt:"2026-11-06T11:00:00Z"}
  });
  assert.equal(guestRosterDispatchReceiptValid(late,marines,slot),true);
  assert.equal(guestRosterDispatchReceiptValid({...late,
    manifest:{...late.manifest,capturedAt:"2026-11-06T14:00:00Z"}},
    marines,slot),false);
});
