import {test} from "node:test";
import assert from "node:assert/strict";
import {projectInfoRows,runMemberInfoTick} from "../src/member-info-campaign.js";
import {runMemberInfoAutoTick,memberInfoWindow} from "../src/member-info-scheduler.js";

test("member Infos include roster-nonsharing members and all optional profile fields",()=>{
  const members=[{id:"private-volatile",rank:"member",card:{
    name:"Eki",icon:"icon",frame:"frame",tcp:210,warMvp:8,
    rosterShare:false,stp:17,charactersCollected:374,daysInAlliance:1,
    level:{completedTier:110,goalTier:111}}}];
  const rows=projectInfoRows(members,{"private-volatile":{
    latestArena:17,charactersAtMaxStarRank:350,blitzWins:102,
    wwPoints:13,aid:1234,qualifications:{playStyle:"casual"}}},"Kronos");
  assert.equal(rows.length,1);
  assert.equal(rows[0].rosterShare,false);
  assert.equal(rows[0].level.completedTier,110);
  assert.equal(rows[0].latestArena,17);
  assert.equal(rows[0].wwPoints,13);
  assert.doesNotMatch(JSON.stringify(rows),/private-volatile/);
});
test("unavailable card preserves all current member data",()=>{
  const members=[{id:"temporary",rank:"captain",
    card:{name:"Edge",icon:"",frame:"",tcp:42,warMvp:0,rosterShare:true}}];
  const rows=projectInfoRows(members,{temporary:null},"Dionysos");
  assert.equal(rows[0].profileStatus,"unavailable");
  assert.equal(rows[0].latestArena,undefined);
});
test("opt-in blocks all API and storage reads by default",async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error("must not fetch");};
  assert.equal((await runMemberInfoTick({},"a".repeat(64),
    {campaign:"2026-10-31-am",stamp:"2026-10-31T02:20Z"},fetchImpl)).status,"disabled");
  assert.equal((await runMemberInfoAutoTick({},"2026-10-31T02:20:00Z",fetchImpl)).status,"disabled");
  assert.equal(calls,0);
});

test("PM Infos starts at 17:01 Paris in winter, never at reward cutoff",()=>{
  assert.equal(memberInfoWindow(Date.parse("2026-11-02T16:00:00Z")),null);
  assert.deepEqual(memberInfoWindow(Date.parse("2026-11-02T16:01:00Z")),{period:"pm",tick:0});
  assert.deepEqual(memberInfoWindow(Date.parse("2026-11-02T18:00:00Z")),{period:"pm",tick:119});
  assert.equal(memberInfoWindow(Date.parse("2026-11-02T18:01:00Z")),null);
});
test("PM Infos follows daylight saving time with no fixed UTC offset",()=>{
  assert.equal(memberInfoWindow(Date.parse("2026-07-02T15:00:00Z")),null);
  assert.deepEqual(memberInfoWindow(Date.parse("2026-07-02T15:01:00Z")),{period:"pm",tick:0});
  assert.deepEqual(memberInfoWindow(Date.parse("2026-07-02T17:00:00Z")),{period:"pm",tick:119});
  assert.equal(memberInfoWindow(Date.parse("2026-07-02T17:01:00Z")),null);
});
test("AM UTC window remains unchanged and no additional Cron is required",()=>{
  assert.deepEqual(memberInfoWindow(Date.parse("2026-11-02T02:00:00Z")),{period:"am",tick:0});
  assert.deepEqual(memberInfoWindow(Date.parse("2026-11-02T03:59:00Z")),{period:"am",tick:119});
  assert.equal(memberInfoWindow(Date.parse("2026-11-02T04:00:00Z")),null);
  assert.equal(memberInfoWindow(NaN),null);
});
