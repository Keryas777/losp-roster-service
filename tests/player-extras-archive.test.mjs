import {test} from "node:test";
import assert from "node:assert/strict";
import {handlePlayerExtraArchive,PLAYER_EXTRA_FAMILIES} from "../src/player-extras-archive.js";
import {handleAdmin} from "../src/admin-routes.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const URL=ORIGIN+"/admin/api/player-extras";
const sid="b".repeat(64);
const PREFIX="roster-batches/v1/player-extras/";
const member="abc:1";
function fixture(provider){
  const db=new Map(),calls=[],actions=[];
  const bucket={
    get:async key=>db.has(key)?{text:async()=>db.get(key)}:null,
    head:async key=>db.has(key)?{size:db.get(key).length}:null,
    put:async(key,value)=>{
      assert.ok(key.startsWith(PREFIX),"Only existing 7-day R2 lifecycle");
      assert.ok(!key.includes("abc:1"),"No member ID in object path");
      actions.push(["put",key]);db.set(key,String(value));
    },
    delete:async key=>{actions.push(["delete",key]);db.delete(key);},
    list:async({prefix})=>({objects:[...db.keys()].filter(x=>x.startsWith(prefix))
      .map(key=>({key})),truncated:false})
  };
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    CAPTAIN_BUCKET:bucket,
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:s=>s,get:()=>({
      fetch:async request=>{
        assert.equal((await request.json()).action,"access");
        return Response.json({status:"active",accessToken:"TEST_TOKEN"});
      }
    })},
    ROSTER_BATCH_LOCK:{idFromName:s=>s,get:()=>({
      fetch:async req=>{
        const b=await req.json();
        assert.match(b.fingerprint,/^[a-f0-9]{64}$/);
        return Response.json({status:b.action==="acquire"?"acquired":"released"});
      }
    })}
  };
  const fetchImpl=async(url,options)=>{
    calls.push(url);
    assert.equal(options.method,"GET");
    assert.equal(options.headers.Authorization,"Bearer TEST_TOKEN");
    return provider(url,calls);
  };
  const post=(data,now=Date.now(),headers={
    Origin:ORIGIN,"Content-Type":"application/json"})=>
    handlePlayerExtraArchive(new Request(URL,{method:"POST",headers,
      body:JSON.stringify({session:sid,...data})}),env,fetchImpl,now);
  const get=(now=Date.now())=>handlePlayerExtraArchive(
    new Request(URL+"?session="+sid),env,fetchImpl,now);
  return {env,db,calls,actions,post,get};
}
const ok=(data,extra={})=>Response.json({data,meta:{asOf:"snapshot-a",...extra},
  futureProperty:{preserveMe:true}});
const source=f=>[...f.db.values()].filter(v=>v.includes('"providerResponse"')).join("\n");

test("only absent player families: excludes roster, alliance card and game",()=>{
  assert.deepEqual(Object.keys(PLAYER_EXTRA_FAMILIES).sort(),
    ["personal-squads","personal-inventory","personal-wishlist",
     "personal-events","shared-member-squads"].sort());
});
test("OAuth-only data are archived raw and with 7-day TTL, R2 status uses zero provider GET",async()=>{
  for(const resource of ["personal-squads","personal-inventory",
    "personal-wishlist","personal-events"]){
    const f=fixture(url=>ok(resource==="personal-squads"?{tabs:{war:[]}}:
      [{id:"item-1",unknownNested:{x:5}}],{perTotal:1}));
    const date=Date.parse("2026-10-22T10:00:00Z");
    const res=await f.post({resource},date);
    assert.equal(res.status,200,resource);
    const result=await res.json();
    assert.equal(result.status,"archived");
    assert.equal(result.complete,true);
    assert.equal(result.pages,1);
    assert.equal(f.calls.length,1);
    assert.ok(source(f).includes("futureProperty"));
    assert.ok(source(f).includes("preserveMe"));
    assert.ok(!source(f).includes("TEST_TOKEN"));
    assert.ok([...f.db.values()].some(v=>v.includes('"expiresAt":"2026-10-29T10:00:00.000Z"')));
    const status=await (await f.get(date+100)).json();
    assert.equal(status.personal[resource].status,"archived");
    assert.equal(f.calls.length,1,"R2 audit must not query Scopely");
    const second=await (await f.post({resource},date+1000)).json();
    assert.equal(second.status,"recent-capture");
    assert.equal(f.calls.length,1,"10-minute deduplication");
  }
});
test("a 105-item inventory is not called complete until all pages are present",async()=>{
  const f=fixture(url=>{
    const page=Number(new URL(url).searchParams.get("page"));
    return ok(Array.from({length:page===1?100:5},(_,i)=>({id:page+"-"+i})),
      {page,perTotal:105});
  });
  const response=await f.post({resource:"personal-inventory"});
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const body=await response.json();
  assert.equal(body.pages,2);assert.equal(body.entries,105);
  assert.equal(f.calls.length,2);
  const saved=[...f.db.entries()].filter(([k])=>k.includes("/page-"));
  assert.equal(saved.length,2);
});
test("member squads require current rosterShare before and after; no OAuth for target",async()=>{
  let sharing=true;
  const f=fixture(url=>url.endsWith("/alliance/members")?
    ok([{id:"self",isSelf:true,card:{rosterShare:false}},
       {id:member,isSelf:false,card:{rosterShare:sharing}}]):
    ok([{tabs:{war:[["hero-a","hero-b"]]}}]));
  let result=await f.post({resource:"shared-member-squads",member});
  assert.equal(result.status,200);
  assert.equal((await result.json()).status,"archived");
  assert.equal(f.calls.length,3);
  assert.ok(f.calls[1].endsWith("/squads/member/abc%3A1"),f.calls.join(" | "));
  sharing=false;
  result=await f.post({resource:"shared-member-squads",member},
    Date.now()+11*60_000);
  assert.equal(result.status,403);
  assert.equal((await result.json()).purged,true);
  assert.equal(f.db.size,0,"immediate purge on observed revocation");
  assert.equal(f.calls.filter(x=>x.includes("/squads/member/")).length,1);
});
test("429 and partial pagination never publish a completed latest record",async()=>{
  const f=fixture(()=>new Response(null,{status:429}));
  const response=await f.post({resource:"personal-inventory"});
  assert.equal(response.status,429);
  assert.equal((await response.json()).error,"rate-limited");
  assert.equal(f.db.size,0);
  const g=fixture((url)=>{
    const page=Number(new URL(url).searchParams.get("page"));
    return ok(Array.from({length:100},(_,i)=>({id:page+"-"+i})),
      {page,perTotal:1200});
  });
  const result=await g.post({resource:"personal-inventory"});
  assert.equal(result.status,409,JSON.stringify(await result.clone().json()));
  assert.equal((await result.json()).error,"page-budget");
  assert.ok(![...g.db.keys()].some(k=>k.endsWith("latest.json")));
});
test("shared-member requests reject unshared and non-members, without provider private reads",async()=>{
  const f=fixture(url=>ok([
    {id:"self",isSelf:true,card:{rosterShare:false}},
    {id:member,isSelf:false,card:{rosterShare:false}}
  ]));
  const result=await f.post({resource:"shared-member-squads",member});
  assert.equal(result.status,403);
  assert.equal(f.calls.length,1);
  assert.equal(f.db.size,0);
});
test("wrong origin and invalid families fail before access to the provider",async()=>{
  const f=fixture(()=>{throw Error("provider should not be called")});
  assert.equal((await f.post({resource:"personal-roster"})).status,400);
  assert.equal((await f.post({resource:"personal-inventory",member:"unauthorized"})).status,400);
  assert.equal((await f.post({resource:"personal-inventory"},Date.now(),
    {"Content-Type":"application/json"})).status,403);
  assert.equal(f.calls.length,0);
});
test("protected admin handler rejects requests before any OAuth or R2 access",async()=>{
  const f=fixture(()=>{throw Error("provider should not be called")});
  const env={...f.env,MSF_ADMIN_ENABLED:"true",
    CF_ACCESS_TEAM_DOMAIN:"example.cloudflareaccess.com",
    CF_ACCESS_AUD:"a".repeat(64),MSF_ADMIN_EMAILS:"admin@example.test"};
  const res=await handleAdmin(new Request(URL+"?session="+sid),env);
  assert.equal(res.status,403);
  assert.equal(f.db.size,0);
});
