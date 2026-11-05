// Public, trophy-only projection of already archived, consented AllianceCards.
// No Scopely requests, OAuth tokens, member data, fingerprints or R2 paths leave R2.
// Records live under the EXISTING seven-day R2 lifecycle. Retain at most 22
// days of readings in each rewrite (22 + 7 < the provider's 30-day limit).
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {trophyCardKey,BATCH_PREFIX} from "./private-roster-batches.js";

const KEY=BATCH_PREFIX+"trophy-history/rolling.json";
const FP=/^[a-f0-9]{64}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const UUID=/^[a-f0-9-]{36}$/;
const MAX_DAYS=22;
const DAY_MS=86400000;
const HEADERS={"Access-Control-Allow-Origin":"*","Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff","Content-Type":"application/json; charset=utf-8"};
const asDate=x=>typeof x==="string"?Date.parse(x):NaN;
const validNumber=x=>Number.isSafeInteger(x)&&x>=0;
const safeName=x=>typeof x==="string"&&x.trim().length>0&&x.length<=140?
  x.trim():null;
const isTrophyDay=day=>DAY.test(day||"")&&
  [4,6].includes(new Date(day+"T00:00:00Z").getUTCDay());
const minDay=now=>new Date(now-MAX_DAYS*DAY_MS).toISOString().slice(0,10);

async function read(bucket,key,max=600000){
  const o=await bucket.get(key);
  if(!o)return null;
  if(Number.isSafeInteger(o.size)&&o.size>max)throw Error("oversized-trophy-object");
  const raw=await o.text();
  if(raw.length>max)throw Error("oversized-trophy-object");
  return JSON.parse(raw);
}
async function sameIdentity(ident,fp){
  if(!/^[^:\s]{1,128}:[^:\s]{1,128}$/.test(ident))return false;
  const stable=ident.split(":")[0];
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stable));
  return [...new Uint8Array(bytes)]
    .map(x=>x.toString(16).padStart(2,"0")).join("")===fp;
}

// A readiness marker is not an authorization to publish arbitrary data:
// re-check the source's official envelope, real capture time and stable ID.
export async function readTrophyCard(bucket,fp,day,now){
  if(!FP.test(fp)||!isTrophyDay(day))return null;
  const marker=await read(bucket,trophyCardKey(fp,day+"-am"),2200);
  if(!marker)return null;
  const from=Date.parse(day+"T02:00:00Z");
  const to=Date.parse(day+"T04:00:00Z");
  const at=asDate(marker.capturedAt);
  const prefix=BATCH_PREFIX+fp+"/";
  if(marker.version!==1||marker.kind!=="trophy-card-ready"||
     marker.fingerprint!==fp||marker.campaign!==day+"-am"||
     !Number.isFinite(at)||at<from||at>=to||at>now||
     typeof marker.sourceKey!=="string"||
     !marker.sourceKey.startsWith(prefix)||
     !/^roster-batches\/v1\/[a-f0-9]{64}\/[a-f0-9-]{36}\/provider-source\/[a-f0-9-]{36}\/alliance-card\.json$/.test(marker.sourceKey))
    return null;
  const source=await read(bucket,marker.sourceKey,1000000);
  const card=source?.providerResponse?.data;
  if(source?.version!==1||source.kind!=="private-provider-source"||
     source.endpoint!=="/player/v1/alliance/card"||
     source.httpStatus!==200||source.allianceFingerprint!==fp||
     source.capturedAt!==marker.capturedAt||!safeName(card?.name)||
     !validNumber(card?.warTrophies)||!validNumber(card?.warRank)||
     !validNumber(card?.raidRank)||typeof card?.id!=="string"||
     !(await sameIdentity(card.id,fp)))return null;
  return {nameAtCapture:safeName(card.name),warTrophies:card.warTrophies,
    capturedAt:marker.capturedAt};
}
function validHistory(x){
  return x?.version===1&&x.kind==="connected-alliance-trophy-history"&&
    Array.isArray(x.snapshots)&&x.snapshots.length<=30&&
    x.ids&&typeof x.ids==="object"&&!Array.isArray(x.ids);
}
function publicHistory(archive,now){
  const snapshots=validHistory(archive)?archive.snapshots.filter(row=>
    isTrophyDay(row?.collectionDayUtc)&&row.collectionDayUtc>=minDay(now)&&
    Array.isArray(row.alliances)&&row.alliances.length<=30).map(row=>({
      version:1,kind:"losp-alliance-standings-snapshot",
      collectionDayUtc:row.collectionDayUtc,capturedAt:row.capturedAt,
      source:"/player/v1/alliance/card",
      coverage:{observed:row.alliances.length,
        expected:row.expected,complete:row.complete},
      alliances:row.alliances.map(a=>({
        publicId:a.publicId,nameAtCapture:a.nameAtCapture,
        capturedAt:a.capturedAt,warTrophies:a.warTrophies
      })).filter(a=>UUID.test(a.publicId)&&safeName(a.nameAtCapture)&&
        validNumber(a.warTrophies)&&Number.isFinite(asDate(a.capturedAt)))
    })).filter(row=>row.alliances.length):[];
  return {status:"ok",version:1,kind:"connected-alliance-trophy-history",
    retentionDays:MAX_DAYS,updatedAt:archive?.updatedAt||null,snapshots};
}
export async function publicTrophyHistory(request,env,now=Date.now()){
  if(request.method!=="GET")
    return Response.json({status:"method-not-allowed"},{status:405,headers:HEADERS});
  if(new URL(request.url).search)
    return Response.json({status:"invalid-query"},{status:400,headers:HEADERS});
  try{
    const archive=await read(env.CAPTAIN_BUCKET,KEY);
    if(archive&&!validHistory(archive))throw Error("invalid-trophy-history");
    return Response.json(publicHistory(archive,now),{headers:HEADERS});
  }catch{return Response.json({status:"unavailable",snapshots:[]},
    {status:503,headers:HEADERS});}
}

// Run from the existing roster Cron, after its private AllianceCard marker
// writes. Every successful pass merges newly connected/approved alliances.
// An unavailable alliance NEVER blocks real measurements from the others.
export async function archiveTrophyHistory(env,slot,now=Date.now()){
  const day=slot?.date;
  if(!isTrophyDay(day)||slot?.campaign!==day+"-am")
    return {status:"outside-trophy-window"};
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
    return {status:"storage-unavailable"};
  const approved=await readCollectibleApprovals(env);
  if(approved.status!=="configured"||!approved.alliances?.length)
    return {status:"no-approved-alliances"};
  const fps=approved.alliances.map(a=>a.fingerprint);
  if(fps.length>30||fps.some(fp=>!FP.test(fp))||
     new Set(fps).size!==fps.length)return {status:"invalid-approvals"};
  const bucket=env.CAPTAIN_BUCKET;
  let previous=await read(bucket,KEY);
  if(previous&&!validHistory(previous))return {status:"invalid-history"};
  previous=previous||{version:1,kind:"connected-alliance-trophy-history",
    ids:{},snapshots:[]};
  const ids={...previous.ids};
  const alliances=[];
  let unavailable=0;
  for(const fp of fps){
    let card=null;
    try{card=await readTrophyCard(bucket,fp,day,now);}
    catch{/* Bad/absent source is never silently replaced by a made-up value. */}
    if(!card){unavailable++;continue;}
    if(!UUID.test(ids[fp]||""))ids[fp]=crypto.randomUUID();
    alliances.push({publicId:ids[fp],...card});
  }
  if(!alliances.length)return {status:"awaiting-cards",expected:fps.length};
  alliances.sort((a,b)=>a.publicId.localeCompare(b.publicId));
  const capturedAt=alliances.map(a=>a.capturedAt).sort().at(-1);
  const snapshot={collectionDayUtc:day,capturedAt,alliances,
    expected:fps.length,complete:unavailable===0};
  const prior=previous.snapshots.find(s=>s.collectionDayUtc===day);
  if(JSON.stringify(prior)===JSON.stringify(snapshot))
    return {status:"unchanged",observed:alliances.length,
      expected:fps.length,complete:unavailable===0};
  const snapshots=previous.snapshots
    .filter(s=>isTrophyDay(s.collectionDayUtc)&&s.collectionDayUtc>=minDay(now)&&
      s.collectionDayUtc!==day).concat(snapshot)
    .sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc));
  const active=new Set(snapshots.flatMap(s=>s.alliances.map(a=>a.publicId)));
  for(const fp of Object.keys(ids))if(!active.has(ids[fp]))delete ids[fp];
  const output={version:1,kind:"connected-alliance-trophy-history",
    updatedAt:new Date(now).toISOString(),ids,snapshots};
  const raw=JSON.stringify(output);
  if(raw.length>500000)return {status:"history-too-large"};
  await bucket.put(KEY,raw,{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"}});
  return {status:"updated",observed:alliances.length,
    expected:fps.length,complete:unavailable===0};
}
