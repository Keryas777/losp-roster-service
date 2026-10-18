// Explicit allowlist of official READ-only routes. Every upstream field is
// kept in the original payload, including meta and unknown future fields.
// No POST/PUT/DELETE, arbitrary paths, session cookies or tokens exposed.
import {API_KEY} from "./player-card.js";
import {CAPTAIN_PREFIX,validCaptainKey,captainConfigReady} from "./captain-vault.js";
import {scanPrivateCoverage} from "./alliance-coverage.js";
const API="https://api.marvelstrikeforce.com";
const PAGE_IDS=new Set(["personal-roster","personal-inventory","personal-wishlist",
  "personal-events","alliance-roster","game-characters","game-events"]);
export const API_RESOURCES=Object.freeze([
  {id:"player-card",label:"Profil joueur",path:"/player/v1/card",scope:"m3p.f.pr.pro"},
  {id:"personal-roster",label:"Roster personnel",path:"/player/v1/roster",scope:"m3p.f.pr.ros"},
  {id:"personal-inventory",label:"Inventaire personnel",path:"/player/v1/inventory",scope:"m3p.f.pr.inv"},
  {id:"personal-wishlist",label:"Liste de souhaits",path:"/player/v1/itemWishlist",scope:"m3p.f.pr.inv"},
  {id:"personal-squads",label:"Équipes enregistrées",path:"/player/v1/squads",scope:"m3p.f.pr.ros"},
  {id:"personal-events",label:"Événements et progression",path:"/player/v1/events",scope:"m3p.f.pr.act"},
  {id:"alliance-card",label:"Fiche d’alliance",path:"/player/v1/alliance/card",scope:"m3p.f.ar.pro"},
  {id:"alliance-members",label:"Membres de l’alliance",path:"/player/v1/alliance/members",scope:"m3p.f.ar.pro"},
  {id:"alliance-roster",label:"Roster partagé d’un membre",path:"/player/v1/roster/member/",scope:"m3p.f.ar.ros"},
  {id:"game-characters",label:"Catalogue des personnages",path:"/game/v1/characters",scope:null},
  {id:"game-events",label:"Événements de jeu",path:"/game/v1/events",scope:null},
  {id:"game-traits",label:"Traits",path:"/game/v1/traits",scope:null},
  {id:"game-iso8",label:"Capacités ISO-8",path:"/game/v1/iso8Abilities",scope:null},
  {id:"game-upgrades",label:"Paliers d’amélioration",path:"/game/v1/upgradeData",scope:null},
  {id:"game-raids",label:"Définitions des raids",path:"/game/v1/raids",scope:null},
  {id:"game-raid-groups",label:"Groupes de raids",path:"/game/v1/raidGroups",scope:null},
  {id:"game-languages",label:"Langues du jeu",path:"/game/v1/languages",scope:null},
  {id:"game-scopes",label:"Permissions API",path:"/game/v1/scopes",scope:null},
  {id:"game-decorations",label:"Décorations",path:"/game/v1/decorations",scope:null},
  {id:"game-caps",label:"Plafonds des personnages",path:"/game/v1/characterInstanceCaps",scope:null},
  {id:"game-dark-dimensions",label:"Dimensions obscures",path:"/game/v1/dds",scope:null},
  {id:"game-pyp",label:"Pick Your Poison",path:"/game/v1/pickYourPoisons",scope:null},
  {id:"game-towers",label:"Tours de survie",path:"/game/v1/survivalTowers",scope:null},
  {id:"game-character",label:"Fiche détaillée d’un personnage",path:"/game/v1/characters/",scope:null},
  {id:"game-item",label:"Fiche détaillée d’un objet",path:"/game/v1/items/",scope:null},
  {id:"game-raid",label:"Détail d’un raid",path:"/game/v1/raids/",scope:null},
  {id:"game-iso8-detail",label:"Détail d’une capacité ISO-8",path:"/game/v1/iso8Abilities/",scope:null},
  {id:"personal-event",label:"Détail d’un événement personnel",path:"/player/v1/events/",scope:"m3p.f.pr.act"}
]);
const byId=new Map(API_RESOURCES.map(r=>[r.id,r]));
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9:_-]{1,256}$/.test(id);
function json(data,status=200){return Response.json(data,{status,headers:{
  "Cache-Control":"private, no-store","Pragma":"no-cache","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"
}});}
function providerError(status){return status===401?"unauthorized":status===403?"forbidden":
  status===429?"rate-limited":status===472?"too-large":status>=500?"provider-unavailable":"provider-error";}
async function getProvider(path,accessToken,fetchImpl=fetch){
  try{
    const upstream=await fetchImpl(API+path,{
      method:"GET",cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(12000),
      headers:{"Authorization":"Bearer "+accessToken,"x-api-key":API_KEY,
        "User-Agent":"APIClient/1.0 (Server)","Accept":"application/json"}
    });
    if(!upstream.ok)return {error:providerError(upstream.status),httpStatus:upstream.status};
    const size=Number(upstream.headers.get("content-length")||0);
    if(size>3000000)return {error:"too-large"};
    const raw=await upstream.text();
    if(raw.length>3000000)return {error:"too-large"};
    const value=JSON.parse(raw);
    if(!value||typeof value!=="object"||Array.isArray(value))
      return {error:"invalid-provider-response"};
    return {payload:value};
  }catch{return {error:"network-or-provider-error"};}
}
function queryFor(resource,url){
  const qs=new URLSearchParams();
  qs.set("lang","fr");
  if(PAGE_IDS.has(resource.id)){
    const page=Number(url.searchParams.get("page")||"1");
    const size=Number(url.searchParams.get("perPage")||"20");
    if(!Number.isSafeInteger(page)||page<1||page>1000||
       !Number.isSafeInteger(size)||size<1||size>50)return null;
    qs.set("page",String(page));qs.set("perPage",String(size));
  }
  if(["personal-roster","alliance-roster","game-characters"].includes(resource.id)){
    qs.set("charInfo","full");
    qs.set("statsFormat","object");
  }
  if(["personal-inventory","personal-wishlist","personal-events","game-events"].includes(resource.id)){
    qs.set("itemFormat","object");qs.set("pieceInfo","full");
    qs.set("statsFormat","object");
  }
  if(resource.id==="personal-events")qs.set("eventInfo","full");
  return qs.toString();
}
async function grantForKey(env,key){
  const stub=env.CAPTAIN_REFRESH_COORDINATOR.get(env.CAPTAIN_REFRESH_COORDINATOR.idFromName(key));
  const res=await stub.fetch(new Request("https://captain-coordinator.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"access",key})
  }));
  if(!res.ok)return null;
  const body=await res.json();
  return body.status==="active"&&typeof body.accessToken==="string"?
    {accessToken:body.accessToken,
      accessExpiresAt:Number.isSafeInteger(body.accessExpiresAt)?body.accessExpiresAt:null,
      lastRotatedAt:Number.isSafeInteger(body.lastRotatedAt)?body.lastRotatedAt:null,
      observedRotations:Number.isSafeInteger(body.observedRotations)?body.observedRotations:null
    }:null;
}
async function tokenForKey(env,key){
  return (await grantForKey(env,key))?.accessToken||null;
}
// Private aggregate only. Never forward arbitrary contents from R2.
export async function adminRefreshCron(env){
  if(!captainConfigReady(env))return json({error:"storage-unavailable"},503);
  try{
    const obj=await env.CAPTAIN_BUCKET.get("oauth-monitoring/v1/last-refresh-check.json");
    if(!obj)return json({status:"not-yet-observed",checkedAt:null});
    const data=JSON.parse(await obj.text());
    if(data?.version!==1||!["ok","partial"].includes(data.status)||
      !Number.isSafeInteger(data.checked)||data.checked<0||
      !Number.isSafeInteger(data.failed)||data.failed<0||
      !Number.isSafeInteger(data.rotated)||data.rotated<0||
      data.failed>data.checked||data.rotated>data.checked||
      typeof data.checkedAt!=="string"||Number.isNaN(Date.parse(data.checkedAt)))
      return json({error:"invalid-monitoring-data"},503);
    return json({status:data.status,checkedAt:data.checkedAt,
      checked:data.checked,failed:data.failed,rotated:data.rotated});
  }catch{return json({error:"monitoring-unavailable"},503);}
}
// Private, bounded, read-only census across stored captain grants.
// Admin authentication is enforced for this route by handleAdmin.
export async function adminCoverage(env,fetchImpl=fetch){
  if(!captainConfigReady(env))return json({error:"storage-unavailable"},503);
  try{
    const snapshot=await scanPrivateCoverage(env,fetchImpl);
    return snapshot?json(snapshot):json({error:"coverage-unavailable"},503);
  }catch{return json({error:"coverage-unavailable"},503);}
}
export async function adminSessionList(env,fetchImpl=fetch,url){
  if(!captainConfigReady(env))return json({error:"storage-unavailable"},503);
  const limit=10,cursor=url.searchParams.get("cursor")||undefined;
  if(cursor&&(cursor.length>1024||!/^[A-Za-z0-9_=-]+$/.test(cursor)))
    return json({error:"invalid-cursor"},400);
  const listing=await env.CAPTAIN_BUCKET.list({prefix:CAPTAIN_PREFIX,limit,
    ...(cursor?{cursor}:{})});
  const sessions=[];
  for(const item of listing.objects||[]){
    if(!validCaptainKey(item.key))continue;
    const grant=await grantForKey(env,item.key);
    if(!grant){sessions.push({id:item.key.slice(CAPTAIN_PREFIX.length),
      status:"unavailable"});continue;}
    const [profile,alliance]=await Promise.all([
      getProvider("/player/v1/card",grant.accessToken,fetchImpl),
      getProvider("/player/v1/alliance/card",grant.accessToken,fetchImpl)
    ]);
    const card=alliance.payload?.data,player=profile.payload?.data;
    // Only provide labels in the admin response; raw fields remain available
    // through the dedicated resource readers after permission checks.
    sessions.push({id:item.key.slice(CAPTAIN_PREFIX.length),
      status:card&&player?"active":"partial",
      playerName:typeof player?.name==="string"?player.name:null,
      allianceName:typeof card?.name==="string"?card.name:null,
      allianceId:typeof card?.id==="string"?card.id.split(":")[0]:null,
      allianceDetails:card&&typeof card==="object"?card:null,
      accessExpiresAt:grant.accessExpiresAt,
      lastRotatedAt:grant.lastRotatedAt,
      observedRotations:grant.observedRotations,
      profileError:profile.error||null,allianceError:alliance.error||null});
  }
  return json({sessions,nextCursor:listing.truncated?listing.cursor:null});
}
export async function adminResource(request,env,fetchImpl=fetch){
  if(!captainConfigReady(env))return json({error:"storage-unavailable"},503);
  const url=new URL(request.url);
  const resource=byId.get(url.searchParams.get("resource"));
  const sid=url.searchParams.get("session"),member=url.searchParams.get("member");
  if(!resource||!sid||!/^[a-f0-9]{64}$/.test(sid))return json({error:"invalid-request"},400);
  const query=queryFor(resource,url);
  if(query===null)return json({error:"invalid-pagination"},400);
  const key=CAPTAIN_PREFIX+sid;
  if(!validCaptainKey(key))return json({error:"invalid-session"},400);
  const token=await tokenForKey(env,key);
  if(!token)return json({error:"session-unavailable"},503);
  let path=resource.path;
  if(resource.id==="alliance-roster"){
    if(!validId(member))return json({error:"member-required"},400);
    // Always revalidate on the CURRENT alliance. Cannot query past members
    // or anyone who has not explicitly enabled roster sharing.
    const current=await getProvider("/player/v1/alliance/members",token,fetchImpl);
    if(current.error)return json({error:current.error},502);
    const members=current.payload?.data;
    if(!Array.isArray(members)||members.filter(m=>m?.isSelf===true).length!==1 ||
       !members.some(m=>m?.id===member&&m?.isSelf!==true&&m?.card?.rosterShare===true))
      return json({error:"not-a-current-shared-member"},403);
    path+=encodeURIComponent(member);
  }
  if(resource.path.endsWith("/") && resource.id!=="alliance-roster"){
    const entity=url.searchParams.get("entity");
    if(!validId(entity))return json({error:"entity-required"},400);
    path+=encodeURIComponent(entity);
  }
  const result=await getProvider(path+(query?"?"+query:""),token,fetchImpl);
  if(result.error)return json({error:result.error,upstreamStatus:result.httpStatus||null},502);
  // Whole original Scopely payload, including every nested field and meta.
  return json({resource:resource.id,receivedAt:new Date().toISOString(),
    path:resource.path,payload:result.payload});
}
export const adminCatalog=()=>json({resources:API_RESOURCES});
