import test from "node:test";
import assert from "node:assert/strict";
import { analyzePersonalEventResponse } from "../src/personal-event-analysis.js";
import { labClientJs } from "../src/personal-event-lab.js";

const event = { id:"ev-1", name:"Événement test", score:42, milestone:{
  brackets:[
    {id:"b1",name:"Objectif actif",objective:{progress:5,target:10}},
    {id:"b2",objective:{progress:null}},
    {id:"b3",objective:{target:3}},
    {id:"b4",objective:{progress:10,target:10}}
  ],
  scoring:{cappedScorings:[
    {id:"shared",name:"Compteur partagé",soFar:4,cap:8},
    {id:"unknown",soFar:null,cap:5},
    {id:"unknown",soFar:null,cap:5}
  ]},
  completedTier:1, tiers:[{tier:1,reward:{id:"r1"}},{tier:2}], claimableTiers:[2]
}};

test("projects present, absent and null counters without treating absence as zero",()=>{
  const [result]=analyzePersonalEventResponse({data:[event]});
  assert.equal(result.name,"Événement test");
  assert.equal(result.score,42);
  assert.deepEqual([result.objectiveCount,result.knownObjectives,result.unknownObjectives,result.absentObjectives],[4,2,1,1]);
  const active=result.facts.find(x=>x.label==="Objectif actif");
  assert.deepEqual([active.value,active.target,active.percent,active.state],[5,10,50,"incomplete"]);
  assert.equal(result.facts.find(x=>x.context.includes("b4")).state,"completed");
  assert.equal(result.facts.find(x=>x.label==="Compteur partagé").state,"incomplete");
  assert.equal(result.facts.filter(x=>x.kind==="capped-scoring").length,2);
  assert.equal(result.facts.find(x=>x.context.includes("unknown")).value,null);
});

test("accepts detail wrappers and only reports tiers with explicit completion evidence",()=>{
  const [result]=analyzePersonalEventResponse({status:"ok",data:{data:event}},"ev-1");
  assert.equal(result.completedTiers.length,1);
  assert.deepEqual(result.claimableTiers.map(x=>x.tier),[2]);
  assert.deepEqual(analyzePersonalEventResponse({data:[event]},"other"),[]);
});

test("analysis is pure and the laboratory client does not fetch during analysis",()=>{
  const input=structuredClone({data:[event]});
  const before=JSON.stringify(input);
  analyzePersonalEventResponse(input);
  assert.equal(JSON.stringify(input),before);
  const client=labClientJs();
  assert.match(client,/personal-event-response/);
  assert.match(client,/personal-event-response/);
  assert.equal((client.match(/fetch\(/g)||[]).length,2);
});
