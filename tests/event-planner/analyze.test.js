import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMilestoneEvent } from "../../public/event-planner/lib/event-analysis.js";

const characters=[{id:"CaptainAmerica",nameEn:"Captain America",nameFr:"Captain America",portrait:"",traits:["Avenger"]}];
const roster=[{id:"CaptainAmerica",activeYellow:7,activeRed:0,gearTier:20,level:90,iso8:{active:"raider",raider:10}}];
const event=(progress,soFar)=>({id:"event-1",type:"milestone",startTime:1,endTime:2_000_000_000,
  milestone:{type:"solo",scoring:{methods:[],cappedScorings:[{cap:20,...(soFar===undefined?{}:{soFar}),methods:[{description:"Play Blitz with Captain America at 7 Yellow Stars",points:5}]}]},
    brackets:[{id:"default",objective:{...(progress===undefined?{}:{progress}),tiers:{1:{goal:20},2:{goal:40}}}}]}});

test("Maddoxx analysis uses confirmed progress, roster requirements, completed goals and tiers",()=>{
  const result=analyzeMilestoneEvent({eventEn:event({points:20,completedTier:1,claimableTiers:[2]},20),eventFr:event({points:20,completedTier:1,claimableTiers:[2]},20),roster,characters,now:1_900_000_000});
  assert.equal(result.supported,true);
  assert.equal(result.event.points,20);
  assert.equal(result.event.completedTierKnown,true);
  assert.equal(result.actions[0].status,"done");
  assert.equal(result.actions[0].remaining,0);
  assert.equal(result.plan.secure.tier,1);
});

test("missing personal progress and capped counters remain unknown, never zero or completed",()=>{
  const result=analyzeMilestoneEvent({eventEn:event(undefined,undefined),eventFr:event(undefined,undefined),roster,characters,now:1_900_000_000});
  assert.equal(result.supported,true);
  assert.equal(result.event.points,null);
  assert.equal(result.event.currentTier,null);
  assert.equal(result.actions[0].status,"unknown");
  assert.equal(result.actions[0].remaining,null);
  assert.equal(result.plan.status,"unavailable");
});

test("Maddoxx fallback estimates a total only when all capped counters are available",()=>{
  const complete=analyzeMilestoneEvent({eventEn:event(undefined,20),eventFr:event(undefined,20),roster,characters,now:1_900_000_000});
  assert.equal(complete.event.progressState,"estimated");
  assert.equal(complete.event.points,20);
  assert.equal(complete.event.currentTier,null);
  assert.equal(complete.plan.display,"nextTierBlocked");
  const incomplete=event(undefined,20);
  incomplete.milestone.scoring.cappedScorings.push({cap:10,methods:[{description:"Daily Login",points:1}]});
  const partial=analyzeMilestoneEvent({eventEn:incomplete,eventFr:incomplete,roster,characters,now:1_900_000_000});
  assert.equal(partial.event.progressState,"partial");
  assert.equal(partial.event.reportedActionPoints,20);
  assert.equal(partial.event.points,null);
  assert.equal(partial.plan.status,"unavailable");
});

test("known total score does not turn a missing capped counter into zero",()=>{
  const result=analyzeMilestoneEvent({eventEn:event({points:10},undefined),eventFr:event({points:10},undefined),roster,characters,now:1_900_000_000});
  assert.equal(result.event.progressState,"available");
  assert.equal(result.actions[0].progressState,"unknown");
  assert.equal(result.actions[0].status,"unknown");
  assert.equal(result.actions[0].remaining,null);
  assert.notEqual(result.plan.status,"unavailable");
});

test("premium flag is preserved as information on parsed and unparsed capped objectives",()=>{
  const known=event({points:0,completedTier:0,claimableTiers:[]},0);
  known.milestone.scoring.cappedScorings[0].isPremium=true;
  const parsed=analyzeMilestoneEvent({eventEn:known,eventFr:known,roster,characters,now:1_900_000_000});
  assert.equal(parsed.actions[0].premium,true);
  assert.equal(parsed.actions[0].status,"doable");

  const unknown=event({points:0,completedTier:0,claimableTiers:[]},0);
  unknown.milestone.scoring.cappedScorings[0].isPremium=true;
  unknown.milestone.scoring.cappedScorings[0].methods=[{description:"Complete a new unknown task",points:1}];
  const skipped=analyzeMilestoneEvent({eventEn:unknown,eventFr:unknown,roster,characters,now:1_900_000_000});
  assert.equal(skipped.unparsed.find(item=>item.source==="capped").premium,true);
});

test("missing roster keeps character action feasibility unknown without blocking the rest of the analysis",()=>{
  const result=analyzeMilestoneEvent({eventEn:event({points:10,completedTier:0,claimableTiers:[]},5),eventFr:event({points:10,completedTier:0,claimableTiers:[]},5),roster:[],rosterKnown:false,characters,now:1_900_000_000});
  assert.equal(result.supported,true);
  assert.equal(result.actions[0].status,"unknown");
  assert.equal(result.actions[0].reason.code,"rosterUnavailable");
  assert.equal(result.event.progressState,"available");
});

test("an unknown ISO class level does not become level zero or create an upgrade lever",()=>{
  const noActiveClass=[{...roster[0],iso8:{raider:10}}];
  const absentActiveLevel=[{...roster[0],iso8:{active:"raider"}}];
  const noAssignedClass=[{...roster[0],iso8:{active:"raider",raider:0}}];
  const eventWithIso=event({points:0,completedTier:0,claimableTiers:[]},0);
  eventWithIso.milestone.scoring.methods=[{description:"Upgrade any character to T4 Level 3 Iso-8",points:100}];
  for(const entries of [noActiveClass,absentActiveLevel]){
    const result=analyzeMilestoneEvent({eventEn:eventWithIso,eventFr:eventWithIso,roster:entries,characters,now:1_900_000_000});
    assert.equal(result.levers.some(lever=>lever.kind==="iso"),false);
  }
  const explicitZero=analyzeMilestoneEvent({eventEn:eventWithIso,eventFr:eventWithIso,roster:noAssignedClass,characters,now:1_900_000_000});
  assert.equal(explicitZero.levers.some(lever=>lever.kind==="iso"),true);
});
