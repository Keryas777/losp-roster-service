// Signed, read-only Infos projection for approved invited alliances.
// Player cards stay in private R2; never publish them in GitHub Pages Infos.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {headers,verifiedDiscord,selectApproved} from "./secure-guest-arena-history.js";

const ROOT="roster-batches/v1/";
const ORIGIN="https://keryas777.github.io";
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const MS_DAY=86400000,MAX_AGE=7*MS_DAY,MAX_OBJECT=200000;
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const validNum=x=>Number.isSafeInteger(x)&&x>=0;
const validString=x=>typeof x==="string"&&x.length<=1000;
const nameKey=x=>String(x||"").trim().toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const reply=(req,data,status=200)=>Response.json(data,{status,headers:headers(req)});

function requestedKeys(url){
  if([...url.searchParams.keys()].join(",")!=="alliances"||
     url.searchParams.getAll("alliances").length!==1)return null;
  const raw=url.searchParams.get("alliances")||"";
  if(raw==="approved")return {approved:true,keys:[]};
  if(raw.length>1500)return null;
  const keys=raw.split(",");
  if(!keys.length||keys.length>20||keys.some(k=>!KEY.test(k))||
     new Set(keys).size!==keys.length)return null;
  return {approved:false,keys};
}
async function read(bucket,path){
  const obj=await bucket.get(path);
  if(!obj)return null;
  if(Number.isSafeInteger(obj.size)&&obj.size>MAX_OBJECT)
    throw Error("oversized-source");
  const raw=await obj.text();
  if(raw.length>MAX_OBJECT)throw Error("oversized-source");
  return JSON.parse(raw);
}
export function projectInfoReceipt(source,fp,campaign,key,now){
  if(!isObject(source)||source.version!==1||
     source.kind!=="alliance-infos-campaign"||
     source.allianceFingerprint!==fp||source.campaign!==campaign||
     typeof source.allianceName!=="string"||
     !source.allianceName.trim()||source.allianceName.length>140||
     !Array.isArray(source.rows)||source.rows.length<1||
     source.rows.length>100)return null;
  const captured=Date.parse(source.capturedAt||"");
  const expires=Date.parse(source.expiresAt||"");
  const day=campaign.slice(0,10);
  if(!Number.isFinite(captured)||captured>now||captured<now-MAX_AGE||
     !Number.isFinite(expires)||expires<=now||expires>captured+MAX_AGE||
     source.capturedAt.slice(0,10)!==day)return null;
  // Full, enriched Infos contract, accessible only through signed Discord scope.
  const integerFields=["stp","charactersCollected","daysInAlliance",
    "charactersAtMaxStarRank","bestArena","latestArena","latestBlitz",
    "blitzWins","wwPoints"];
  const seen=new Set(),players=[];
  for(const p of source.rows){
    if(!isObject(p)||typeof p.name!=="string"||
       !p.name.trim()||p.name.length>140||!nameKey(p.name)||
       p.alliance!==source.allianceName||
       !validNum(p.tcp)||!validNum(p.war_mvp)||
       !validString(p.icon)||!validString(p.frame)||
       seen.has(nameKey(p.name)))return null;
    seen.add(nameKey(p.name));
    const info={name:p.name,alliance:key,tcp:p.tcp,
      war_mvp:p.war_mvp,icon:p.icon,frame:p.frame};
    for(const field of integerFields)
      if(Object.hasOwn(p,field)){
        if(!validNum(p[field]))return null;
        info[field]=p[field];
      }
    if(Object.hasOwn(p,"rank")){
      if(!["leader","captain","member"].includes(p.rank))return null;
      info.rank=p.rank;
    }
    if(Object.hasOwn(p,"rosterShare")){
      if(typeof p.rosterShare!=="boolean")return null;
      info.rosterShare=p.rosterShare;
    }
    if(Object.hasOwn(p,"profileStatus")){
      if(p.profileStatus!=="unavailable")return null;
      info.profileStatus=p.profileStatus;
    }
    if(Object.hasOwn(p,"aid")){
      if(!(typeof p.aid==="string"&&p.aid.length<=256)&&
         !validNum(p.aid))return null;
      info.aid=p.aid;
    }
    for(const field of ["level","qualifications"])
      if(Object.hasOwn(p,field)){
        if(!isObject(p[field])||
           JSON.stringify(p[field]).length>(field==="level"?1000:4000))
          return null;
        info[field]=p[field];
      }
    players.push(info);
  }
  return {alliance:key,state:"complete",capturedAt:source.capturedAt,players};
}
async function newestInfo(bucket,alliance,now){
  // Existing collectors write two UTC campaigns per day, not a "latest"
  // pointer. Read newest first; never call Scopely or archive data here.
  const today=Date.parse(new Date(now).toISOString().slice(0,10)+"T00:00:00Z");
  for(let offset=0;offset<=7;offset++){
    const day=new Date(today-offset*MS_DAY).toISOString().slice(0,10);
    for(const period of ["pm","am"]){
      const campaign=day+"-"+period;
      const path=ROOT+alliance.fingerprint+"/campaigns/"+campaign+"-infos.json";
      const record=await read(bucket,path);
      if(!record)continue;
      return projectInfoReceipt(record,alliance.fingerprint,campaign,
        alliance.allianceKey,now)||
        {alliance:alliance.allianceKey,state:"invalid-snapshot",players:[]};
    }
  }
  return {alliance:alliance.allianceKey,state:"not-collected",players:[]};
}
export async function secureGuestInfos(request,env,now=Date.now(),fetchImpl=fetch){
  if(request.method==="OPTIONS")
    return new Response(null,{status:request.headers.get("Origin")===ORIGIN?204:403,
      headers:headers(request)});
  if(request.method!=="GET")
    return reply(request,{status:"method-not-allowed"},405);
  if(request.headers.get("Origin")&&request.headers.get("Origin")!==ORIGIN)
    return reply(request,{status:"forbidden-origin"},403);
  const parsed=requestedKeys(new URL(request.url));
  if(!parsed)return reply(request,{status:"invalid-query"},400);
  if(!Number.isFinite(now)||!env?.CAPTAIN_BUCKET?.get)
    return reply(request,{status:"unavailable",reason:"r2-binding-missing"},503);
  if(!env?.LOSP_AUTH?.fetch)
    return reply(request,{status:"auth-unavailable",reason:"auth-binding-missing"},503);
  const signedFetch=fetchImpl===fetch?
    (...args)=>env.LOSP_AUTH.fetch(...args):fetchImpl;
  const auth=await verifiedDiscord(request,signedFetch);
  if(auth.status!=="ok")
    return reply(request,{status:auth.status,
      ...(auth.reason?{reason:auth.reason}:{})},
      auth.status==="unauthorized"?401:503);
  if(parsed.approved&&auth.role!=="admin")
    return reply(request,{status:"forbidden"},403);
  if(parsed.keys.some(key=>!auth.allowed.has(key)))
    return reply(request,{status:"forbidden"},403);
  try{
    const [guests,losp]=await Promise.all([
      readGuestApprovals(env),readApproval(env)
    ]);
    if(guests.status==="invalid-registry"||losp.status==="invalid-registry")
      return reply(request,{status:"unavailable",
        reason:"approval-registry-invalid"},503);
    const keys=parsed.approved?
      [...new Set((guests.alliances||[]).map(a=>a.allianceKey)
        .filter(k=>KEY.test(k||"")&&auth.allowed.has(k)))].sort():
      parsed.keys;
    if(keys.length>20)return reply(request,{status:"invalid-query"},400);
    const selected=selectApproved(guests,losp,keys);
    if(!selected)return reply(request,
      {status:"alliance-not-bound-or-not-approved"},409);
    const alliances=[];
    for(const alliance of selected)
      alliances.push(await newestInfo(env.CAPTAIN_BUCKET,alliance,now));
    return reply(request,{status:"ok",version:1,
      kind:"authorized-guest-infos",alliances});
  }catch{
    // Never expose fingerprints, raw receipt paths or player identifiers.
    return reply(request,{status:"unavailable",
      reason:"private-r2-read-failed"},503);
  }
}
