// Authenticated, per-alliance guest Arena read for GitHub Pages.
// Only /signed-access can authorize access: /me accepts LEGACY unsigned
// sessions and must NEVER be used to disclose private player names/ranks.
// All ranks come from existing private R2 reward receipts or guest archives.
// A request cannot set fingerprints, raw alliance names or an arbitrary group.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";

const SITE_ORIGIN="https://keryas777.github.io";
const AUTH_URL="https://losp-auth.deliriousfan7.workers.dev/signed-access";
const ROOT="roster-batches/v1/";
const ARCHIVE=ROOT+"guest-arena-history/rolling.json";
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const FP=/^[0-9a-f]{64}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const DAYS=30,DAY_MS=86400000;
const MAX_HISTORY=2100000,MAX_RECEIPT=240000;
const rank=n=>Number.isSafeInteger(n)&&n>0;
const safe=s=>typeof s==="string"&&s.trim().length>0&&s.length<=140;
const time=s=>typeof s==="string"&&Number.isFinite(Date.parse(s));
function dateAtParis(ms){
  const items=new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(ms));
  const p=Object.fromEntries(items.filter(x=>["day","month","year"].includes(x.type))
    .map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day;
}
function headers(request){
  const origin=request.headers.get("Origin");
  return {
    ...(origin===SITE_ORIGIN?{"Access-Control-Allow-Origin":SITE_ORIGIN,
      "Access-Control-Allow-Methods":"GET, OPTIONS",
      "Access-Control-Allow-Headers":"Authorization",
      "Access-Control-Max-Age":"600"}:{}),
    "Vary":"Origin","Cache-Control":"private, no-store",
    "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex",
    "Referrer-Policy":"no-referrer"
  };
}
const respond=(request,data,status=200)=>
  Response.json(data,{status,headers:headers(request)});
async function read(bucket,key,max){
  const object=await bucket.get(key);
  if(!object)return null;
  if(Number.isSafeInteger(object.size)&&object.size>max)
    throw Error("oversized-source");
  const raw=await object.text();
  if(raw.length>max)throw Error("oversized-source");
  return JSON.parse(raw);
}
function currentDay(now){return dateAtParis(now);}
function validDate(value,now){
  if(!DAY.test(value||""))return false;
  const ms=Date.parse(value+"T00:00:00Z");
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value&&
    value<=currentDay(now)&&ms>=now-DAYS*DAY_MS;
}
function receiptRows(source,fp,day,now){
  if(!source||source.version!==1||source.kind!=="alliance-infos-reward"||
     source.allianceFingerprint!==fp||source.campaign!==day+"-reward"||
     !safe(source.allianceName)||!time(source.capturedAt)||
     !time(source.expiresAt)||Date.parse(source.expiresAt)<=now||
     Date.parse(source.capturedAt)>now||
     source.capturedAt.slice(0,10)!==day||
     !Array.isArray(source.rows)||!source.rows.length||source.rows.length>100)
    return null;
  const observed=new Map();
  if(Array.isArray(source.observedAt)&&source.observedAt.length<=100)
    for(const p of source.observedAt)
      if(safe(p?.name)&&time(p.at)&&Date.parse(p.at)<=Date.parse(source.capturedAt))
        observed.set(p.name,p.at);
  const rows=source.rows.filter(x=>safe(x?.name)&&rank(x.latestArena))
    .map(x=>({name:x.name,arenaRank:x.latestArena,
      ...(observed.has(x.name)?{observedAt:observed.get(x.name)}:{})}));
  if(!rows.length)return null;
  return {name:source.allianceName,rows,capturedAt:source.capturedAt};
}
function parseKeys(url){
  if([...url.searchParams.keys()].join(",")!=="alliances")return null;
  const raw=url.searchParams.get("alliances")||"";
  if(raw.length>1500)return null;
  const keys=raw.split(",");
  if(!keys.length||keys.length>20||keys.some(k=>!KEY.test(k))||
    new Set(keys).size!==keys.length)return null;
  return keys;
}
async function verifiedDiscord(request,fetchImpl){
  const auth=request.headers.get("Authorization")||"";
  // Signed HMAC session only. Existing auth worker rechecks Discord roles.
  if(!/^Bearer v1\.[A-Za-z0-9_-]{12,4096}\.[A-Za-z0-9_-]{40,80}$/.test(auth))
    return {status:"unauthorized"};
  let response;
  try{
    response=await fetchImpl(AUTH_URL,{method:"GET",
      headers:{"Authorization":auth,"Accept":"application/json"},
      redirect:"error",cache:"no-store"});
  }catch{return {status:"auth-unavailable"};}
  if(!response||response.status===401||response.status===403)
    return {status:"unauthorized"};
  if(!response.ok)return {status:"auth-unavailable"};
  let data;
  try{data=await response.json();}catch{return {status:"auth-unavailable"};}
  if(data?.ok!==true||data.signedSession!==true||
     !["admin","guest"].includes(data.role)||
     !Array.isArray(data.allowedAlliances)||data.allowedAlliances.length>100||
     data.allowedAlliances.some(x=>!KEY.test(x)))
    return {status:"unauthorized"};
  if(data.role==="guest"&&(!KEY.test(data.groupKey)||data.groupKey==="losp"))
    return {status:"unauthorized"};
  return {status:"ok",role:data.role,allowed:new Set(data.allowedAlliances)};
}
function selectApproved(guest,losp,keys){
  if(guest.status==="invalid-registry"||losp.status==="invalid-registry")
    throw Error("invalid-approvals");
  const owned=new Set((losp.alliances||[]).map(a=>a.fingerprint));
  const byKey=new Map();
  for(const a of guest.alliances||[]){
    if(!FP.test(a.fingerprint)||owned.has(a.fingerprint)||!a.allianceKey)continue;
    if(byKey.has(a.allianceKey))throw Error("duplicate-guest-key");
    byKey.set(a.allianceKey,a);
  }
  const selected=keys.map(k=>byKey.get(k)).filter(Boolean);
  if(selected.length!==keys.length)return null;
  return selected;
}
function playerPublic(p,allianceKey){
  return {name:p.name,alliance:allianceKey,arenaRank:p.arenaRank,
    ...(time(p.observedAt)?{observedAt:p.observedAt}:{})};
}
async function verifiedReceipt(bucket,fp,day,now){
  try{
    const x=await read(bucket,ROOT+fp+"/campaigns/"+day+"-reward-infos.json",
      MAX_RECEIPT);
    return receiptRows(x,fp,day,now);
  }catch{return null;}
}
export async function secureGuestArenaHistory(request,env,now=Date.now(),
  fetchImpl=fetch){
  if(request.method==="OPTIONS")
    return new Response(null,{status:request.headers.get("Origin")===SITE_ORIGIN?204:403,
      headers:headers(request)});
  if(request.method!=="GET")return respond(request,{status:"method-not-allowed"},405);
  if(request.headers.get("Origin")&&
     request.headers.get("Origin")!==SITE_ORIGIN)
    return respond(request,{status:"forbidden-origin"},403);
  if(!Number.isFinite(now)||!env?.CAPTAIN_BUCKET?.get)
    return respond(request,{status:"unavailable"},503);
  const keys=parseKeys(new URL(request.url));
  if(!keys)return respond(request,{status:"invalid-query"},400);
  // A Workers Service Binding is mandatory: never relay a private session
  // to an arbitrary external URL or fall back to unsigned /me.
  if(!env?.LOSP_AUTH?.fetch)
    return respond(request,{status:"auth-unavailable"},503);
  const signedFetch=fetchImpl===fetch?
    (...args)=>env.LOSP_AUTH.fetch(...args):fetchImpl;
  const auth=await verifiedDiscord(request,signedFetch);
  if(auth.status!=="ok")
    return respond(request,{status:auth.status},
      auth.status==="unauthorized"?401:503);
  if(keys.some(k=>!auth.allowed.has(k)))
    return respond(request,{status:"forbidden"},403);
  try{
    const [guests,losp]=await Promise.all([
      readGuestApprovals(env),readApproval(env)
    ]);
    const approved=selectApproved(guests,losp,keys);
    if(!approved)return respond(request,
      {status:"alliance-not-bound-or-not-approved"},409);
    const bucket=env.CAPTAIN_BUCKET;
    const archive=await read(bucket,ARCHIVE,MAX_HISTORY);
    if(archive&&(archive.version!==1||!Array.isArray(archive.snapshots)||
      archive.snapshots.length>35))throw Error("invalid-history");
    const byDay=new Map(),sourceCache=new Map();
    // Older archives predate tenant-key stamping. The only safe legacy
    // attribution is a *single* globally approved guest, cross-checked
    // against its original private receipt. Never guess across guests
    // that could share the same styled in-game alliance name.
    const allowLegacyUntagged=guests.alliances.length===1&&
      approved.length===1;
    async function source(fp,day){
      const id=fp+":"+day;
      if(!sourceCache.has(id))
        sourceCache.set(id,await verifiedReceipt(bucket,fp,day,now));
      return sourceCache.get(id);
    }
    // Historical receipts can expire after 7 days. For newer archives,
    // embedded allianceKey preserves precise tenant attribution for 30 days.
    // Older, untagged entries are served only when an original private
    // receipt proves the EXACT player's name, rank and alliance name.
    for(const snap of archive?.snapshots||[]){
      if(!validDate(snap?.date,now)||!Array.isArray(snap.players)||
         snap.players.length>500)continue;
      const byName=new Map(),duplicateNames=new Set();
      // Already tagged archives need no additional reads. Older (untagged)
      // entries can be verified only against their original R2 receipt.
      if(allowLegacyUntagged&&snap.players.some(p=>!p?.allianceKey)){
        for(const a of approved){
          const record=await source(a.fingerprint,snap.sourceDay||snap.date);
          if(!record)continue;
          if(byName.has(record.name))duplicateNames.add(record.name);
          else byName.set(record.name,{key:a.allianceKey,record});
        }
      }
      const players=[],seen=new Set();
      for(const p of snap.players){
        if(!safe(p?.name)||!rank(p.arenaRank))continue;
        let k=null;
        if(p.allianceKey&&keys.includes(p.allianceKey)){
          // Tenant keys are stamped on PRIVATE records at capture time,
          // never accepted from a client-provided value.
          k=p.allianceKey;
        }else if(allowLegacyUntagged&&!p.allianceKey&&
          !duplicateNames.has(p.alliance)){
          const proof=byName.get(p.alliance);
          if(proof&&proof.record.rows.some(row=>
            row.name===p.name&&row.arenaRank===p.arenaRank))
            k=proof.key;
        }
        if(!k)continue;
        const id=k+":"+p.name;
        if(seen.has(id))continue;
        seen.add(id);
        players.push(playerPublic(p,k));
      }
      if(players.length)
        byDay.set(snap.date,{date:snap.date,
          sourceDay:snap.sourceDay||snap.date,
          attribution:snap.attribution||"after-daily-arena-rewards",
          players});
    }
    // Serve today's VERIFIED receipts immediately even before the periodic
    // private archive. This read-only fallback never triggers Scopely calls.
    const today=currentDay(now);
    const latest=[],seen=new Set();
    for(const a of approved){
      const sourceData=await source(a.fingerprint,today);
      if(!sourceData)continue;
      for(const row of sourceData.rows){
        const id=a.allianceKey+":"+row.name;
        if(seen.has(id))continue;
        seen.add(id);
        latest.push(playerPublic(row,a.allianceKey));
      }
    }
    if(latest.length){
      const prior=byDay.get(today),merged=new Map();
      for(const p of prior?.players||[])merged.set(p.alliance+":"+p.name,p);
      for(const p of latest)merged.set(p.alliance+":"+p.name,p);
      byDay.set(today,{date:today,sourceDay:today,
        attribution:"after-daily-arena-rewards",
        players:[...merged.values()]});
    }
    const snapshots=[...byDay.values()]
      .sort((a,b)=>a.date.localeCompare(b.date));
    return respond(request,{status:"ok",version:1,
      kind:"authorized-guest-arena-history",retentionDays:DAYS,snapshots});
  }catch{return respond(request,{status:"unavailable"},503);}
}
