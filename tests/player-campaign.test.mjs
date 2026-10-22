import {test} from "node:test";
import assert from "node:assert/strict";
import {putCaptainRecord,CAPTAIN_PREFIX} from "../src/captain-vault.js";
import {startPlayerCampaign,runPlayerCampaignTick,
  getPlayerCampaignStatus,handlePlayerCampaignAdmin} from "../src/player-campaign.js";
import {handleAdmin} from "../src/admin-routes.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const URL=ORIGIN+"/admin/api/player-campaign";
const prefix="roster-batches/v1/";
const scope="offline m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act m3p.f.ar.pro m3p.f.ar.ros";
async function fixture({scopes=scope,memberShare=true,providerStatus=200}={}){
  const db=new Map(),calls=[],leases=new Set();
  const id="d".repeat(64),now=Date.now();
  const bucket={
    get:async key=>db.has(key)?{text:async()=>db.get(key)}:null,
    head:async key=>db.has(key)?{key}:null,
    put:async(key,value)=>{
      assert.ok(key.startsWith(prefix)||key.startsWith(CAPTAIN_PREFIX));
      db.set(key,String(value));
    },
    delete:async key=>{db.delete(key);},
    list:async ({prefix:search})=>({
      objects:[...db.keys()].filter(key=>key.startsWith(search)).map(key=>({key})),
      truncated:false
    })
  };
  const env={CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_BUCKET:bucket,
    CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:s=>s,
      get:()=>({fetch:async r=>{
        assert.equal((await r.json()).action,"access");
        return Response.json({status:"active",accessToken:"TOKEN"});
      }})
    },
    ROSTER_BATCH_LOCK:{
      idFromName:s=>s,
      get:key=>({fetch:async r=>{
        const body=await r.json();
        if(body.action==="acquire"){
          if(leases.has(key))return Response.json({status:"busy"},{status:409});
          leases.add(key);return Response.json({status:"acquired"});
        }
        leases.delete(key);return Response.json({status:"released"});
      }})
    }
  };
  await putCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,CAPTAIN_PREFIX+id,{
    version:2,createdAt:now,expiresAt:now+100*86400000,
    accessExpiresAt:now+3600000,accessToken:"TOKEN",refreshToken:"REFRESH",
    scope:scopes
  });
  const provider=async(url,options)=>{
    calls.push(url);
    assert.equal(options.method,"GET");
    assert.equal(options.headers.Authorization,"Bearer TOKEN");
    if(providerStatus!==200)
      return new Response(null,{status:providerStatus});
    if(url.endsWith("/alliance/members"))
      return Response.json({data:[
        {id:"self",isSelf:true,card:{rosterShare:false}},
        {id:"shared:1",isSelf:false,card:{rosterShare:memberShare}}
      ],meta:{asOf:"t1"}});
    if(url.includes("/squads/member/"))
      return Response.json({data:{war:[["A","B"]]},meta:{asOf:"t1"}});
    if(url.endsWith("/squads"))
      return Response.json({data:{war:[["C"]]},meta:{asOf:"t1"}});
    return Response.json({data:[{id:"item",nested:{unknown:true}}],
      meta:{page:1,perTotal:1,asOf:"t1"},otherUnknownField:true});
  };
  return {env,db,calls,provider,id,now};
}
async function loop(f,num=15){
  const statuses=[];
  for(let i=0;i<num;i++){
    const next=await runPlayerCampaignTick(f.env,f.provider,f.now+i*60000);
    statuses.push(next.status);
    const current=await (await getPlayerCampaignStatus(f.env)).json();
    if(["complete","partial"].includes(current.status))break;
  }
  return {statuses,state:await (await getPlayerCampaignStatus(f.env)).json()};
}
test("one click starts for all connected grants without calling Scopely",async()=>{
  const f=await fixture();
  const r=await startPlayerCampaign(f.env,f.now);
  assert.equal(r.status,200);
  const started=await r.json();
  assert.equal(started.status,"running");
  assert.equal(started.connectedAccounts,1);
  assert.equal(f.calls.length,0);
  assert.ok(f.db.has(prefix+"player-campaign/current.json"));
});
test("cron captures all personal families, checks sharing, and reaches complete",async()=>{
  const f=await fixture();
  await startPlayerCampaign(f.env,f.now);
  const {statuses,state}=await loop(f);
  assert.equal(state.status,"complete",JSON.stringify({statuses,state}));
  assert.equal(state.saved,5,"Four personal families plus one shared member");
  assert.equal(state.sharedSquads,1);
  assert.equal(state.accountsProcessed,1);
  assert.equal(f.calls.filter(x=>x.endsWith("/alliance/members")).length,3);
  assert.ok(f.calls.some(x=>x.includes("/squads/member/shared%3A1")));
  const keys=[...f.db.keys()];
  assert.ok(keys.some(x=>x.includes("/personal-inventory/self/latest.json")));
  assert.ok(keys.some(x=>x.includes("/shared-member-squads/")&&x.endsWith("/latest.json")));
  const source=[...f.db.values()].filter(v=>v.includes('"providerResponse"')).join("");
  assert.ok(source.includes("otherUnknownField"));
  assert.ok(!source.includes('"TOKEN"'));
  const publicStatus=JSON.stringify(state);
  assert.ok(!publicStatus.includes("shared:1"));
  assert.ok(!publicStatus.includes(f.id));
  assert.ok(!publicStatus.includes("TOKEN"));
  const prior=f.calls.length;
  assert.equal((await (await getPlayerCampaignStatus(f.env)).json()).status,"complete");
  assert.equal(f.calls.length,prior,"R2 status never calls Scopely");
});
test("no private inventory or progression without personal grant",async()=>{
  const s="offline m3p.f.pr.pro m3p.f.pr.ros m3p.f.ar.pro m3p.f.ar.ros";
  const f=await fixture({scopes:s});
  await startPlayerCampaign(f.env,f.now);
  const {state}=await loop(f);
  assert.equal(state.status,"complete");
  assert.equal(state.saved,2); // self squads + shared squad
  assert.equal(state.skipped,2);
  assert.ok(f.calls.every(x=>!x.includes("/inventory")&&
    !x.includes("/itemWishlist")&&!x.includes("/events")));
});
test("no shared squads fetched after revocation and no private member inventory",async()=>{
  const f=await fixture({memberShare:false});
  await startPlayerCampaign(f.env,f.now);
  const {state}=await loop(f);
  assert.equal(state.status,"complete");
  assert.equal(state.saved,4);
  assert.equal(state.sharedSquads,0);
  assert.ok(f.calls.every(x=>!x.includes("/squads/member/")));
});
test("provider rate limit pauses campaign, without rapid retries",async()=>{
  const f=await fixture({providerStatus:429});
  await startPlayerCampaign(f.env,f.now);
  const a=await runPlayerCampaignTick(f.env,f.provider,f.now);
  assert.equal(a.status,"incomplete");
  const calls=f.calls.length;
  const b=await runPlayerCampaignTick(f.env,f.provider,f.now+60_000);
  assert.equal(b.status,"cooldown");
  assert.equal(f.calls.length,calls);
  const state=await (await getPlayerCampaignStatus(f.env)).json();
  assert.equal(state.status,"running");
  assert.equal(state.nextAttemptAt,new Date(f.now+3600000).toISOString());
});
test("admin one-button endpoint rejects cross-origin and unauthorized clients",async()=>{
  const f=await fixture();
  const bad=new Request(URL,{method:"POST",headers:{
    "Content-Type":"application/json"
  },body:'{"action":"start"}'});
  const res=await handlePlayerCampaignAdmin(bad,f.env,f.now);
  assert.equal(res.status,403);
  const adminEnv={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"sample.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const blocked=await handleAdmin(new Request(URL),adminEnv);
  assert.equal(blocked.status,403);
  assert.equal(f.calls.length,0);
});
