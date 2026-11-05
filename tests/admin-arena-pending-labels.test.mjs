import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext,Script} from "node:vm";

const pathOf=name=>new URL("../public/"+name,import.meta.url);
const detail=readFileSync(pathOf("admin-arena-coverage.js"),"utf8");
const overview=readFileSync(pathOf("admin-collection-dashboard.js"),"utf8");
function body(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,"Could not find formatting logic");
  return source.slice(a,b);
}
const detailHelpers=body(detail,"  const beforeArchive=checkedAt=>",
  "  async function load(){");
const overviewHelpers=body(overview,"  const beforeArenaArchive=checkedAt=>",
  "  function tile(");
const detailLabels=runInNewContext("(()=>{"+
  'const words={missing:"Aucun reçu du jour","missing-day":"Date absente",'+
    'present:"Archivé",invalid:"Non conforme",unverifiable:"Non vérifiable"};'+
  detailHelpers+";return {beforeArchive,historyLabel};})()");
const overviewLabels=runInNewContext("(()=>{const label=x=>x;"+
  overviewHelpers+";return {beforeArenaArchive,arenaHistoryLabel};})()");
test("before the first archive at 20:17 Paris an absent day means scheduled, not failure",()=>{
  const before="2026-11-05T19:16:00Z"; // 20:16 Europe/Paris
  const after="2026-11-05T19:17:00Z"; // 20:17 Europe/Paris
  assert.equal(detailLabels.beforeArchive(before),true);
  assert.equal(detailLabels.beforeArchive(after),false);
  assert.equal(detailLabels.historyLabel("missing-day",before),
    "Archivage prévu à 20h17");
  assert.equal(detailLabels.historyLabel("missing",before),
    "Archivage prévu à 20h17");
  assert.equal(detailLabels.historyLabel("missing-day",after),"Date absente");
  assert.equal(detailLabels.historyLabel("invalid",before),"Non conforme");
  assert.equal(detailLabels.historyLabel("present",before),"Archivé");
  assert.equal(detailLabels.historyLabel("unverifiable",before),"Non vérifiable");
  assert.equal(overviewLabels.arenaHistoryLabel("missing",before),
    "Archivage prévu à 20h17");
  assert.equal(overviewLabels.arenaHistoryLabel("missing-day",after),"missing-day");
});
test("DST does not shift the documented Paris cutoff",()=>{
  const summerBefore="2026-07-02T18:16:00Z"; // 20:16 CEST
  const summerAfter="2026-07-02T18:17:00Z"; // 20:17 CEST
  assert.equal(detailLabels.beforeArchive(summerBefore),true);
  assert.equal(detailLabels.beforeArchive(summerAfter),false);
  assert.equal(overviewLabels.beforeArenaArchive(summerBefore),true);
  assert.equal(overviewLabels.beforeArenaArchive(summerAfter),false);
});
test("before 17:01 both views explain not started without a misleading zero",()=>{
  assert.match(detail,/const notStarted=data\.due===false&&data\.summary\.receipts===0/);
  assert.match(detail,/Collecte non commencée \(prévue à 17h01\)/);
  assert.match(detail,/a\.receipt==="not-due"\?"\.":/);
  assert.match(overview,/!arena\.due\?"Collecte non commencée \(prévue à 17h01\)"/);
  assert.match(detail,/missingHistory\(a\.history\)&&beforeArchive\(data\.checkedAt\)/);
});
test("admin-only pages remain vanilla JS with no side effects or unsafe HTML injection",()=>{
  assert.doesNotThrow(()=>new Script(detail));
  assert.doesNotThrow(()=>new Script(overview));
  for(const script of [detail,overview]){
    assert.doesNotMatch(script,/innerHTML|eval\(|localStorage|sessionStorage/);
  }
  assert.doesNotMatch(detail,/\/player\/v1|\/admin\/api\/reward-infos-manual/);
});
