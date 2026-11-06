// Read-only private projection of COMPLETE approved guest roster snapshots.
// The static WebApp never receives Scopely IDs, tokens, raw R2 keys or other tenants.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";
import {headers,verifiedDiscord,selectApproved} from "./secure-guest-arena-history.js";

const PREFIX="roster-batches/v1/";
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const FP=/^[a-f0-9]{64}$/;
const RUN=/^[a-f0-9-]{36}$/;
const DAY=86400000;
const MAX_OBJECT=3100000,MAX_RECEIPT=40000,MAX_RESULT=9000000;
const MAX_MEMBERS=40; // Safe R2 read budget per Worker Free invocation, not a Scopely quota.
const obj=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const int=n=>Number.isSafeInteger(n)&&n>=0;
const date=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
const key=s=>String(s||"").trim().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const cleanName=s=>String(s||"").replace(/<#[0-9a-fA-F]{6}>/g,"").trim();
const reply=(req,value,status=200)=>Response.json(value,{status,headers:headers(req)});

async function read(bucket,path,limit){
  const found=await bucket.get(path);
  if(!found)return null;
  if(Number.isSafeInteger(found.size)&&found.size>limit)
    throw Error("oversized-archive");
  const raw=await found.text();
  if(raw.length>limit)throw Error("oversized-archive");
  return JSON.parse(raw);
}
function manifestValid(m,fp,now){
  if(!obj(m)||m.version!==1||m.fingerprint!==fp||
     !RUN.test(m.runId||"")||!FP.test(m.membershipDigest||"")||
     m.includesPersonal!==true||!int(m.coMembers)||
     !int(m.total)||m.total!==m.coMembers+1||m.total<1||
     m.total>MAX_MEMBERS||!int(m.observedMembers)||
     m.observedMembers<m.total||m.observedMembers>100||
     !Number.isFinite(date(m.capturedAt))||
     date(m.capturedAt)>now||date(m.capturedAt)<now-7*DAY||
     !(date(m.expiresAt)>now)||date(m.expiresAt)<=date(m.capturedAt))
    return false;
  const omitted=m.observedMembers-m.total;
  if(m.coverage===undefined)return omitted===0&&m.notSharedCount===undefined;
  if(m.coverage==="all-members")return omitted===0&&m.notSharedCount===0;
  return m.coverage==="authorized-only"&&omitted>0&&
    int(m.notSharedCount)&&m.notSharedCount===omitted;
}
function isoProjection(raw){
  let isoMax=int(raw.isoMax)?raw.isoMax:null;
  let isoClass=null,isoColor=null;
  if(typeof raw.iso8==="string"){
    const csv=raw.iso8.split(",");
    if(csv.length>=8&&csv.length<=12){
      const candidate=csv[6].trim().toLowerCase();
      const levels=csv.slice(7).map(s=>s.trim());
      if(["striker","fortifier","healer","skirmisher","raider"].includes(candidate)&&
        levels.length&&levels.every(v=>/^\d+$/.test(v)&&int(Number(v)))){
        isoClass=candidate;
        isoMax=Math.max(isoMax??0,...levels.map(Number));
      }
    }
  }else if(obj(raw.iso8)){
    const candidate=String(raw.iso8.activeClass||raw.iso8.class||"").toLowerCase();
    if(["striker","fortifier","healer","skirmisher","raider"].includes(candidate))
      isoClass=candidate;
    const color=String(raw.iso8.matrixColor||"").toLowerCase();
    if(["green","blue","purple","orange"].includes(color))isoColor=color;
  }
  return {isoMax,isoClass,isoColor};
}
function projectCharacter(raw){
  if(!obj(raw)||typeof raw.id!=="string"||
     !/^[A-Za-z0-9:_-]{1,180}$/.test(raw.id)||!int(raw.power))
    throw Error("invalid-character");
  const id=key(raw.id);
  if(!id)throw Error("invalid-character-id");
  const value={power:raw.power};
  for(const [field,candidate] of [
    ["level",raw.level],["gear",raw.gearTier??raw.gear],
    ["yellowStars",raw.activeYellow??raw.yellowStars]
  ])if(int(candidate))value[field]=candidate;
  const reds=raw.activeRed??raw.redStars;
  if(int(reds))value.redStars=Math.min(7,reds);
  const diamonds=raw.activeRed===undefined?raw.diamonds:
    (int(raw.activeRed)?Math.max(0,raw.activeRed-7):null);
  if(int(diamonds))value.diamonds=diamonds;
  const abilities={};
  for(const kind of ["basic","special","ultimate","passive"])
    if(int(raw[kind]))abilities[kind]=raw[kind];
  if(Object.keys(abilities).length)value.abilities=abilities;
  const iso=isoProjection(raw);
  if(iso.isoMax!==null)value.isoMax=iso.isoMax;
  const isoData={};
  if(iso.isoClass)isoData.isoClass=iso.isoClass;
  if(iso.isoColor)isoData.isoColor=iso.isoColor;
  return {id,value,iso:isoData};
}
function projectMember(row,fp,manifest,index,now){
  const self=index==="self";
  if(!obj(row)||row.version!==1||row.allianceFingerprint!==fp||
     row.runId!==manifest.runId||row.memberIndex!==index||
     row.kind!==(self?"private-staged-personal-roster":"private-staged-microbatch")||
     typeof row.name!=="string"||row.name.length>140||
     !key(cleanName(row.name))||
     typeof row.volatileMemberId!=="string"||
     !row.volatileMemberId||row.volatileMemberId.length>256||
     !Array.isArray(row.characters)||row.characters.length<1||
     row.characters.length>800||date(row.expiresAt)!==date(manifest.expiresAt)||
     !Number.isFinite(date(row.capturedAt))||
     date(row.capturedAt)>date(manifest.capturedAt)||
     date(row.capturedAt)>now||date(row.expiresAt)<=now)
    throw Error("invalid-member");
  const chars={},iso={};
  for(const raw of row.characters){
    const c=projectCharacter(raw);
    if(Object.hasOwn(chars,c.id))throw Error("duplicate-character");
    chars[c.id]=c.value;
    if(Object.keys(c.iso).length)iso[c.id]=c.iso;
  }
  return {player:cleanName(row.name),chars,iso,
    // Never include volatileMemberId in any browser response.
    _privateId:row.volatileMemberId};
}
export async function projectAlliance(bucket,fp,alliance,now){
  const root=PREFIX+fp+"/";
  const m=await read(bucket,root+"latest-complete.json",MAX_RECEIPT);
  if(!m)return {alliance,state:"not-collected",rosters:[]};
  if(!manifestValid(m,fp,now))return {alliance,state:"no-valid-snapshot",rosters:[]};
  const roster=[],ids=new Set(),names=new Set();
  for(let start=0;start<m.total;start+=4){
    const indices=Array.from({length:Math.min(4,m.total-start)},(_,i)=>start+i);
    const members=await Promise.all(indices.map(i=>{
      const index=i===m.coMembers?"self":i;
      const path=root+m.runId+"/member-"+index+".json";
      return read(bucket,path,MAX_OBJECT).then(record=>
        record?projectMember(record,fp,m,index,now):null);
    }));
    for(const p of members){
      if(!p)throw Error("incomplete-roster");
      const name=key(p.player);
      if(names.has(name)||ids.has(p._privateId))
        throw Error("ambiguous-member");
      names.add(name);ids.add(p._privateId);
      const {_privateId,...publicPlayer}=p;
      roster.push({...publicPlayer,alliance});
    }
  }
  // A newer collection must not change the pointer during this projection.
  const final=await read(bucket,root+"latest-complete.json",MAX_RECEIPT);
  if(!manifestValid(final,fp,now)||final.runId!==m.runId||
     final.membershipDigest!==m.membershipDigest||
     final.capturedAt!==m.capturedAt)
    throw Error("snapshot-changed");
  return {alliance,state:"complete",capturedAt:m.capturedAt,rosters:roster};
}

export async function secureGuestRosters(request,env,now=Date.now(),fetchImpl=fetch){
  if(request.method==="OPTIONS")
    return new Response(null,{status:request.headers.get("Origin")===
      "https://keryas777.github.io"?204:403,headers:headers(request)});
  if(request.method!=="GET")
    return reply(request,{status:"method-not-allowed"},405);
  if(request.headers.get("Origin")&&request.headers.get("Origin")!==
      "https://keryas777.github.io")
    return reply(request,{status:"forbidden-origin"},403);
  const params=new URL(request.url).searchParams;
  const keys=[...params.keys()];
  if(keys.length!==1||keys[0]!=="alliance"||
     params.getAll("alliance").length!==1||
     !KEY.test(params.get("alliance")||""))
    return reply(request,{status:"invalid-query"},400);
  if(!Number.isFinite(now)||!env?.CAPTAIN_BUCKET?.get||
     !env?.LOSP_AUTH?.fetch)
    return reply(request,{status:"unavailable"},503);
  const verifiedFetch=fetchImpl===fetch?
    (...args)=>env.LOSP_AUTH.fetch(...args):fetchImpl;
  const auth=await verifiedDiscord(request,verifiedFetch);
  if(auth.status!=="ok")
    return reply(request,{status:auth.status},
      auth.status==="unauthorized"?401:503);
  const alliance=params.get("alliance");
  if(!auth.allowed.has(alliance))
    return reply(request,{status:"forbidden"},403);
  try{
    const [guest,losp]=await Promise.all([
      readGuestApprovals(env),readApproval(env)]);
    const approved=selectApproved(guest,losp,[alliance]);
    if(!approved)return reply(request,
      {status:"alliance-not-bound-or-not-approved"},409);
    const projection=await projectAlliance(env.CAPTAIN_BUCKET,
      approved[0].fingerprint,alliance,now);
    const payload={status:"ok",version:1,kind:"authorized-guest-rosters",
      alliance:projection.alliance,state:projection.state,
      ...(projection.capturedAt?{capturedAt:projection.capturedAt}:{}),
      rosters:projection.rosters};
    if(JSON.stringify(payload).length>MAX_RESULT)
      throw Error("oversized-projection");
    return reply(request,payload);
  }catch{
    return reply(request,{status:"unavailable"},503);
  }
}
