import test from "node:test";
import assert from "node:assert/strict";
import {
  commandCenterFeeders, commandCenterPeriod, commandCenterPeriodLabel,
  isCommandCenterFeeder, isCommandCenterWrapper, summarizeFeederProgress
} from "../../public/event-planner/lib/command-center.js";

const NOW=1_800_000_000;
const wrapper={id:"wrapper",name:"Command Center",locationHints:["lohub_wrapper"],startTime:NOW-86400,endTime:NOW+8*86400};
const feeder=(id,extra={})=>({id,name:"<color=#fff>Command   Center</color>",locationHints:["lohub_feeder"],
  startTime:NOW-100,endTime:NOW+100,milestone:{scoring:{cappedScorings:[]}},...extra});

test("command-center series match the wrapper name, official hint, window and current dates",()=>{
  const rows=[feeder("current"),feeder("wrong-name",{name:"Other Event"}),feeder("wrong-hint",{locationHints:["other"]}),
    feeder("future",{startTime:NOW+1}),feeder("past",{endTime:NOW}),feeder("outside",{startTime:wrapper.startTime-3601,endTime:NOW+100})];
  assert.equal(isCommandCenterWrapper(wrapper),true);
  assert.equal(isCommandCenterFeeder(rows[0]),true);
  assert.deepEqual(commandCenterFeeders(wrapper,rows,NOW).map(row=>row.id),["current"]);
  assert.deepEqual(commandCenterFeeders({...wrapper,locationHints:[]},rows,NOW),[]);
});

test("feeder progress never treats missing or zero caps as completed lines",()=>{
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[]}}}),{status:"unknown",total:0,known:0,completed:0});
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[{cap:10}]}}}),{status:"unknown",total:1,known:0,completed:0});
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[{cap:0,soFar:0}]}}}),{status:"unknown",total:1,known:0,completed:0});
});

test("partial counters cannot mark the whole feeder as completed",()=>{
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[{cap:10,soFar:10},{cap:10}]}}}),
    {status:"partial",total:2,known:1,completed:1});
});

test("all capped line counters must be known to confirm their completion state",()=>{
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[{cap:10,soFar:10},{cap:5,soFar:2}]}}}),
    {status:"open-lines",total:2,known:2,completed:1});
  assert.deepEqual(summarizeFeederProgress({milestone:{scoring:{cappedScorings:[{cap:10,soFar:10},{cap:5,soFar:5}]}}}),
    {status:"complete-lines",total:2,known:2,completed:2});
});

test("period labels follow duration but preserve unknown dates",()=>{
  assert.equal(commandCenterPeriod(feeder("daily",{startTime:NOW-1,endTime:NOW+86400})),"day");
  assert.equal(commandCenterPeriod(feeder("weekly",{startTime:NOW-1,endTime:NOW+7*86400})),"week");
  assert.equal(commandCenterPeriod(feeder("event",{startTime:NOW-1,endTime:NOW+20*86400})),"event");
  assert.equal(commandCenterPeriodLabel(feeder("unknown",{startTime:0,endTime:0})),"Période inconnue");
});
