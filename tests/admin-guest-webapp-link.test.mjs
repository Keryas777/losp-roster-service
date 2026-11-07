import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

const ui=await readFile(new URL("../public/admin-roster-preflight.js",import.meta.url),"utf8");
const routes=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
const from=ui.indexOf("function normalizedAllianceName(value){");
const to=ui.indexOf("function rosterClear(){",from);
assert.ok(from>=0&&to>from,"guest matcher must be independently testable");
const context={};
runInNewContext(ui.slice(from,to)+"\nthis.suggest=suggestWebappKey;",context);
const guess=(name,rows)=>context.suggest({name},rows);
const matching=[
  {key:"endgame-revolution-red",name:"ENDGAME R-évolution",color:"#ED3946"},
  {key:"endgame-revolution-orange",name:"ENDGAME R-évolution",color:"#F6952C"}
];

test("same-named Endgame variants require matching Scopely colour evidence",()=>{
  assert.equal(guess("END<color=red>GΔME R-évolution",matching),
    "endgame-revolution-red");
  assert.equal(guess("END<color=orange>GΔME R-évolution",matching),
    "endgame-revolution-orange");
  assert.equal(guess("END<#ff6600>GΔME R-évolution",matching),
    "endgame-revolution-orange");
  assert.equal(guess("ENDGAME R-évolution",matching),"");
  assert.equal(guess("END<color=white>GΔME R-évolution",matching),"");
});
test("unique verified display-name match works without alliance hardcoding",()=>{
  assert.equal(guess("MΛЯIΠΣƧ",[
    {key:"marines",name:"MARINES",color:"#E53935"}
  ]),"marines");
  assert.equal(guess("ANY NAME",[
    {key:"some-guest",name:"Anything else",color:"#000000"}
  ]),"");
  assert.equal(guess("No alliance",[]),"");
});
test("admin resolves dynamic registry without transmitting credentials",()=>{
  assert.match(ui,/raw\.githubusercontent\.com\/Keryas777\/msf\/main\/docs\/data\/alliances\.json/);
  assert.match(ui,/credentials:"omit"/);
  assert.match(ui,/\{allianceKey:suggestedKey\}/);
  assert.match(routes,/connect-src 'self' https:\/\/raw\.githubusercontent\.com/);
});
