import test from "node:test";
import assert from "node:assert/strict";
import {handleSelfPlayerLinks,handleAdminPlayerLinks,PLAYER_LINKS_KEY}
  from "../src/player-identity-links.js";

const HOST="https://losp-roster-service.deliriousfan7.workers.dev";
const SITE="https://keryas777.github.io";
const TOKEN="v1."+"a".repeat(60)+"."+"b".repeat(43);
const ID1="111111111111111111",ID2="222222222222222222";
function fixture(){
  const objects=new Map(),reads=[],writes=[];
  const bucket={
    get:async key=>{reads.push(key);const s=objects.get(key);
      return s===undefined?null:{size:s.length,text:async()=>s};},
    put:async(key,s)=>{writes.push(key);objects.set(key,s);}
  };
  const env={CAPTAIN_BUCKET:bucket,DISCORD_BOT_TOKEN:"test-bot",
    LOSP_AUTH:{fetch:async()=>Response.json({ok:true,signedSession:true,
      id:ID1,role:"guest",allowedAlliances:["marines"]})}};
  const alliances=[
    {key:"marines",name:"MARINES",group:"marines"},
    {key:"zeus",name:"Zeus",group:"losp"}
  ];
  const groups=[{key:"marines",roleIds:["role-m"]},
    {key:"losp",allianceRoles:{"role-z":"zeus"}}];
  const fetchImpl=async request=>{
    const url=String(request?.url||request);
    if(url.includes("/signed-access"))return env.LOSP_AUTH.fetch();
    if(url.endsWith("/data/alliances.json"))return Response.json(alliances);
    if(url.endsWith("/data/access-groups.json"))
      return Response.json({groups});
    if(url.endsWith("/data/joueurs.json"))
      return Response.json([{alliance:"Zeus",player:"Keryas I"}]);
    if(url.endsWith("/data/rosters_marines.json"))
      return Response.json([{alliance:"marines",player:"El_Prince",chars:{}}]);
    if(url.includes("/guilds/")&&url.includes("/members?"))
      return Response.json([{user:{id:ID1,username:"discord-prince"},
        nick:"Prince",roles:["role-m"]},
        {user:{id:ID2,username:"discord-other"},
          roles:["role-m"]}]);
    if(url.includes("/guilds/")&&url.includes("/members/"))
      return Response.json({user:{id:ID1},roles:["role-m"]});
    throw Error("Unexpected request "+url);
  };
  return {env,objects,reads,writes,fetchImpl};
}
const admin=(view,init={})=>new Request(HOST+"/admin/api/player-links?view="+view,{
  method:init.body?"POST":"GET",
  ...(init.body?{headers:{Origin:HOST,"Content-Type":"application/json"},
    body:JSON.stringify(init.body)}:{})
});
const self=(token=TOKEN,origin=SITE)=>new Request(HOST+"/api/secure/player-links",{
  headers:{Authorization:"Bearer "+token,Origin:origin}});
test("signed guest receives only own mapped identity, restricted to current alliance",async()=>{
  const f=fixture();
  f.objects.set(PLAYER_LINKS_KEY,JSON.stringify({version:1,items:[
    {discordId:ID1,alliance:"marines",player:"El_Prince"},
    {discordId:ID1,alliance:"zeus",player:"Keryas I"},
    {discordId:ID2,alliance:"marines",player:"Other"}]}));
  const response=await handleSelfPlayerLinks(self(),f.env,f.fetchImpl);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).links,
    [{alliance:"marines",player:"El_Prince"}]);
  assert.equal(f.writes.length,0);
});
test("unsigned, cross-origin and forged signed sessions are denied",async()=>{
  const f=fixture();
  assert.equal((await handleSelfPlayerLinks(self("unsigned"),f.env,
    f.fetchImpl)).status,401);
  assert.equal((await handleSelfPlayerLinks(self(TOKEN,"https://evil.test"),
    f.env,f.fetchImpl)).status,403);
  assert.deepEqual(f.reads,[]);
  f.env.LOSP_AUTH.fetch=async()=>Response.json({ok:true,
    signedSession:false,id:ID1,role:"admin",allowedAlliances:["marines"]});
  assert.equal((await handleSelfPlayerLinks(self(),f.env,f.fetchImpl)).status,401);
  assert.deepEqual(f.reads,[]);
});
test("admin lists scoped players and Discord members without any Scopely reads",async()=>{
  const f=fixture();
  const players=await handleAdminPlayerLinks(admin("players&alliance=marines"),
    f.env,f.fetchImpl);
  assert.equal(players.status,200);
  assert.deepEqual((await players.json()).players,["El_Prince"]);
  const members=await handleAdminPlayerLinks(admin("discord&alliance=marines"),
    f.env,f.fetchImpl);
  assert.equal(members.status,200);
  assert.equal((await members.json()).members.length,2);
});
test("admin upsert and delete require current revision, exact roster and group role",async()=>{
  const f=fixture();
  let r=await handleAdminPlayerLinks(admin("links"),f.env,f.fetchImpl);
  const revision=(await r.json()).revision;
  const pair={action:"upsert",discordId:ID1,alliance:"marines",
    player:"El_Prince",revision};
  r=await handleAdminPlayerLinks(admin("links",{body:pair}),f.env,f.fetchImpl);
  assert.equal(r.status,200);
  const value=await r.json();
  assert.equal(value.items.length,1);
  assert.equal(f.writes.length,1);
  const stale=await handleAdminPlayerLinks(admin("links",{body:pair}),f.env,
    f.fetchImpl);
  assert.equal(stale.status,409);
  const wrong=await handleAdminPlayerLinks(admin("links",{body:{
    ...pair,revision:value.revision,player:"Not in roster"
  }}),f.env,f.fetchImpl);
  assert.equal(wrong.status,422);
  assert.equal(f.writes.length,1);
  r=await handleAdminPlayerLinks(admin("links",{body:{
    action:"delete",discordId:ID1,alliance:"marines",
    revision:value.revision
  }}),f.env,f.fetchImpl);
  assert.equal(r.status,200);
  assert.deepEqual((await r.json()).items,[]);
});
test("admin mutations reject CSRF and no Discord token fails safely",async()=>{
  const f=fixture();
  const revision=(await (await handleAdminPlayerLinks(admin("links"),
    f.env,f.fetchImpl)).json()).revision;
  const post=new Request(HOST+"/admin/api/player-links?view=links",{
    method:"POST",headers:{Origin:"https://evil.test",
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"upsert",discordId:ID1,alliance:"marines",
      player:"El_Prince",revision})
  });
  assert.equal((await handleAdminPlayerLinks(post,f.env,f.fetchImpl)).status,403);
  assert.deepEqual(f.writes,[]);
  delete f.env.DISCORD_BOT_TOKEN;
  const res=await handleAdminPlayerLinks(admin("discord&alliance=marines"),
    f.env,f.fetchImpl);
  assert.equal(res.status,503);
  assert.equal((await res.json()).status,"discord-not-configured");
});

test("admin catalogs remain usable when GitHub Pages is unreachable",async()=>{
  const f=fixture();
  const offline=async()=>{throw Error("Pages temporarily unreachable");};
  let response=await handleAdminPlayerLinks(admin("alliances"),f.env,offline);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.ok(body.alliances.some(a=>a.key==="marines"));
  assert.ok(body.alliances.some(a=>a.key==="zeus"));
  response=await handleAdminPlayerLinks(admin("players&alliance=zeus"),
    f.env,offline);
  assert.equal(response.status,200);
  const players=(await response.json()).players;
  assert.ok(players.length>0);
  assert.ok(players.includes("Keryas I"));
  assert.deepEqual(f.writes,[]);
});
