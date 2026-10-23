import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {buildCollectionFileCatalog} from "../src/collection-file-catalog.js";
import {GAME_ROOTS} from "../src/game-catalog-archive.js";
import {PLAYER_EXTRA_FAMILIES} from "../src/player-extras-archive.js";
import {PUBLIC_SOURCE_ROUTES} from "../src/public-msf-source-probe.js";

const record={
  version:1,source:"get-character-list",
  key:"msf-secondary-sources/v1/get-character-list/sha256-abc.json",
  indexed:true,receivedAt:"2026-10-23T09:30:00Z"
};
function fixture(){
  const reads=[],docs=new Map([[
    "msf-secondary-sources/v1/get-character-list/latest.json",JSON.stringify(record)
  ]]);
  const bucket={
    get:async key=>{
      reads.push(["get",key]);
      return docs.has(key)?{size:docs.get(key).length,text:async()=>docs.get(key)}:null;
    },
    head:async key=>{
      reads.push(["head",key]);
      return key===record.key?{key}:null;
    }
  };
  return {reads,bucket,env:{
    CAPTAIN_BUCKET:bucket,GAME_ARCHIVE_AUTO_ENABLED:"true",
    GAME_DIFF_ENABLED:"true",PLAYER_AUTO_ENABLED:"true",
    ROSTER_AUTO_ENABLED:"true",ROSTER_RETENTION_CONFIRMED:"true",
    CAPTAIN_COVERAGE_ENABLED:"false"
  }};
}
const state={
  game:{status:"completed"},gameDifferential:{status:"completed"},rosters:{status:"ok"},
  player:{status:"complete",nextRunAt:"2026-10-24T09:00:00Z"},
  personal:{status:"ok",families:[
    {id:"personal-inventory",archived:1,eligible:2,broken:1,
      lastCapture:"2026-10-23T08:00:00Z"}
  ]},oauth:{status:"ok",checkedAt:"2026-10-23T10:15:00Z"}
};

test("file catalogue covers collector declarations and exposes cadence without player IDs",async()=>{
  const {env,reads}=fixture();
  const data=await buildCollectionFileCatalog(env,state);
  assert.equal(data.status,"ok");
  const list=data.rows;
  for(const root of GAME_ROOTS)assert.ok(list.some(r=>r.source===root.path));
  for(const id of Object.keys(PLAYER_EXTRA_FAMILIES))
    assert.ok(list.some(r=>r.id==="player-"+id));
  for(const source of PUBLIC_SOURCE_ROUTES)
    assert.ok(list.some(r=>r.id==="secondary-"+source.id));
  const roster=list.find(r=>r.id==="player-shared-roster");
  assert.equal(roster.enabled,true);
  assert.match(roster.when,/02h–06h/);
  const player=list.find(r=>r.id==="player-personal-inventory");
  assert.match(player.evidence,/1\/2/);
  assert.equal(player.lastAt,"2026-10-23T08:00:00Z");
  const game=list.find(r=>r.id==="game-characters");
  assert.equal(game.enabled,true);
  assert.equal(game.automatic,true);
  assert.match(game.when,/tous les 7 jours/);
  assert.match(game.file,/game-archive\/v1\/diff\/runs/);
  assert.ok(list.filter(r=>r.group==="/game").every(r=>r.automatic===true&&r.enabled===true),
    "Each /game family has automatic weekly differential maintenance after its one-off archive");
  assert.equal(roster.automatic,true);
  assert.equal(player.automatic,true);
  assert.match(game.evidence,/non vérifiée individuellement/);
  const secondary=list.find(r=>r.id==="secondary-get-character-list");
  assert.equal(secondary.automatic,false);
  assert.equal(secondary.evidence,"Objet R2 présent");
  assert.equal(secondary.lastAt,"2026-10-23T09:30:00Z");
  assert.ok(reads.every(([op,k])=>["get","head"].includes(op)&&
    k.startsWith("msf-secondary-sources/v1/")));
  const output=JSON.stringify(data);
  assert.ok(!output.includes("PRIVATE_TOKEN"));
  assert.ok(!output.includes("captain-session"));
});

test("disabled collectors are not described as running",async()=>{
  const {env}=fixture();
  env.GAME_DIFF_ENABLED="false";
  env.GAME_ARCHIVE_AUTO_ENABLED="true"; // Weekly diff must be off even when manual archive is enabled.
  env.PLAYER_AUTO_ENABLED="false";
  env.ROSTER_AUTO_ENABLED="false";
  const rows=(await buildCollectionFileCatalog(env,state)).rows;
  assert.equal(rows.find(r=>r.id==="game-characters").enabled,false);
  assert.equal(rows.find(r=>r.id==="player-personal-events").enabled,false);
  assert.equal(rows.find(r=>r.id==="player-personal-roster").enabled,false);
  assert.equal(rows.find(r=>r.id==="alliance-coverage").enabled,false);
  assert.equal(rows.find(r=>r.id==="game-characters").automatic,true);
  assert.match(rows.find(r=>r.id==="game-characters").when,/7 jours/);
});

test("inventory frontend is vanilla JS and has no additional API calls",async()=>{
  const js=await readFile(new URL("../public/admin-collection-dashboard.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.match(js,/Inventaire des fichiers et horaires/);
  assert.match(js,/renderFileCatalog\(output,data.catalog\)/);
  assert.match(js,/Collecte automatique/);
  assert.doesNotMatch(js,/innerHTML|localStorage|sessionStorage|setInterval/);
});
