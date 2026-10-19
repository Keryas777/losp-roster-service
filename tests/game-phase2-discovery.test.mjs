import {test} from "node:test";
import assert from "node:assert/strict";
import {discoverGamePhase2,phase2RootTasks} from "../src/game-phase2-discovery.js";

const list=(source,data)=>discoverGamePhase2(source,{data}).map(x=>x.path);
test("six episodic roots are the exact documented OpenAPI enum",()=>{
  assert.deepEqual(phase2RootTasks().map(x=>x.path),[
    "/game/v1/episodics/campaign",
    "/game/v1/episodics/eventCampaign",
    "/game/v1/episodics/challenge",
    "/game/v1/episodics/flashEvent",
    "/game/v1/episodics/unlockEvent",
    "/game/v1/episodics/otherEvent"
  ]);
});
test("episodic traversal uses actual IDs and number of chapters and tiers",()=>{
  assert.ok(list("/game/v1/episodics/campaign?page=1&perPage=100",
    [{id:"Heroic"}, {id:"Villain"}]).includes("/game/v1/episodics/campaign/Heroic"));
  const chapters=list("/game/v1/episodics/campaign/Heroic",{id:"Heroic",numChapters:3});
  assert.ok(chapters.includes("/game/v1/episodics/campaign/Heroic/3"));
  assert.equal(chapters.filter(x=>/^\/game\/v1\/episodics\/campaign\/Heroic\/\d+$/.test(x)).length,3);
  const tiers=list("/game/v1/episodics/campaign/Heroic/1",
    {chapters:{"1":{numTiers:4}}});
  assert.ok(tiers.includes("/game/v1/episodics/campaign/Heroic/1/4"));
});
test("item/orb and combat endpoints derive from actual typed links only",()=>{
  const routes=list("/game/v1/raids/alpha",
    {id:"NotAnItem",rewards:{allOf:[{item:{id:"Orb123",isOrb:true}},
      {item:{id:"Piece1",isOrb:false}}]},
      rooms:[{combatId:"Combat_22",itemId:"Part25"}]});
  assert.ok(routes.includes("/game/v1/orbRewards/Orb123"));
  assert.ok(routes.includes("/game/v1/items/Piece1"));
  assert.ok(list("/game/v1/events",{rewards:{item:"ItemAsString"}})
    .includes("/game/v1/items/ItemAsString"));
  assert.ok(routes.includes("/game/v1/items/Part25"));
  assert.ok(routes.includes("/game/v1/nodeCombats/Combat_22"));
  assert.ok(!routes.includes("/game/v1/items/NotAnItem"));
  assert.ok(!routes.some(x=>x.startsWith("/player/")));
});
test("invalid source IDs and nested unknown fields cannot create invented GET routes",()=>{
  const paths=list("/game/v1/events",[{id:"AnEvent",combatId:"../danger",
    random:{id:"SomethingElse"},item:{id:"bad/id"}}]);
  assert.deepEqual(paths,[]);
});
test("official EventInfo episodic association finds matching typed episodic details",()=>{
  const paths=list("/game/v1/events",[{episodic:{
    type:"eventCampaign",ids:["ChapterA","ChapterB"]
  }}]);
  assert.ok(paths.includes("/game/v1/episodics/eventCampaign/ChapterA"));
  assert.ok(paths.includes("/game/v1/episodics/eventCampaign/ChapterB"));
});
test("expansion requests target documented paths, never arbitrary query strings",()=>{
  const char=list("/game/v1/characters/CaptainA",{id:"CaptainA"});
  assert.ok(char.some(p=>p.includes("abilityKits=full")&&p.includes("pieceDirectCost=full")));
  const raid=list("/game/v1/raids/RaidA",{id:"RaidA"});
  assert.ok(raid.some(p=>p.includes("raidMap=full")&&p.includes("raidDiffs=full")));
  assert.equal(list("/game/v1/characters/CaptainA?abilityKits=full",
    {id:"CaptainA"}).length,0);
});
