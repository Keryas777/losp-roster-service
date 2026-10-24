import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {rosterSyncPreflight,saveRosterSyncApprovals,approveOneRosterAlliance,readApproval,ROSTER_APPROVAL_KEY} from "../src/roster-sync-preflight.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {handleAdmin} from "../src/admin-routes.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const sessionKey=CAPTAIN_PREFIX+"b".repeat(64);
const member=(id,self=false,share=false)=>({id,isSelf:self,card:{name:"Private-"+id,rosterShare:share}});
const fixtures={
  1:{card:{id:"aid-z:v1",name:"Zeus"},members:[
    member("self",true,true),member("ally",false,true),member("unshared",false,false)]},
  2:{card:{id:"aid-a:v1",name:"Athéna"},members:[
    member("self",true,true),member("ally",false,true)]}
};
function fixture({partial=false,forbidden=false,forHades=false}={}){
  const store=new Map(),calls=[];
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"cc".repeat(32),
    CAPTAIN_BUCKET:{
      get:async k=>store.has(k)?{text:async()=>store.get(k)}:null,
      put:async(k,v)=>{store.set(k,v)},
      delete:async()=>{},
      list:async()=>({objects:[{key:sessionKey}],truncated:partial})
    },
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:key=>key,
      get:()=>({fetch:async()=>Response.json({status:"active",accessToken:"TEST_TOKEN"})})
    }
  };
  const provider=async(url,options)=>{
    calls.push(url);
    assert.equal(options.method,"GET");
    assert.equal(options.headers.Authorization,"Bearer TEST_TOKEN");
    if(url.endsWith("/alliance/card"))return Response.json({data:forHades?{id:"aid-h:v1",name:"Hadès"}:fixtures[1].card});
    if(url.endsWith("/alliance/members"))
      return forbidden?Response.json({error:"not shared"},{status:403}):
        Response.json({data:fixtures[1].members});
    throw Error("unexpected provider URL");
  };
  return {store,calls,env,provider};
}
const req=(p,{body,originHeader=origin,contentType="application/json"}={})=>
  new Request(origin+p,{method:"POST",headers:{Origin:originHeader,"Content-Type":contentType},
    body:JSON.stringify(body)});
test("private preflight discovers current OAuth alliance without reading any roster",async()=>{
  const f=fixture();
  const res=await rosterSyncPreflight(f.env,f.provider);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.equal(data.mode,"approval-preflight-only");
  assert.equal(data.canCollectAutomatically,false);
  assert.equal(data.alliances.length,1);
  assert.equal(data.alliances[0].name,"Zeus");
  assert.equal(data.alliances[0].sharedCount,2);
  assert.equal(data.alliances[0].approved,false);
  assert.equal(data.registryStatus,"not-configured");
  assert.match(data.alliances[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.ok(f.calls.every(u=>!u.includes("/roster")));
  assert.equal(f.store.size,0);
  assert.doesNotMatch(JSON.stringify(data),/TEST_TOKEN|Private-self|Private-ally|aid-z/);
});
test("explicit approval saves stable fingerprints only, never roster or member data",async()=>{
  const f=fixture();
  const scan=await(await rosterSyncPreflight(f.env,f.provider)).json();
  const fingerprint=scan.alliances[0].fingerprint;
  const accepted=await saveRosterSyncApprovals(req("/admin/api/roster-approvals",{
    body:{fingerprints:[fingerprint]}
  }),f.env,f.provider);
  assert.deepEqual(await accepted.json(),{
    status:"approved",count:1,collectionEnabled:false
  });
  assert.equal(f.store.size,1);
  const saved=JSON.parse(f.store.get(ROSTER_APPROVAL_KEY));
  assert.equal(saved.version,1);
  assert.deepEqual(saved.alliances,[{fingerprint,name:"Zeus"}]);
  assert.doesNotMatch(JSON.stringify(saved),/TEST_TOKEN|Private-|aid-z|rosterShare/);
  const after=await(await rosterSyncPreflight(f.env,f.provider)).json();
  assert.equal(after.approvedCount,1);
  assert.equal(after.readyCount,1);
  assert.equal(after.alliances[0].approved,true);
});
test("Hadès joins full LoSP approved registry without replacing Zeus",async()=>{
  const f=fixture({forHades:true});
  f.store.set(ROSTER_APPROVAL_KEY,JSON.stringify({
    version:1,alliances:[{fingerprint:"a".repeat(64),name:"Zeus"}]
  }));
  const scan=await(await rosterSyncPreflight(f.env,f.provider)).json();
  const fingerprint=scan.alliances[0].fingerprint;
  const result=await approveOneRosterAlliance(req("/admin/api/roster-approve-one",{
    body:{fingerprint}
  }),f.env,f.provider);
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{status:"approved",name:"Hadès",count:2});
  const saved=(await readApproval(f.env)).alliances;
  assert.deepEqual(saved.map(a=>a.name),["Zeus","Hadès"]);
  assert.ok(saved.every(a=>a.mode===undefined&&a.maxConnected===undefined),
    "No two-player cap, no special Hadès collection mode");
});

test("unsafe, duplicate, arbitrary and unverified approvals are all rejected",async()=>{
  const f=fixture();
  const fingerprint="a".repeat(64);
  const cases=[
    {fingerprints:[]},{fingerprints:[fingerprint,fingerprint]},
    {fingerprints:["bad"]},{fingerprints:[fingerprint],extra:"untrusted"},
    {fingerprints:"bad"},{garbage:true},null
  ];
  for(const body of cases){
    const res=await saveRosterSyncApprovals(req("/admin/api/roster-approvals",{body}),f.env,f.provider);
    assert.ok([400,409].includes(res.status),"unexpected HTTP "+res.status);
  }
  assert.equal(f.store.size,0);
  const unauthorized=await saveRosterSyncApprovals(req("/admin/api/roster-approvals",{
    body:{fingerprints:[fingerprint]},originHeader:"https://untrusted.invalid"
  }),f.env,f.provider);
  assert.equal(unauthorized.status,403);
  assert.equal(f.store.size,0);
});
test("R2 cursor errors and denied Scopely members fail closed",async()=>{
  for(const type of ["partial","forbidden"]){
    const f=fixture({[type]:true});
    const readResponse=await rosterSyncPreflight(f.env,f.provider);
    const attempted=await saveRosterSyncApprovals(req("/admin/api/roster-approvals",{
      body:{fingerprints:["a".repeat(64)]}
    }),f.env,f.provider);
    assert.equal(readResponse.status,type==="partial"?503:200);
    if(type==="forbidden")
      assert.equal((await readResponse.json()).complete,false);
    assert.equal(attempted.status,type==="partial"?503:409);
    assert.equal(f.store.size,0);
  }
});
test("approval registry accepts more than twelve alliance fingerprints",async()=>{
  const f=fixture();
  const alliances=Array.from({length:25},(_,i)=>({
    fingerprint:i.toString(16).padStart(64,"0"),name:"Alliance "+i
  }));
  f.store.set(ROSTER_APPROVAL_KEY,JSON.stringify({version:1,alliances}));
  const registry=await readApproval(f.env);
  assert.equal(registry.status,"configured");
  assert.equal(registry.alliances.length,25);
});
test("admin gate rejects forged approval request before R2 reads and provider calls",async()=>{
  const f=fixture();
  const res=await handleAdmin(req("/admin/api/roster-approvals",{
    body:{fingerprints:["a".repeat(64)]}
  }),{...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"},f.provider);
  assert.equal(res.status,403);
  assert.equal(f.calls.length,0);
  assert.equal(f.store.size,0);
});
test("admin script stays vanilla, avoids token and roster persistence",async()=>{
  const js=await readFile(new URL("../public/admin-roster-preflight.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML|console\.|indexedDB/);
  assert.match(js,/roster-preflight/);
  assert.match(js,/roster-approvals/);
});
