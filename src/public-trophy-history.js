import {preserveStandingsHistory} from "./durable-alliance-standings.js";
// Public, trophy-only projection of already archived, consented AllianceCards.
// No Scopely requests, OAuth tokens, member data, fingerprints or R2 paths leave R2.
// Records live under the EXISTING seven-day R2 lifecycle. Retain at most 22
// days of readings in each rewrite (22 + 7 < the provider's 30-day limit).
import {readCollectibleApprovals,readGuestApprovals} from "./guest-alliance-approvals.js";
import {trophyCardKey,BATCH_PREFIX} from "./private-roster-batches.js";

// Defined independently to avoid an ES-module initialization cycle when the
// guest onboarding module imports this projection during approval routing.
// Keep in sync with private-roster-batches.js: BATCH_PREFIX is "roster-batches/v1/".
const KEY="roster-batches/v1/trophy-history/rolling.json";
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
function publicHistory(archive,now,allowedIds,guestKeys){
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
        capturedAt:a.capturedAt,warTrophies:a.warTrophies,
        // Resolve the CURRENT approved R2 binding on each GET, not when
        // collecting. Public UUIDs may rotate; neither names nor colour
        // markup establish an alliance's identity.
        ...(guestKeys.has(a.publicId)?
          {allianceKey:guestKeys.get(a.publicId)}:{})
      })).filter(a=>allowedIds.has(a.publicId)&&UUID.test(a.publicId)&&safeName(a.nameAtCapture)&&
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
    // Revocations take effect at the next GET, not only on the next Cron:
    // refuse access to any published identity no longer approved.
    const approved=await readCollectibleApprovals(env);
    if(approved.status==="invalid-registry")throw Error("invalid-approvals");
    // Intersect with the current guest registry again, so a revoked guest
    // cannot be exposed if the approvals change between the two R2 reads.
    // LoSP access remains independent of the guest registry.
    const guests=approved.guestAlliances?.length?
      await readGuestApprovals(env):null;
    const guestAllowed=new Set(guests?.status==="configured"?
      guests.alliances.map(a=>a.fingerprint):[]);
    const permitted=(approved.lospAlliances||[]).concat(
      (approved.guestAlliances||[]).filter(a=>guestAllowed.has(a.fingerprint)));
    const allowedIds=new Set(permitted.map(a=>archive?.ids?.[a.fingerprint])
      .filter(id=>UUID.test(id||"")));
    const guestFingerprints=new Set((approved.guestAlliances||[])
      .map(a=>a.fingerprint));
    const guestKeys=new Map(),conflictedIds=new Set();
    for(const guest of guests?.status==="configured"?guests.alliances:[]){
      if(!guestFingerprints.has(guest.fingerprint)||!guest.allianceKey)continue;
      const id=archive?.ids?.[guest.fingerprint];
      if(!UUID.test(id||"")||!allowedIds.has(id)||conflictedIds.has(id))continue;
      // If a damaged archive reuses a public UUID, do not attribute either
      // guest's readings to a wrong tenant.
      if(guestKeys.has(id)&&guestKeys.get(id)!==guest.allianceKey){
        guestKeys.delete(id);
        conflictedIds.add(id);
      }else guestKeys.set(id,guest.allianceKey);
    }
    return Response.json(publicHistory(archive,now,allowedIds,guestKeys),
      {headers:HEADERS});
  }catch{return Response.json({status:"unavailable",snapshots:[]},
    {status:503,headers:HEADERS});}
}

// One-time guest catch-up: put the CURRENT, truly observed trophy total at
// the most recent REAL grouped Thursday/Saturday collection date. This is a
// chart alignment, NOT a claim the guest was observed on that earlier day.
// Keep the actual capture timestamp on the per-alliance point. Never rewrite
// another alliance or an older observation for this guest.
export async function archiveInitialGuestTrophies(env,observation,now=Date.now()){
  const {fingerprint,allianceKey,nameAtCapture,warTrophies,capturedAt}=
    observation||{};
  const captured=asDate(capturedAt);
  if(!FP.test(fingerprint||"")||
     !/^[a-z][a-z0-9-]{1,63}$/.test(allianceKey||"")||
     !safeName(nameAtCapture)||!validNumber(warTrophies)||
     !Number.isFinite(now)||!Number.isFinite(captured)||captured>now||
     now-captured>48*60*60*1000)
    return {status:"invalid-observation"};
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put)return {status:"storage-unavailable"};
  try{
    const [approved,guests]=await Promise.all([
      readCollectibleApprovals(env),readGuestApprovals(env)
    ]);
    if(approved.status!=="configured"||guests.status!=="configured"||
       !(approved.guestAlliances||[]).some(a=>a.fingerprint===fingerprint)||
       !guests.alliances.some(a=>a.fingerprint===fingerprint&&
         a.allianceKey===allianceKey))
      return {status:"not-approved-and-bound"};
    const archive=await read(bucket,KEY);
    if(archive&&!validHistory(archive))return {status:"invalid-history"};
    // Only a genuinely archived GROUPED collection establishes the target day.
    // Do not synthesize a Thursday/Saturday if the group's run was missed.
    const original=(archive?.snapshots||[]).filter(s=>
      isTrophyDay(s.collectionDayUtc)&&
      s.collectionDayUtc>=minDay(now)&&
      Number.isFinite(asDate(s.capturedAt))&&
      asDate(s.capturedAt)<=captured)
      .sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc))
      .at(-1);
    if(!original)return {status:"awaiting-grouped-capture"};
    const groupDay=Date.parse(original.collectionDayUtc+"T00:00:00Z");
    if(!Number.isFinite(groupDay)||captured-groupDay>7*DAY_MS)
      return {status:"grouped-capture-too-old"};
    const existingId=archive.ids[fingerprint];
    if(existingId&&!UUID.test(existingId))
      return {status:"invalid-public-id"};
    if(existingId&&Object.entries(archive.ids).some(([fp,id])=>
      fp!==fingerprint&&id===existingId))
      return {status:"colliding-public-id"};
    const ids={...archive.ids};
    let id=existingId;
    if(!id){
      const allocated=new Set(Object.values(ids));
      do{id=crypto.randomUUID();}while(allocated.has(id));
      ids[fingerprint]=id;
    }
    if(!Array.isArray(original.alliances)||original.alliances.length>=30)
      return {status:"grouped-capture-full"};
    if(original.alliances.some(a=>a.publicId===id))
      return {status:"already-recorded",collectionDayUtc:original.collectionDayUtc};
    const row={publicId:id,nameAtCapture:safeName(nameAtCapture),
      warTrophies,capturedAt,
      attribution:"initial-sync-later-observation"};
    const updated={...original,
      // Keep the grouped timestamp for the chart's X axis; the new row's
      // capturedAt carries its ACTUAL later Scopely observation timestamp.
      alliances:[...original.alliances,row]
        .sort((a,b)=>a.publicId.localeCompare(b.publicId)),
      expected:Math.max(Number.isSafeInteger(original.expected)?
        original.expected:0,approved.alliances.length),
      complete:false};
    const snapshots=archive.snapshots
      .filter(s=>s.collectionDayUtc!==original.collectionDayUtc&&
        isTrophyDay(s.collectionDayUtc)&&s.collectionDayUtc>=minDay(now))
      .concat(updated)
      .sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc));
    const raw=JSON.stringify({version:1,
      kind:"connected-alliance-trophy-history",updatedAt:new Date(now).toISOString(),
      ids,snapshots});
    if(raw.length>500000)return {status:"history-too-large"};
    // Existing grouped snapshots were written by their own Cron. A new
    // scheduled capture for this day must never be fabricated here.
    const preserved=await preserveStandingsHistory(env,"trophies",snapshots);
    if(preserved.status!=="preserved")
      return {status:"history-preservation-failed",detail:preserved.status};
    await bucket.put(KEY,raw,{httpMetadata:{
      contentType:"application/json",cacheControl:"private, no-store"}});
    return {status:"updated",collectionDayUtc:original.collectionDayUtc,
      actualCapturedAt:capturedAt};
  }catch{return {status:"unavailable"};}
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
  const preserved=await preserveStandingsHistory(env,"trophies",snapshots);
    if(preserved.status!=="preserved")
      return {status:"history-preservation-failed",detail:preserved.status};
    await bucket.put(KEY,raw,{httpMetadata:{
    contentType:"application/json",cacheControl:"private, no-store"}});
  return {status:"updated",observed:alliances.length,
    expected:fps.length,complete:unavailable===0};
}


// Repair a missing guest's Saturday trophy point from a REAL, immutable
// AllianceCard capture already held in private R2. No provider calls, posted
// values, guessed identities, or fabricated Saturday-morning timestamps.
// Sunday-only recovery keeps ordinary Thursday/Saturday trophy cadence intact.
export async function recoverPreviousSaturdayGuestTrophies(env,now=Date.now()){
  const yesterday=new Date(now-DAY_MS).toISOString().slice(0,10);
  if(new Date(now).getUTCDay()!==0||!isTrophyDay(yesterday))
    return {status:"outside-recovery-window"};
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list)
    return {status:"storage-unavailable"};
  try{
    const [approved,guests]=await Promise.all([
      readCollectibleApprovals(env),readGuestApprovals(env)]);
    if(approved.status!=="configured"||guests.status==="invalid-registry")
      return {status:"invalid-approvals"};
    const permitted=new Set((approved.guestAlliances||[]).map(a=>a.fingerprint));
    const bound=new Set((guests.alliances||[]).filter(a=>
      permitted.has(a.fingerprint)&&typeof a.allianceKey==="string"&&
      /^[a-z][a-z0-9-]{1,63}$/.test(a.allianceKey))
      .map(a=>a.fingerprint));
    if(!bound.size)return {status:"no-bound-guests"};
    // Captures are persisted by the existing authenticated admin endpoint.
    // Query one calendar day, not the entire R2 namespace.
    const prefix=BATCH_PREFIX+"guest-season-ranks/captures/"+yesterday+"T";
    const listing=await bucket.list({prefix,limit:100});
    if(!listing||listing.truncated||!Array.isArray(listing.objects)||
      listing.objects.length>48)
      return {status:"too-many-captures"};
    const newest=new Map();
    for(const item of listing.objects){
      if(typeof item?.key!=="string"||!item.key.startsWith(prefix))continue;
      const source=await read(bucket,item.key,200000);
      const stamp=Date.parse(source?.capturedAt);
      if(source?.version!==1||
         source.source!=="/player/v1/alliance/card"||
         !Number.isFinite(stamp)||stamp>now||
         new Date(stamp).toISOString().slice(0,10)!==yesterday||
         !Array.isArray(source.alliances)||source.alliances.length>30)continue;
      const seen=new Set();
      for(const row of source.alliances){
        const fp=row?.allianceFingerprint;
        if(!bound.has(fp)||seen.has(fp)||!safeName(row.name)||
           !validNumber(row.warTrophies)||!validNumber(row.warRank)||
           !validNumber(row.raidRank))continue;
        seen.add(fp);
        const prior=newest.get(fp);
        if(!prior||stamp>prior.stamp)
          newest.set(fp,{fingerprint:fp,stamp,
            nameAtCapture:row.name,warTrophies:row.warTrophies,
            capturedAt:source.capturedAt});
      }
    }
    if(!newest.size)return {status:"no-verified-saturday-captures"};
    const previous=await read(bucket,KEY);
    if(previous&&!validHistory(previous))
      return {status:"invalid-history"};
    const existing=previous||{version:1,
      kind:"connected-alliance-trophy-history",ids:{},snapshots:[]};
    const ids={...existing.ids};
    const original=existing.snapshots.find(s=>s.collectionDayUtc===yesterday);
    const alliances=[...(original?.alliances||[])];
    const used=new Set(alliances.map(a=>a.publicId));
    const allocated=new Set(Object.values(ids));
    let added=0;
    for(const [fp,item] of newest){
      if(ids[fp]&&used.has(ids[fp]))continue; // Never overwrite a real observation.
      if(!UUID.test(ids[fp]||"")){
        let generated;
        do{generated=crypto.randomUUID();}while(allocated.has(generated));
        ids[fp]=generated;
      }
      if(used.has(ids[fp]))continue; // Identity collision: fail closed.
      allocated.add(ids[fp]);
      used.add(ids[fp]);
      alliances.push({publicId:ids[fp],nameAtCapture:item.nameAtCapture,
        warTrophies:item.warTrophies,capturedAt:item.capturedAt});
      added++;
    }
    if(!added)return {status:"unchanged"};
    if(alliances.length>30)return {status:"too-many-alliances"};
    alliances.sort((a,b)=>a.publicId.localeCompare(b.publicId));
    const snapshot={collectionDayUtc:yesterday,
      capturedAt:alliances.map(a=>a.capturedAt).sort().at(-1),
      alliances,expected:original?.expected??approved.alliances.length,
      // Preserve any existing partial status: a late guest backfill does not
      // prove the original post-war morning cohort was complete.
      complete:original?.complete===true};
    const snapshots=existing.snapshots.filter(s=>
      isTrophyDay(s.collectionDayUtc)&&s.collectionDayUtc>=minDay(now)&&
      s.collectionDayUtc!==yesterday).concat(snapshot)
      .sort((a,b)=>a.collectionDayUtc.localeCompare(b.collectionDayUtc));
    if(snapshots.length>30)return {status:"too-many-snapshots"};
    const retained=new Set(snapshots.flatMap(s=>s.alliances.map(a=>a.publicId)));
    for(const fp of Object.keys(ids))if(!retained.has(ids[fp]))delete ids[fp];
    const payload=JSON.stringify({version:1,
      kind:"connected-alliance-trophy-history",
      updatedAt:new Date(now).toISOString(),ids,snapshots});
    if(payload.length>500000)return {status:"history-too-large"};
    const preserved=await preserveStandingsHistory(env,"trophies",snapshots);
    if(preserved.status!=="preserved")
      return {status:"history-preservation-failed",detail:preserved.status};
    await bucket.put(KEY,payload,{httpMetadata:{
      contentType:"application/json",cacheControl:"private, no-store"}});
    return {status:"updated",added,day:yesterday};
  }catch{return {status:"recovery-unavailable"};}
}
