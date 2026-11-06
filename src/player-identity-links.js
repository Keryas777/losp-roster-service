// Private, manually curated Discord ID <-> MSF identity registry.
// Administrative configuration, never a Scopely roster snapshot.
// Admin requests are gated by handleAdmin's verified Cloudflare Access JWT.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {selectApproved} from "./secure-guest-arena-history.js";
import {projectAlliance} from "./secure-guest-rosters.js";
import FALLBACK_CATALOG from "./player-identity-catalog.json" with {type:"json"};

export const PLAYER_LINKS_KEY="identity-links/v1/mappings.json";
const SITE="https://keryas777.github.io";
const DATA=SITE+"/msf/data/";
const ADMIN_ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const AUTH="https://losp-auth.internal/signed-access";
const GUILD="758717819923333191";
const ID=/^[0-9]{16,22}$/;
const SLUG=/^[a-z][a-z0-9-]{1,63}$/;
const NAME=/^[^\x00-\x1f\x7f<>]{1,120}$/;
const MAX_ROWS=600,MAX_BYTES=130000;
const secureHeaders={
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"
};
const reply=(value,status=200,extra={})=>
  Response.json(value,{status,headers:{...secureHeaders,...extra}});
const clean=s=>String(s||"").trim();
const normalized=s=>clean(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
  .replace(/[^a-z0-9]/g,"");
const validItem=x=>x&&typeof x==="object"&&!Array.isArray(x)&&
  ID.test(x.discordId)&&SLUG.test(x.alliance)&&
  typeof x.player==="string"&&x.player===x.player.trim()&&NAME.test(x.player);
const distinct=items=>{
  const accounts=new Set(),players=new Set();
  for(const i of items){
    if(!validItem(i))return false;
    const account=i.discordId+"/"+i.alliance;
    const player=i.alliance+"/"+normalized(i.player);
    if(accounts.has(account)||players.has(player))return false;
    accounts.add(account);players.add(player);
  }
  return true;
};
export async function loadPlayerLinks(env){
  if(!env?.CAPTAIN_BUCKET?.get)throw Error("r2-unavailable");
  const object=await env.CAPTAIN_BUCKET.get(PLAYER_LINKS_KEY);
  if(!object)return [];
  if(Number.isFinite(object.size)&&object.size>MAX_BYTES)throw Error("registry-oversized");
  const raw=await object.text();
  if(raw.length>MAX_BYTES)throw Error("registry-oversized");
  const data=JSON.parse(raw);
  if(data?.version!==1||!Array.isArray(data.items)||
     data.items.length>MAX_ROWS||!distinct(data.items))
    throw Error("registry-invalid");
  return data.items;
}
const sha=async items=>{
  const bytes=new TextEncoder().encode(JSON.stringify(items));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
};
// The source on GitHub Pages is authoritative. A bundled JSON snapshot avoids
// an empty admin panel when a remote Pages fetch is temporarily unavailable.
// The fallback is data, not hardcoded alliance logic, and is never used for
// private guest roster identities or authorization decisions.
async function publicJson(name,fetchImpl,max=12000000){
  try{
    const response=await fetchImpl(DATA+name,{method:"GET",redirect:"error",
      headers:{Accept:"application/json"}});
    if(!response.ok)throw Error("public-data-http-"+response.status);
    const text=await response.text();
    if(text.length>max)throw Error("public-data-oversized");
    return JSON.parse(text);
  }catch(error){
    const fallbackKey={
      "alliances.json":"alliances",
      "access-groups.json":"access_groups",
      "joueurs.json":"joueurs"
    }[name];
    const backup=fallbackKey&&FALLBACK_CATALOG[fallbackKey];
    if(backup)return backup;
    throw error;
  }
}
async function catalog(fetchImpl){
  const [alliances,access]=await Promise.all([
    publicJson("alliances.json",fetchImpl,150000),
    publicJson("access-groups.json",fetchImpl,150000)
  ]);
  if(!Array.isArray(alliances)||!Array.isArray(access?.groups))
    throw Error("catalog-invalid");
  const keys=new Set();
  const list=alliances.map(a=>({
    key:a.key,name:a.name,group:a.group,sourceKey:a.sourceKey||a.key
  }));
  if(list.some(a=>!SLUG.test(a.key||"")||!SLUG.test(a.group||"")||
       !SLUG.test(a.sourceKey||"")||typeof a.name!=="string"||
       a.name.length>100||keys.has(a.key)||!access.groups.some(g=>g.key===a.group)))
    throw Error("catalog-invalid");
  list.forEach(a=>keys.add(a.key));
  return {alliances:list,groups:access.groups};
}
async function playersFor(meta,fetchImpl,env,now=Date.now()){
  let names=[];
  if(meta.group==="losp"){
    const rows=await publicJson("joueurs.json",fetchImpl,250000);
    if(!Array.isArray(rows))throw Error("player-directory-invalid");
    names=rows.filter(x=>normalized(x?.alliance)===normalized(meta.name)||
      normalized(x?.alliance)===normalized(meta.key))
      .map(x=>x.player);
  }else{
    try{
      const rows=await publicJson("rosters_"+meta.sourceKey+".json",fetchImpl);
      if(!Array.isArray(rows))throw Error("guest-roster-invalid");
      names=rows.filter(x=>normalized(x?.alliance)===normalized(meta.key)||
        normalized(x?.alliance)===normalized(meta.sourceKey)).map(x=>x.player);
    }catch(error){
      // Existing private R2 projection is the fallback before GitHub publishes a shard.
      if(!env?.CAPTAIN_BUCKET?.get)throw error;
      const [guest,losp]=await Promise.all([
        readGuestApprovals(env),readApproval(env)
      ]);
      const approved=selectApproved(guest,losp,[meta.key]);
      if(!approved?.length)throw Error("guest-roster-unavailable");
      const projection=await projectAlliance(env.CAPTAIN_BUCKET,
        approved[0].fingerprint,meta.key,now);
      names=projection.rosters.map(r=>r.player);
    }
  }
  return [...new Set(names.map(clean).filter(n=>NAME.test(n)))].sort((a,b)=>
    a.localeCompare(b,"fr"));
}
const rolesFor=(group,groups,alliance)=>{
  const entry=groups.find(g=>g.key===group);
  if(!entry)return [];
  const scoped=Object.entries(entry.allianceRoles||{})
    .filter(([,key])=>key===alliance).map(([role])=>role);
  return [...new Set([...(entry.roleIds||[]),...scoped])];
};
async function discordMember(env,id,fetchImpl){
  if(!env?.DISCORD_BOT_TOKEN)throw Error("discord-bot-token-not-configured");
  const r=await fetchImpl("https://discord.com/api/v10/guilds/"+GUILD+
    "/members/"+id,{headers:{Authorization:"Bot "+env.DISCORD_BOT_TOKEN}});
  if(!r.ok)throw Error("discord-member-http-"+r.status);
  return r.json();
}
async function discordDirectory(env,roles,fetchImpl){
  if(!env?.DISCORD_BOT_TOKEN)throw Error("discord-bot-token-not-configured");
  if(!roles.length)return [];
  const found=[];
  let after="";
  // Paginate; no automatic Discord crawl on opening the admin page.
  for(let page=0;page<10;page++){
    const url="https://discord.com/api/v10/guilds/"+GUILD+
      "/members?limit=1000"+(after?"&after="+after:"");
    const r=await fetchImpl(url,{headers:{
      Authorization:"Bot "+env.DISCORD_BOT_TOKEN,Accept:"application/json"
    }});
    if(!r.ok)throw Error("discord-directory-http-"+r.status);
    const members=await r.json();
    if(!Array.isArray(members)||members.length>1000)throw Error("discord-directory-invalid");
    for(const member of members){
      const id=member?.user?.id;
      if(!ID.test(id||""))continue;
      if(!(member.roles||[]).some(role=>roles.includes(role)))continue;
      found.push({id,username:clean(member.user.username).slice(0,80),
        displayName:clean(member.nick||member.user.global_name||
          member.user.username).slice(0,80)});
    }
    if(members.length<1000)return found.sort((a,b)=>
      a.displayName.localeCompare(b.displayName,"fr"));
    const last=members[members.length-1]?.user?.id;
    if(!ID.test(last||"")||last===after)throw Error("discord-directory-invalid");
    after=last;
  }
  throw Error("discord-directory-too-large");
}
export async function handleAdminPlayerLinks(request,env,fetchImpl=fetch){
  const url=new URL(request.url);
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
    return reply({status:"r2-unavailable"},503);
  if(request.method==="POST"&&
     (request.headers.get("Origin")!==ADMIN_ORIGIN||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type")||"")))
    return reply({status:"forbidden-request"},403);
  try{
    const view=url.searchParams.get("view")||"links";
    if(request.method==="GET"&&view==="links"){
      const items=await loadPlayerLinks(env);
      return reply({status:"ok",items,revision:await sha(items)});
    }
    if(request.method==="GET"&&["alliances","players","discord"].includes(view)){
      const data=await catalog(fetchImpl);
      if(view==="alliances")return reply({status:"ok",alliances:data.alliances});
      const alliance=url.searchParams.get("alliance")||"";
      const meta=data.alliances.find(a=>a.key===alliance);
      if(!meta)return reply({status:"invalid-alliance"},400);
      if(view==="players")return reply({status:"ok",
        players:await playersFor(meta,fetchImpl,env)});
      return reply({status:"ok",members:await discordDirectory(env,
        rolesFor(meta.group,data.groups,meta.key),fetchImpl)});
    }
    if(request.method!=="POST"||view!=="links")
      return reply({status:"invalid-query"},400);
    const raw=await request.text();
    if(raw.length>2500)return reply({status:"invalid-payload"},400);
    let input;
    try{input=JSON.parse(raw);}catch{return reply({status:"invalid-payload"},400);}
    if(!["upsert","delete"].includes(input?.action)||
       !ID.test(input?.discordId||"")||!SLUG.test(input?.alliance||"")||
       !/^[a-f0-9]{64}$/.test(input?.revision||"")||
       (input.action==="upsert"&&!validItem(input)))
      return reply({status:"invalid-payload"},400);
    const items=await loadPlayerLinks(env);
    const revision=await sha(items);
    if(input.revision!==revision)return reply({status:"conflict",revision},409);
    const key=input.alliance,discordId=input.discordId;
    let next=items.filter(x=>!(x.discordId===discordId&&x.alliance===key));
    if(input.action==="upsert"){
      const data=await catalog(fetchImpl);
      const meta=data.alliances.find(a=>a.key===key);
      if(!meta)return reply({status:"invalid-alliance"},400);
      const [names,member]=await Promise.all([
        playersFor(meta,fetchImpl,env),
        discordMember(env,discordId,fetchImpl)
      ]);
      if(!names.includes(input.player)||!Array.isArray(member.roles)||
         !member.roles.some(r=>rolesFor(meta.group,data.groups,meta.key).includes(r)))
        return reply({status:"identity-not-in-registered-group"},422);
      if(next.some(x=>x.alliance===key&&normalized(x.player)===normalized(input.player)))
        return reply({status:"player-already-linked"},409);
      next.push({discordId,alliance:key,player:input.player});
    }
    if(next.length>MAX_ROWS||!distinct(next))
      return reply({status:"registry-limit"},409);
    const updatedAt=new Date().toISOString();
    await env.CAPTAIN_BUCKET.put(PLAYER_LINKS_KEY,
      JSON.stringify({version:1,updatedAt,items:next}),{
        httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
      });
    return reply({status:"ok",items:next,revision:await sha(next)});
  }catch(error){
    // Never expose private member names, raw R2 keys, credentials, or stack traces.
    const reason=String(error?.message||"");
    if(reason==="discord-bot-token-not-configured")
      return reply({status:"discord-not-configured"},503);
    if(reason.startsWith("discord-")||reason==="discord-directory-too-large")
      return reply({status:"discord-unavailable"},503);
    if(reason.startsWith("guest-roster-"))
      return reply({status:"roster-unavailable"},503);
    return reply({status:"unavailable"},503);
  }
}
export async function handleSelfPlayerLinks(request,env,fetchImpl=fetch){
  const origin=request.headers.get("Origin");
  const headers={
    ...secureHeaders,Vary:"Origin",
    ...(origin===SITE?{
      "Access-Control-Allow-Origin":SITE,
      "Access-Control-Allow-Headers":"Authorization",
      "Access-Control-Allow-Methods":"GET, OPTIONS"
    }:{})
  };
  const respond=(data,status=200)=>Response.json(data,{status,headers});
  if(request.method==="OPTIONS")return new Response(null,{
    status:origin===SITE?204:403,headers});
  if(request.method!=="GET")return respond({status:"method-not-allowed"},405);
  if(origin&&origin!==SITE)return respond({status:"forbidden-origin"},403);
  const token=request.headers.get("Authorization")||"";
  if(!/^Bearer v1\.[A-Za-z0-9_-]{12,4096}\.[A-Za-z0-9_-]{40,80}$/.test(token))
    return respond({status:"unauthorized"},401);
  if(!env?.LOSP_AUTH?.fetch||!env?.CAPTAIN_BUCKET?.get)
    return respond({status:"unavailable"},503);
  let session;
  try{
    const authRequest=new Request(AUTH,{headers:{
      Authorization:token,Accept:"application/json"
    },cache:"no-store"});
    const r=await (fetchImpl===fetch?env.LOSP_AUTH.fetch(authRequest):
      fetchImpl(authRequest));
    if(!r.ok)return respond({status:r.status===401||r.status===403?
      "unauthorized":"unavailable"},r.status===401||r.status===403?401:503);
    session=await r.json();
  }catch{return respond({status:"unavailable"},503);}
  if(session?.ok!==true||session.signedSession!==true||
     !ID.test(session.id||"")||
     !["admin","member","guest"].includes(session.role)||
     !Array.isArray(session.allowedAlliances)||
     session.allowedAlliances.length>100||
     session.allowedAlliances.some(k=>!SLUG.test(k)))
    return respond({status:"unauthorized"},401);
  try{
    const allowed=new Set(session.allowedAlliances);
    const items=await loadPlayerLinks(env);
    return respond({status:"ok",links:items
      .filter(i=>i.discordId===session.id&&allowed.has(i.alliance))
      .map(i=>({alliance:i.alliance,player:i.player}))});
  }catch{return respond({status:"unavailable"},503);}
}
