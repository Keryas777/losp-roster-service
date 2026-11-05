// Read-only rank projection of already captured APPROVED guest AllianceCards.
// Never calls Scopely, exposes tokens, fingerprints, member data or R2 keys.
// Original data and this rolling projection use the existing 7-day R2 lifecycle.
// Trim samples to 22 days: 22 days + 7-day object lifecycle < 30-day API TTL.
import {readGuestApprovals} from "./guest-alliance-approvals.js";
import {readApproval} from "./roster-sync-preflight.js";

const ROOT="roster-batches/v1/";
const GUEST_LATEST=ROOT+"guest-season-ranks/latest.json";
const SEASON_ID=/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/;
const KEY=ROOT+"guest-season-ranks/rolling.json";
const TROPHIES=ROOT+"trophy-history/rolling.json";
const DAY_MS=86400000,RETENTION_DAYS=22;
const FP=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEADERS={"Content-Type":"application/json; charset=utf-8",
  "Access-Control-Allow-Origin":"*","Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff"};
const rank=n=>Number.isSafeInteger(n)&&n>=0;
const date=s=>typeof s==="string"&&Number.isFinite(Date.parse(s));
const name=s=>typeof s==="string"&&!!s.trim()&&s.length<=140;
const monday=ms=>new Date(ms).getUTCDay()===1;
const minDay=ms=>new Date(ms-RETENTION_DAYS*DAY_MS).toISOString().slice(0,10);
const dayOf=ms=>new Date(ms).toISOString().slice(0,10);
async function read(bucket,key,max=250000){
  const item=await bucket.get(key);
  if(!item)return null;
  if(Number.isSafeInteger(item.size)&&item.size>max)throw Error("oversized-object");
  const raw=await item.text();
  if(raw.length>max)throw Error("oversized-object");
  return JSON.parse(raw);
}
function validSeasonId(value){
  if(typeof value!=="string"||!SEASON_ID.test(value))return false;
  const [start,end]=value.split("/");
  const a=Date.parse(start+"T00:00:00.000Z");
  const b=Date.parse(end+"T00:00:00.000Z");
  return Number.isFinite(a)&&Number.isFinite(b)&&
    new Date(a).toISOString().slice(0,10)===start&&
    new Date(b).toISOString().slice(0,10)===end&&
    (b-a)/DAY_MS>=7&&(b-a)/DAY_MS<=60;
}
function validArchive(value){
  return value?.version===1&&value.kind==="guest-season-ranks-rolling"&&
    Array.isArray(value.snapshots)&&value.snapshots.length<=35&&
    value.snapshots.every(s=>/^\d{4}-\d{2}-\d{2}$/.test(s?.collectionDayUtc||"")&&
      date(s.capturedAt)&&Array.isArray(s.alliances)&&s.alliances.length<=30&&
      s.alliances.every(a=>FP.test(a?.fingerprint||"")&&name(a.nameAtCapture)&&
        rank(a.warRank)&&rank(a.raidRank)&&
        (a.manualSeasonId===undefined||
          (validSeasonId(a.manualSeasonId)&&a.seasonConfirmation==="admin-in-game"))));
}
// Only the already-scheduled Monday 03:15 UTC private capture is retained.
// The WebApp decides whether it follows a *completed* 14-day season from its
// existing JSON calendar. Other Mondays must not invent a season point.
export async function archiveGuestSeasonRankSample(env,capture,now=Date.now()){
  const at=new Date(now);
  if(!monday(now)||at.getUTCHours()!==3||at.getUTCMinutes()!==15)
    return {status:"outside-window"};
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
    return {status:"storage-unavailable"};
  if(capture?.version!==1||capture.source!=="/player/v1/alliance/card"||
     !date(capture.capturedAt)||Math.abs(Date.parse(capture.capturedAt)-now)>600000||
     !Array.isArray(capture.alliances)||capture.alliances.length>30)
    return {status:"invalid-capture"};
  const guests=await readGuestApprovals(env);
  if(guests.status!=="configured")return {status:"no-approved-guests"};
  const approved=new Set(guests.alliances.map(a=>a.fingerprint));
  const alliances=[],seen=new Set();
  for(const a of capture.alliances){
    if(!approved.has(a?.allianceFingerprint)||seen.has(a.allianceFingerprint)||
       !FP.test(a.allianceFingerprint)||!name(a.name)||
       !rank(a.warRank)||!rank(a.raidRank))continue;
    seen.add(a.allianceFingerprint);
    alliances.push({fingerprint:a.allianceFingerprint,nameAtCapture:a.name,
      warRank:a.warRank,raidRank:a.raidRank});
  }
  if(!alliances.length)return {status:"no-valid-guest-ranks"};
  const bucket=env.CAPTAIN_BUCKET;
  let old=await read(bucket,KEY);
  if(old&&!validArchive(old))return {status:"invalid-history"};
  const day=dayOf(now);
  const snapshot={collectionDayUtc:day,capturedAt:capture.capturedAt,
    completeSessionScan:capture.completeSessionScan===true,alliances};
  const previous=old?.snapshots?.find(s=>s.collectionDayUtc===day);
  if(JSON.stringify(previous)===JSON.stringify(snapshot))
    return {status:"unchanged",observed:alliances.length};
  const snapshots=(old?.snapshots||[]).filter(s=>
    s.collectionDayUtc>=minDay(now)&&s.collectionDayUtc!==day)
    .concat(snapshot).sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc));
  if(snapshots.length>35)return {status:"too-many-snapshots"};
  const raw=JSON.stringify({version:1,kind:"guest-season-ranks-rolling",
    updatedAt:at.toISOString(),snapshots});
  if(raw.length>250000)return {status:"history-too-large"};
  await bucket.put(KEY,raw,{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"}});
  return {status:"updated",observed:alliances.length};
}
export async function publicGuestSeasonRanks(request,env,now=Date.now()){
  if(request.method!=="GET")return Response.json({status:"method-not-allowed"},
    {status:405,headers:HEADERS});
  if(new URL(request.url).search)return Response.json({status:"invalid-query"},
    {status:400,headers:HEADERS});
  try{
    const bucket=env.CAPTAIN_BUCKET;
    const [history,guests,losp,trophies]=await Promise.all([
      read(bucket,KEY),readGuestApprovals(env),readApproval(env),
      read(bucket,TROPHIES,600000)]);
    if(history&&!validArchive(history))throw Error("invalid-history");
    if(guests.status==="invalid-registry"||losp.status==="invalid-registry")
      throw Error("invalid-approvals");
    const lospIds=new Set((losp.alliances||[]).map(a=>a.fingerprint));
    const permitted=new Map((guests.alliances||[])
      .filter(a=>!lospIds.has(a.fingerprint)).map(a=>[a.fingerprint,a]));
    const ids=trophies?.version===1&&
      trophies.kind==="connected-alliance-trophy-history"&&
      trophies.ids&&typeof trophies.ids==="object"?trophies.ids:{};
    const snapshots=(history?.snapshots||[]).filter(s=>
      s.collectionDayUtc>=minDay(now)&&s.collectionDayUtc<=dayOf(now))
      .map(s=>({collectionDayUtc:s.collectionDayUtc,capturedAt:s.capturedAt,
        coverage:{complete:s.completeSessionScan===true},
        alliances:s.alliances.flatMap(a=>{
          const approval=permitted.get(a.fingerprint);
          if(!approval)return [];
          const publicId=ids[a.fingerprint];
          const allianceKey=approval.allianceKey;
          // Never publish a guest without a verified, approved public mapping.
          if(!UUID.test(publicId||"")&&!allianceKey)return [];
          return [{nameAtCapture:a.nameAtCapture,warRank:a.warRank,
            raidRank:a.raidRank,capturedAt:a.capturedAt||s.capturedAt,
            ...(a.manualSeasonId&&a.seasonConfirmation==="admin-in-game"?
              {manualSeasonId:a.manualSeasonId,
                seasonConfirmation:"admin-in-game"}:{}),
            ...(UUID.test(publicId||"")?{publicId}:{}),
            ...(allianceKey?{allianceKey}:{})}];
        })
      })).filter(s=>s.alliances.length);
    return Response.json({status:"ok",version:1,kind:"connected-guest-season-ranks",
      retentionDays:RETENTION_DAYS,updatedAt:history?.updatedAt||null,
      snapshots},{headers:HEADERS});
  }catch{return Response.json({status:"unavailable",snapshots:[]},
    {status:503,headers:HEADERS});}
}


// Authenticated administrator-only qualification of a FRESH real guest rank
// capture when the in-game UI explicitly still shows a completed season.
// This never calls Scopely and never trusts a posted rank, name or public ID.
// Admin authentication is enforced at the /admin router, before any R2 read.
export async function publishVerifiedGuestSeasonRanks(request,env,now=Date.now()){
  if(request.method!=="POST")return Response.json({error:"method-not-allowed"},
    {status:405,headers:HEADERS});
  const url=new URL(request.url);
  if(url.search||request.headers.get("Origin")!==url.origin||
    !(request.headers.get("Content-Type")||"").toLowerCase()
      .startsWith("application/json"))
    return Response.json({error:"forbidden"},{status:403,headers:HEADERS});
  let fingerprint,sourceCapturedAt,seasonId;
  try{
    const raw=await request.text();
    if(raw.length>400)throw Error("invalid-request");
    const body=JSON.parse(raw);
    const names=Object.keys(body||{}).sort();
    if(!body||Array.isArray(body)||
      names.join(",")!=="allianceFingerprint,confirmation,seasonId,sourceCapturedAt"||
      body.confirmation!=="verified-in-game"||
      !FP.test(body.allianceFingerprint)||!date(body.sourceCapturedAt)||
      !validSeasonId(body.seasonId))throw Error("invalid-request");
    ({allianceFingerprint:fingerprint,sourceCapturedAt,seasonId}=body);
  }catch{return Response.json({error:"invalid-confirmation"},
    {status:400,headers:HEADERS});}
  const [startDay,endDay]=seasonId.split("/");
  const start=Date.parse(startDay+"T00:00:00.000Z");
  const end=Date.parse(endDay+"T00:00:00.000Z");
  const captured=Date.parse(sourceCapturedAt);
  // The snapshot must have been observed AFTER the completed season and
  // BEFORE the next period ends, and be fresh enough for on-screen review.
  if(captured<end+DAY_MS||captured>=end+(end-start)||
    captured>now+60000||now-captured>24*3600000||
    now-end>RETENTION_DAYS*DAY_MS)
    return Response.json({error:"season-or-capture-outside-window"},
      {status:409,headers:HEADERS});
  try{
    const bucket=env?.CAPTAIN_BUCKET;
    if(!bucket?.get||!bucket?.put)
      return Response.json({error:"storage-unavailable"},
        {status:503,headers:HEADERS});
    const [guests,losp,latest,trophies]=await Promise.all([
      readGuestApprovals(env),readApproval(env),read(bucket,GUEST_LATEST),
      read(bucket,TROPHIES,600000)]);
    if(guests.status!=="configured"||losp.status==="invalid-registry")
      return Response.json({error:"guest-approval-unavailable"},
        {status:409,headers:HEADERS});
    const enrolled=guests.alliances.find(a=>a.fingerprint===fingerprint);
    if(!enrolled||(losp.alliances||[]).some(a=>a.fingerprint===fingerprint))
      return Response.json({error:"guest-not-approved"},
        {status:403,headers:HEADERS});
    const publicId=trophies?.kind==="connected-alliance-trophy-history"?
      trophies.ids?.[fingerprint]:null;
    if(!UUID.test(publicId||"")&&!enrolled.allianceKey)
      return Response.json({error:"guest-identity-unmapped"},
        {status:409,headers:HEADERS});
    if(latest?.version!==1||latest.source!=="/player/v1/alliance/card"||
      latest.capturedAt!==sourceCapturedAt||
      !Array.isArray(latest.alliances)||latest.alliances.length>30)
      return Response.json({error:"recent-guest-capture-missing"},
        {status:409,headers:HEADERS});
    const matches=latest.alliances.filter(a=>
      a?.allianceFingerprint===fingerprint&&name(a.name)&&
      rank(a.warRank)&&rank(a.raidRank));
    if(matches.length!==1)
      return Response.json({error:"guest-ranks-missing"},
        {status:409,headers:HEADERS});
    const item=matches[0];
    const saved={fingerprint,nameAtCapture:item.name,warRank:item.warRank,
      raidRank:item.raidRank,capturedAt:sourceCapturedAt,
      manualSeasonId:seasonId,seasonConfirmation:"admin-in-game"};
    const old=await read(bucket,KEY);
    if(old&&!validArchive(old))throw Error("invalid-archive");
    const day=dayOf(captured);
    const prior=old?.snapshots?.find(s=>s.collectionDayUtc===day);
    const already=prior?.alliances?.find(a=>a.fingerprint===fingerprint);
    if(already){
      if(already.manualSeasonId!==seasonId||
        already.capturedAt!==saved.capturedAt||
        already.warRank!==saved.warRank||
        already.raidRank!==saved.raidRank)
        return Response.json({error:"season-already-recorded-differently"},
          {status:409,headers:HEADERS});
      return Response.json({status:"unchanged",seasonId,
        capturedAt:sourceCapturedAt,warRank:saved.warRank,
        raidRank:saved.raidRank},{headers:HEADERS});
    }
    const snapshot={collectionDayUtc:day,
      capturedAt:prior?.capturedAt&&prior.capturedAt>sourceCapturedAt?
        prior.capturedAt:sourceCapturedAt,
      completeSessionScan:latest.completeSessionScan===true,
      alliances:[...(prior?.alliances||[]),saved]};
    if(snapshot.alliances.length>30)
      return Response.json({error:"too-many-alliances"},
        {status:409,headers:HEADERS});
    const snapshots=(old?.snapshots||[])
      .filter(s=>s.collectionDayUtc>=minDay(now)&&s.collectionDayUtc!==day)
      .concat(snapshot).sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc));
    const payload=JSON.stringify({version:1,kind:"guest-season-ranks-rolling",
      updatedAt:new Date(now).toISOString(),snapshots});
    if(payload.length>250000||snapshots.length>35)
      return Response.json({error:"projection-too-large"},
        {status:409,headers:HEADERS});
    await bucket.put(KEY,payload,{httpMetadata:{
      contentType:"application/json",cacheControl:"private, no-store"}});
    // Return only the actual measured ranks. No fingerprint or private key.
    return Response.json({status:"recorded",seasonId,
      capturedAt:sourceCapturedAt,warRank:saved.warRank,
      raidRank:saved.raidRank},{headers:HEADERS});
  }catch{
    return Response.json({error:"backfill-unavailable"},
      {status:503,headers:HEADERS});
  }
}
