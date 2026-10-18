import {test} from "node:test";
import assert from "node:assert/strict";
import {collectAllianceRosterSample} from "../src/roster-collector.js";
const token="PRIVATE_ACCESS";
const members=[
  {id:"self",isSelf:true,card:{name:"Self",rosterShare:true}},
  {id:"member",isSelf:false,card:{name:"Valid co-member",rosterShare:true}}
];
const chars=(count,power=100)=>Array.from({length:count},(_,i)=>({
  id:"char"+i,power:power+i,gear:20,iso8:{class:"striker"}
}));
const json=(data,meta)=>Response.json({data,meta});
function fixture({count=383,oversized=false,silentCap=false,unchanged=false,changedPower=false,revision=false}={}){
 const calls=[];let memberReads=0,rosterReads=0;
 const actual=chars(count,changedPower?200:100);
 const fetchImpl=async(url,options)=>{
  calls.push(url);
  assert.equal(options.method,"GET");
  assert.equal(options.headers.Authorization,"Bearer "+token);
  if(url.endsWith("/alliance/members")){
   memberReads++;
   return json(revision&&memberReads===2?
     [{...members[0]}, {...members[1],card:{name:"changed",rosterShare:false}}]:
     members,{asOf:"membership"});
  }
  const u=new URL(url);
  assert.ok(u.pathname.includes("/roster/member/member"));
  rosterReads++;
  assert.equal(u.searchParams.get("statsFormat"),"csv");
  assert.equal(u.searchParams.get("charInfo"),"full");
  const paged=u.searchParams.has("perPage");
  const since=u.searchParams.get("since");
  if(unchanged&&since==="PREVIOUS_ASOF")
   return new Response(null,{status:344});
  if(!paged&&oversized)return new Response(null,{status:472});
  if(!paged&&silentCap)return json(actual.slice(0,100),
    {perTotal:count,asOf:"NEW_ASOF"});
  if(!paged)return json(actual,{perTotal:count,asOf:"NEW_ASOF"});
  const page=Number(u.searchParams.get("page"));
  const perPage=Number(u.searchParams.get("perPage"));
  return json(actual.slice((page-1)*perPage,page*perPage),
    {page,perPage,perTotal:count,asOf:"NEW_ASOF"});
 };
 return {calls,fetchImpl,counters:()=>({memberReads,rosterReads})};
}
const opts={maxMembers:1,preferSinglePage:true,
 requireStableMembership:true,requireCurrentMembership:true,
 includeMembershipDigest:true,charInfo:true};
test("Scopely unpaged roster: 383 characters in ONE download, still verify member sharing twice",async()=>{
 const f=fixture();
 const result=await collectAllianceRosterSample(token,f.fetchImpl,opts);
 assert.equal(result.status,"complete");
 assert.equal(result.rosters[0].chars.length,383);
 assert.equal(result.pages,1);
 assert.equal(result.requests,3);
 assert.equal(result.rosters[0].asOf,"NEW_ASOF");
 assert.equal(result.unchangedCount,0);
 assert.deepEqual(f.counters(),{memberReads:2,rosterReads:1});
 const rosterUrl=new URL(f.calls.find(s=>s.includes("/roster/member/")));
 assert.equal(rosterUrl.searchParams.has("perPage"),false);
 assert.equal(rosterUrl.searchParams.has("page"),false);
});
test("unpaged 472 triggers bounded 200-item pagination, not an incomplete roster",async()=>{
 const f=fixture({oversized:true});
 const result=await collectAllianceRosterSample(token,f.fetchImpl,opts);
 assert.equal(result.status,"complete");
 assert.equal(result.rosters[0].chars.length,383);
 assert.equal(result.pages,2);
 assert.equal(result.requests,5);
 assert.deepEqual(f.counters(),{memberReads:2,rosterReads:3});
 const urls=f.calls.filter(s=>s.includes("/roster/member/")).map(s=>new URL(s));
 assert.equal(urls[0].searchParams.has("perPage"),false);
 assert.equal(urls[1].searchParams.get("perPage"),"200");
 assert.equal(urls[2].searchParams.get("page"),"2");
});
test("undocumented silent page cap is not accepted as a complete roster",async()=>{
 const f=fixture({silentCap:true,count:383});
 const result=await collectAllianceRosterSample(token,f.fetchImpl,opts);
 assert.equal(result.status,"complete");
 assert.equal(result.rosters[0].chars.length,383);
 assert.equal(result.pages,2);
 assert.equal(result.requests,5);
});
test("since + 344 reuses only previously validated R2 characters, with no pages downloaded",async()=>{
 const cached=chars(383);
 const f=fixture({unchanged:true});
 const result=await collectAllianceRosterSample(token,f.fetchImpl,{
  ...opts,cachedForMember:async member=>{
    assert.equal(member.id,"member");
    return {asOf:"PREVIOUS_ASOF",chars:cached};
  }
 });
 assert.equal(result.status,"complete");
 assert.equal(result.pages,0);
 assert.equal(result.unchangedCount,1);
 assert.equal(result.requests,3);
 assert.deepEqual(result.rosters[0].chars,cached);
 assert.equal(result.rosters[0].asOf,"PREVIOUS_ASOF");
 assert.equal(f.counters().rosterReads,1);
 assert.equal(new URL(f.calls.find(s=>s.includes("/roster/member/"))).searchParams.get("since"),"PREVIOUS_ASOF");
});
test("since + HTTP 200 replaces old cached data, in ONE full call",async()=>{
 const f=fixture({changedPower:true});
 const result=await collectAllianceRosterSample(token,f.fetchImpl,{
  ...opts,cachedForMember:async()=>({asOf:"PREVIOUS_ASOF",chars:chars(383)})
 });
 assert.equal(result.status,"complete");
 assert.equal(result.requests,3);
 assert.equal(result.rosters[0].chars[0].power,200);
 assert.equal(result.rosters[0].asOf,"NEW_ASOF");
 assert.equal(result.unchangedCount,0);
});
test("invalid or missing cache never sends since and cannot accept an unsolicited 344",async()=>{
 const f=fixture();
 const result=await collectAllianceRosterSample(token,f.fetchImpl,{
   ...opts,cachedForMember:async()=>({asOf:"PREVIOUS_ASOF",chars:[
     {id:"dupe"},{id:"dupe"}
   ]})
 });
 assert.equal(result.status,"complete");
 const url=new URL(f.calls.find(s=>s.includes("/roster/member/")));
 assert.equal(url.searchParams.has("since"),false);
});
test("preflight digest mismatches stop BEFORE any character GET",async()=>{
 const f=fixture();
 const result=await collectAllianceRosterSample(token,f.fetchImpl,{
  ...opts,expectedMembershipDigest:"a".repeat(64)
 });
 assert.equal(result.status,"membership-changed-restart-required");
 assert.equal(f.counters().memberReads,1);
 assert.equal(f.counters().rosterReads,0);
});
test("revocation after unpaged successful response discards all cached or new data",async()=>{
 const f=fixture({revision:true});
 const result=await collectAllianceRosterSample(token,f.fetchImpl,opts);
 assert.equal(result.status,"changed-during-read");
 assert.equal(result.rosters,undefined);
 assert.equal(f.counters().rosterReads,1);
});
