import test from "node:test";
import assert from "node:assert/strict";
import {installCalendarSnapshot,currentCalendarGroups,mergeCalendarEvent} from "../../public/event-planner/lib/calendar.js";

const NOW=Date.parse("2026-11-24T12:00:00Z"),ART="https://assets.marvelstrikeforce.com/key_art/calendar.webp";
const base=(id,extra={})=>({id,name:id,type:"milestone",startTime:NOW/1000-3600,endTime:NOW/1000+86400,
  cardArt:ART,popupArt:ART,...extra});

test("calendar keeps only the public event families and their current window",()=>{
  const events=[
    base("phase"),
    base("wrapper",{locationHints:["lohub_wrapper"]}),
    {...base("campaign"),type:"episodic",episodic:{type:"eventCampaign",ids:["campaign-id"]}},
    {...base("trial"),type:"pickYourPoison",pickYourPoison:{brackets:[{}]}},
    {...base("past"),endTime:NOW/1000-1},
    {...base("future"),startTime:NOW/1000+1},
    {...base("pass"),type:"battlePass"},
    base("feeder",{locationHints:["lohub_feeder"]}),
    base("no-art",{cardArt:null,popupArt:null})
  ];
  const groups=currentCalendarGroups(events,null,NOW);
  assert.deepEqual(groups.phases.map(event=>event.id),["phase"]);
  assert.deepEqual(groups.command.map(event=>event.id),["wrapper"]);
  assert.deepEqual(groups.events.map(event=>event.id),["campaign","trial"]);
});

test("the public eligibility snapshot is applied only to command events",()=>{
  const updatedAt=new Date(NOW).toISOString(),events=[base("phase"),base("allowed",{locationHints:["lohub_wrapper"]}),base("not-allowed",{locationHints:["lohub_wrapper"]})];
  const installed=installCalendarSnapshot({events,updatedAt,objectiveEligibility:{source:"scopely-player-level110-reference",bracket:"85_and_up",
    observedAt:updatedAt,eligibleEventIds:["phase","allowed"]}});
  const groups=currentCalendarGroups(installed.events,installed.eligibleEventIds,NOW);
  assert.deepEqual(groups.phases.map(event=>event.id),["phase"]);
  assert.deepEqual(groups.command.map(event=>event.id),["allowed"]);
});

test("personal fields enrich a curated card while public artwork and placement remain authoritative",()=>{
  const catalog=base("planner-id",{name:"Public name",locationHints:["lohub_wrapper"],cardArt:ART});
  const personal={...base("planner-id",{name:"Private localized name",locationHints:["lohub_feeder"],cardArt:"https://invalid.test/cover.webp"}),
    milestone:{brackets:[{objective:{progress:{points:125}}}]}};
  const merged=mergeCalendarEvent(catalog,personal);
  assert.equal(merged.name,"Private localized name");
  assert.equal(merged.cardArt,ART);
  assert.deepEqual(merged.locationHints,["lohub_wrapper"]);
  assert.equal(merged.milestone.brackets[0].objective.progress.points,125);
});
