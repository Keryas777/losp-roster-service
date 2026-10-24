import {test} from "node:test";
import assert from "node:assert/strict";
import {
  stableAllianceId,discoverAlliance,readAllianceCoverage,scanPrivateCoverage,buildPrivateCoverage,
  COVERAGE_KEY,listCaptainSessionKeys
} from "../src/alliance-coverage.js";
import {CAPTAIN_PREFIX} from "../src/captain-vault.js";

const scopes="openid offline m3p.f.ar.pro m3p.f.ar.ros";
const json=data=>Response.json({data});
const card=(id,name,warRank=150)=>({id,name,warRank});
const member=(id,self=false,share=false)=>({
  id,isSelf:self,card:{name:"private-"+id,rosterShare:share}
});
const key=n=>CAPTAIN_PREFIX+String(n).padStart(64,"0");
function fixture(records,options={}){
  const contents=new Map(),requests=[],retries={};
  const objects=Object.keys(records).map(Number).map(n=>({key:key(n)}));
  const env={
    CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_COVERAGE_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ac".repeat(32),
    CAPTAIN_BUCKET:{
      get:async()=>null,delete:async()=>{},put:async(k,v)=>{contents.set(k,v);},
      list:async({cursor}={})=>{
        const start=cursor?Number(cursor):0;
        const end=Math.min(objects.length,start+(options.pageSize||objects.length));
        return {objects:objects.slice(start,end),truncated:end<objects.length,
          ...(end<objects.length?{cursor:String(end)}:{})};
      }
    },
    CAPTAIN_REFRESH_COORDINATOR:{
      idFromName:n=>n,
      get:k=>({fetch:async req=>{
        const body=await req.json();
        assert.equal(body.action,"access");
        const n=Number(k.slice(CAPTAIN_PREFIX.length));
        if(records[n]?.broken)return Response.json({status:"retry-later"},{status:503});
        return Response.json({status:"active",accessToken:"TOKEN_"+n});
      }})
    }
  };
  const fetchImpl=async(url,o)=>{
    const n=Number(o.headers.Authorization.replace("Bearer TOKEN_",""));
    requests.push({n,url,auth:o.headers.Authorization,method:o.method});
    if(options.invalidMembersFor?.includes(n) && url.endsWith("/members"))
      return Response.json({error:"not found"},{status:503});
    if(url.endsWith("/alliance/card"))return json(records[n].card);
    if(url.endsWith("/alliance/members"))return json(records[n].members);
    throw Error("No roster/member request is permitted");
  };
  return {env,contents,requests,fetchImpl,retries};
}

test("stable alliance id handles member_version changes, never groups by displayed name",()=>{
  assert.equal(stableAllianceId("stableAid:memberA"),"stableAid");
  assert.equal(stableAllianceId("stableAid:memberB"),"stableAid");
  assert.equal(stableAllianceId("secondAid:memberB"),"secondAid");
  for(const bad of ["","","a","a:"," :x","foo:bar:baz",null,5])
    assert.equal(stableAllianceId(bad),null);
});

test("discoverAlliance validates provider card without collecting rosters",async()=>{
  const requests=[];
  const ok=await discoverAlliance("SECRET_ACCESS",async(url,opts)=>{
    requests.push(url);
    assert.equal(opts.headers.Authorization,"Bearer SECRET_ACCESS");
    return json(card("aid123:v2","Zeus",145));
  });
  assert.deepEqual(ok,{ok:true,aid:"aid123",name:"Zeus",warRank:145,
    raidRank:null,warTrophies:null,warLeague:null});
  assert.deepEqual(requests,["https://api.marvelstrikeforce.com/player/v1/alliance/card"]);
  assert.deepEqual(await discoverAlliance("T",async()=>json(card("malformed","X"))),
    {ok:false,status:"invalid-alliance-card"});
});

test("coverage counts shared and not-shared; self must be identified exactly once",async()=>{
  const list=[
    member("me",true,false),member("a",false,true),
    member("b",false,true),member("c",false,false)
  ];
  const info=await readAllianceCoverage("SECRET",async()=>json(list));
  assert.deepEqual(info,{ok:true,members:4,shared:2,otherShared:2,notShared:2});
  assert.deepEqual(await readAllianceCoverage("SECRET",async()=>json(list.slice(1))),
    {ok:false,status:"current-membership-unverified"});
  assert.deepEqual(await readAllianceCoverage("SECRET",async()=>json([
    member("me",true,true),member("second",true,false)
  ])),{ok:false,status:"current-membership-unverified"});
  assert.deepEqual(await readAllianceCoverage("SECRET",async()=>json([
    member("me",true,true),member("me",false,true)
  ])),{ok:false,status:"invalid-members"});
});

test("multiple captains of same alliance are deduplicated; moves between alliances discovered freshly",async()=>{
  const fx=fixture({
    1:{card:card("aidZeus:v1","Zeus",160),members:[member("self1",true),member("shared",false,true)]},
    2:{card:card("aidZeus:v2","Zeus",160),members:[member("self2",true),member("shared",false,true)]},
    3:{card:card("aidKronos:v1","Kronos",230),members:[member("self3",true),member("excluded",false,false)]}
  });
  const result=await buildPrivateCoverage(fx.env,fx.fetchImpl);
  assert.deepEqual(result,{status:"stored",sessions:3,alliances:2});
  const snapshot=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(snapshot.complete,true);
  assert.equal(snapshot.alliances.length,2);
  const zeus=snapshot.alliances.find(a=>a.name==="Zeus");
  assert.equal(zeus.captainConnections,2);
  assert.equal(zeus.memberCount,2);
  assert.equal(zeus.sharedCount,1);
  assert.equal(zeus.notSharedCount,1);
  const kronos=snapshot.alliances.find(a=>a.name==="Kronos");
  assert.equal(kronos.memberCount,2);
  assert.equal(kronos.sharedCount,0);
  // Three cards, but only TWO member queries: no duplicate alliance fetch.
  assert.equal(fx.requests.filter(x=>x.url.endsWith("/alliance/card")).length,3);
  assert.equal(fx.requests.filter(x=>x.url.endsWith("/alliance/members")).length,2);
  assert.ok(fx.requests.every(x=>!x.url.includes("/roster/member/")));
  assert.doesNotMatch(fx.contents.get(COVERAGE_KEY),
    /TOKEN_|self1|self2|self3|excluded/);
  assert.match(snapshot.alliances[0].allianceFingerprint,/^[a-f0-9]{64}$/);
  // Capitaine #2 moves to Kronos; no stale old membership is reused.
  fx.requests.length=0;
  fx.env.CAPTAIN_BUCKET.list=async()=>({objects:[{key:key(2)}],truncated:false});
  const raw=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(raw.alliances.length,2);
  await buildPrivateCoverage(fx.env,async(url,opt)=>{
    if(url.endsWith("/alliance/card"))return json(card("aidKronos:v8","Kronos"));
    return json([member("newSelf",true,true),member("newMate",false,true)]);
  });
  const moved=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(moved.alliances.length,1);
  assert.equal(moved.alliances[0].name,"Kronos");
  assert.equal(moved.alliances[0].sharedCount,2);
});

test("private discovery is disabled without explicit opt in or without all bindings",async()=>{
  const fx=fixture({1:{card:card("aid:v1","Zeus"),members:[member("me",true)]}});
  fx.env.CAPTAIN_COVERAGE_ENABLED=undefined;
  assert.deepEqual(await buildPrivateCoverage(fx.env,fx.fetchImpl),{status:"disabled"});
  assert.equal(fx.contents.size,0);assert.equal(fx.requests.length,0);
  fx.env.CAPTAIN_COVERAGE_ENABLED="true";
  fx.env.CAPTAIN_BUCKET=undefined;
  assert.deepEqual(await buildPrivateCoverage(fx.env,fx.fetchImpl),{status:"disabled"});
});

test("failed sessions and incomplete membership never count as healthy coverage",async()=>{
  const fx=fixture({
    1:{card:card("a:v1","Zeus"),members:[member("s",true,true)]},
    2:{broken:true},
    3:{card:card("b:v1","Kronos"),members:[member("member",false,true)]}
  });
  await buildPrivateCoverage(fx.env,fx.fetchImpl);
  const snapshot=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(snapshot.complete,false);
  assert.equal(snapshot.unavailableSessions,1);
  assert.equal(snapshot.alliances.length,2);
  assert.equal(snapshot.alliances.find(a=>a.name==="Kronos").status,
    "current-membership-unverified");
});

test("when first captain fails reading members, second captain can provide coverage",async()=>{
  const fx=fixture({
    1:{card:card("a:v1","Zeus"),members:[member("s1",true,true)]},
    2:{card:card("a:v2","Zeus"),members:[member("s2",true,true)]}
  },{invalidMembersFor:[1]});
  await buildPrivateCoverage(fx.env,fx.fetchImpl);
  const snapshot=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(snapshot.complete,true);
  assert.equal(snapshot.alliances.length,1);
  assert.equal(snapshot.alliances[0].status,"available");
  assert.equal(fx.requests.filter(x=>x.url.endsWith("/alliance/members")).length,2);
});

test("R2 pagination discovers every session without a fixed count ceiling",async()=>{
  const many={};
  for(let i=0;i<27;i++){
    many[i]={card:card("aid"+i+":v1","Alliance "+i),
      members:[member("me",true,true)]};
  }
  const fx=fixture(many,{pageSize:5});
  const keys=await listCaptainSessionKeys(fx.env.CAPTAIN_BUCKET);
  assert.equal(keys.length,27);
  await buildPrivateCoverage(fx.env,fx.fetchImpl);
  const snap=JSON.parse(fx.contents.get(COVERAGE_KEY));
  assert.equal(snap.complete,true);
  assert.equal(snap.scannedSessions,27);
  assert.equal(snap.alliances.length,27);
});

test("on-demand admin scan is read-only, independent of disabled daily cron and deduplicates alliances",async()=>{
  const fx=fixture({
    1:{card:card("aid:v1","Zeus"),members:[member("self1",true,true),member("one",false,true)]},
    2:{card:card("aid:v2","Zeus"),members:[member("self2",true,true),member("two",false,false)]},
    3:{card:card("aid2:v1","Athéna"),members:[member("self3",true,false)]}
  });
  fx.env.CAPTAIN_COVERAGE_ENABLED="false";
  const snapshot=await scanPrivateCoverage(fx.env,fx.fetchImpl);
  assert.equal(snapshot.complete,true);
  assert.equal(snapshot.scannedSessions,3);
  assert.equal(snapshot.alliances.length,2);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").captainConnections,2);
  assert.equal(snapshot.alliances.find(a=>a.name==="Zeus").sharedCount,2);
  assert.equal(fx.contents.size,0);
  assert.equal(fx.requests.filter(x=>x.url.endsWith("/alliance/card")).length,3);
  assert.equal(fx.requests.filter(x=>x.url.endsWith("/alliance/members")).length,2);
  assert.ok(fx.requests.every(x=>!x.url.includes("/roster/member/")));
  assert.doesNotMatch(JSON.stringify(snapshot),/TOKEN_|self1|self2|self3|private-one|private-two/);
});
