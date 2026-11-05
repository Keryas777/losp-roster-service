import test from "node:test";
import assert from "node:assert/strict";
import {handleAdminArenaCoverage} from "../src/admin-arena-coverage.js";
import {ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {GUEST_APPROVAL_KEY} from "../src/guest-alliance-approvals.js";
import {handleAdmin} from "../src/admin-routes.js";

const z="a".repeat(64),g="b".repeat(64),day="2026-11-05";
const now=Date.parse("2026-11-05T20:30:00Z");
const URL="https://losp-roster-service.deliriousfan7.workers.dev/admin/api/arena-coverage";
const reward=(fp,alliance,person,rank)=>JSON.stringify({
  version:1,kind:"alliance-infos-reward",campaign:day+"-reward",
  allianceFingerprint:fp,allianceName:alliance,
  capturedAt:day+"T16:09:00Z",expiresAt:"2026-11-12T16:09:00Z",
  rows:[{name:person,latestArena:rank},{name:"Not ranked"}],
  observedAt:[{name:person,at:day+"T16:07:00Z"}],
  secret:"DO_NOT_RETURN_ME"
});
const history=(alliance,person,rank)=>JSON.stringify({
  version:1,snapshots:[{date:day,sourceDay:day,sourceKind:"reward",
    players:[{name:person,alliance,arenaRank:rank}]}]
});
function fixture(){
  const db=new Map(),calls=[];
  db.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{name:"Zeus",fingerprint:z}]}));
  db.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,
    alliances:[{fingerprint:g}]}));
  db.set("roster-batches/v1/"+z+"/campaigns/"+day+"-reward-infos.json",
    reward(z,"LoSP Zeus","SECRET_LOSP_PLAYER",17));
  db.set("roster-batches/v1/"+g+"/campaigns/"+day+"-reward-infos.json",
    reward(g,"MΛЯIΠΣƧ","SECRET_GUEST_PLAYER",41));
  db.set("roster-batches/v1/arena-history/rolling.json",
    history("LoSP Zeus","SECRET_LOSP_PLAYER",17));
  db.set("roster-batches/v1/guest-arena-history/rolling.json",
    history("MΛЯIΠΣƧ","SECRET_GUEST_PLAYER",41));
  const bucket={
    get:async key=>{calls.push(["get",key]);const value=db.get(key);
      return value===undefined?null:{size:value.length,text:async()=>value};},
    list:async params=>{calls.push(["list",params.prefix]);return {objects:[],truncated:false};},
    put:async()=>{throw Error("read-only GET must never write");}
  };
  return {db,calls,env:{CAPTAIN_BUCKET:bucket}};
}
test("Arena admin proves rank counts for LoSP and authorized guest from R2 only",async()=>{
  const f=fixture();
  const result=await handleAdminArenaCoverage(new Request(URL),f.env,now);
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.source,"private-r2-only");
  assert.deepEqual(body.summary,{total:2,losp:1,guests:1,receipts:2});
  assert.equal(body.alliances.find(a=>a.scope==="losp").name,"Zeus");
  const guest=body.alliances.find(a=>a.scope==="guest");
  assert.equal(guest.name,"MΛЯIΠΣƧ");
  assert.equal(guest.receipt,"valid");
  assert.equal(guest.players,2);
  assert.equal(guest.ranks,1);
  assert.equal(guest.withoutRank,1);
  assert.equal(guest.observedRanks,1);
  assert.equal(guest.history,"present");
  assert.equal(guest.archivedRanks,1);
  const json=JSON.stringify(body);
  for(const secret of [z,g,"SECRET_LOSP_PLAYER","SECRET_GUEST_PLAYER",
    "DO_NOT_RETURN_ME","roster-batches/v1/","OAuth_TOKEN"]){
    assert.ok(!json.includes(secret),secret);
  }
  assert.ok(f.calls.every(([method])=>["get","list"].includes(method)));
});
test("revoked guest disappears from admin Arena report before next cron",async()=>{
  const f=fixture();
  f.db.set(GUEST_APPROVAL_KEY,JSON.stringify({version:1,alliances:[]}));
  const body=await (await handleAdminArenaCoverage(new Request(URL),f.env,now)).json();
  assert.equal(body.summary.guests,0);
  assert.deepEqual(body.alliances.map(a=>a.name),["Zeus"]);
  assert.ok(f.calls.every(([,key])=>!String(key).includes("guest-arena-history")));
});
test("missing and invalid receipts never create invented Arena ranks",async()=>{
  const f=fixture();
  f.db.delete("roster-batches/v1/"+g+"/campaigns/"+day+"-reward-infos.json");
  let response=await (await handleAdminArenaCoverage(new Request(URL),f.env,now)).json();
  const guest=response.alliances.find(a=>a.scope==="guest");
  assert.equal(guest.receipt,"missing");
  assert.equal(guest.ranks,0);
  assert.equal(guest.history,"unverifiable");
  f.db.set("roster-batches/v1/"+g+"/campaigns/"+day+"-reward-infos.json",
    reward("f".repeat(64),"MΛЯIΠΣƧ","SECRET_GUEST_PLAYER",1));
  response=await (await handleAdminArenaCoverage(new Request(URL),f.env,now)).json();
  assert.equal(response.alliances.find(a=>a.scope==="guest").receipt,"invalid");
});
test("API method/query and Cloudflare Access gates are fail-closed",async()=>{
  const f=fixture();
  assert.equal((await handleAdminArenaCoverage(new Request(URL,{method:"POST"}),f.env,now)).status,405);
  assert.equal((await handleAdminArenaCoverage(new Request(URL+"?fingerprint="+g),f.env,now)).status,400);
  const before=f.calls.length;
  const response=await handleAdmin(new Request(URL),{
    ...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"test.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"someone@example.test"
  });
  assert.equal(response.status,403);
  assert.equal(f.calls.length,before);
});
