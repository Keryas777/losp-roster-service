// Emergency private snapshot of official AllianceCard rankings before season rollover.
// Stored under the EXISTING roster-batches/v1/ lifecycle (7 days): no new
// R2 retention rule needed and no indefinite historical API-data archive.
import {scanPrivateAllianceRanks} from "./alliance-coverage.js";
import {readApproval} from "./roster-sync-preflight.js";
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {archiveGuestSeasonRankSample} from "./public-guest-season-ranks.js";
import {preserveStandingsHistory} from "./durable-alliance-standings.js";

const PREFIX="roster-batches/v1/season-ranks/";
const LATEST=PREFIX+"latest.json";
const GUEST_PREFIX="roster-batches/v1/guest-season-ranks/";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const COOLDOWN=10*60_000;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const validSnapshot=s=>s&&s.version===1&&
  typeof s.capturedAt==="string"&&
  Array.isArray(s.alliances)&&s.alliances.length<=500&&
  s.alliances.every(a=>typeof a.name==="string");
async function latest(bucket){
  const object=await bucket.get(LATEST);
  if(!object)return null;
  const record=JSON.parse(await object.text());
  return validSnapshot(record)?record:null;
}
// Private guest latest is independent of the LoSP latest pointer.
// Filter against CURRENT approvals on every GET (revoked guests stay hidden).
async function latestApprovedGuests(bucket,env){
  const current=await readCollectibleApprovals(env);
  if(current.status==="invalid-registry")throw Error("invalid-approvals");
  const allowed=new Set((current.guestAlliances||[]).map(x=>x.fingerprint));
  if(!allowed.size)return null;
  const item=await bucket.get(GUEST_PREFIX+"latest.json");
  if(!item)return null;
  const raw=await item.text();
  if(raw.length>200000)return null;
  let value;
  try{value=JSON.parse(raw);}catch{return null;}
  if(!validSnapshot(value))return null;
  const alliances=value.alliances.filter(a=>allowed.has(a.allianceFingerprint));
  return alliances.length?{...value,alliances,connectedAlliances:alliances.length}:null;
}
export async function handleAllianceSeasonRanks(request,env,fetchImpl=fetch,now=Date.now()){
  if(!["GET","POST"].includes(request.method))
    return respond({error:"method-not-allowed"},405);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!bucket?.list)
    return respond({error:"storage-unavailable"},503);
  if(new URL(request.url).search)return respond({error:"unsupported-query"},400);
  if(request.method==="GET"){
    try{
      const [record,guestSnapshot]=await Promise.all([
        latest(bucket),latestApprovedGuests(bucket,env)
      ]);
      return respond({status:record||guestSnapshot?"captured":"not-captured",
        snapshot:record,guestSnapshot});
    }catch{return respond({error:"snapshot-unavailable"},503);}
  }
  if(new URL(request.url).origin!==ORIGIN||
    request.headers.get("Origin")!==ORIGIN||
    !(request.headers.get("Content-Type")||"").toLowerCase()
      .startsWith("application/json"))return respond({error:"forbidden"},403);
  try{
    const raw=await request.text();
    if(raw.length>64||JSON.parse(raw)?.action!=="capture")
      return respond({error:"invalid-action"},400);
    const previous=await latest(bucket);
    const previousGuests=await latestApprovedGuests(bucket,env);
    const latestAt=Math.max(...[previous?.capturedAt,previousGuests?.capturedAt]
      .map(value=>Date.parse(value)).filter(Number.isFinite),-Infinity);
    if(Number.isFinite(latestAt)&&now-latestAt>=0&&now-latestAt<COOLDOWN)
      return respond({status:"recent-capture",snapshot:previous,
        guestSnapshot:previousGuests});
    const approval=await readApproval(env);
    if(approval.status!=="configured"||!approval.alliances.length)
      return respond({error:"no-approved-alliances"},409);
    const registry=await readCollectibleApprovals(env);
    const lospFingerprints=new Set(approval.alliances.map(a=>a.fingerprint));
    const guestFingerprints=new Set(registry.guestAlliances.map(a=>a.fingerprint));
    const authorized=new Set([...lospFingerprints,...guestFingerprints]);
    const shared=await scanPrivateAllianceRanks(env,fetchImpl,now,authorized);
    if(!shared)return respond({error:"oauth-unavailable"},503);
    const select=keys=>{
      const alliances=shared.alliances.filter(a=>keys.has(a.allianceFingerprint));
      return {...shared,alliances,connectedAlliances:alliances.length};
    };
    const snapshot=select(lospFingerprints);
    const guest=select(guestFingerprints);
    if(!snapshot.connectedAlliances&&!guest.connectedAlliances)
      return respond({error:"no-connected-alliances",scannedSessions:snapshot.scannedSessions,
        unavailableSessions:snapshot.unavailableSessions},409);
    // Persist derived observations before writing short-lived source snapshots.
    // Failure is explicit: never report a capture as safely archived otherwise.
    if(snapshot.connectedAlliances){
      const preserved=await preserveStandingsHistory(env,"losp-season",[snapshot]);
      if(preserved.status!=="preserved")
        return respond({error:"history-preservation-failed",detail:preserved.status},503);
    }
    if(guest.connectedAlliances){
      const preserved=await preserveStandingsHistory(env,"guest-season",[guest]);
      if(preserved.status!=="preserved")
        return respond({error:"guest-history-preservation-failed",detail:preserved.status},503);
    }
    // Immutable source snapshot for this capture, plus an admin latest pointer.
    // Both objects expire after 7 days via the existing R2 lifecycle rule.
    const key=PREFIX+"captures/"+snapshot.capturedAt.replace(/[:.]/g,"-")+
      "-"+crypto.randomUUID()+".json";
    const options={httpMetadata:{contentType:"application/json",
      cacheControl:"private, no-store"}};
    if(snapshot.connectedAlliances){
      const bytes=JSON.stringify(snapshot);
      await bucket.put(key,bytes,options);
      await bucket.put(LATEST,bytes,options);
    }
    // Guest rankings remain private and separate from LoSP's GitHub imports.
    let guestStatus="not-configured",guestHistoryStatus="not-sampled";
    if(guestFingerprints.size){
      try{
        if(guest.connectedAlliances){
          const payload=JSON.stringify(guest);
          const guestKey=GUEST_PREFIX+"captures/"+
            shared.capturedAt.replace(/[:.]/g,"-")+"-"+crypto.randomUUID()+".json";
          await bucket.put(guestKey,payload,options);
          await bucket.put(GUEST_PREFIX+"latest.json",payload,options);
          guestStatus=guest.completeSessionScan?"captured":"partial-capture";
          // Persist each real, approved rank-only capture. The WebApp maps
          // it to the previous displayed season using its JSON calendar.
          // This adds no Scopely request or scheduled collection.
          const projection=await archiveGuestSeasonRankSample(env,guest,now);
          guestHistoryStatus=projection.status;
        }else guestStatus="no-connected-guests";
      }catch{guestStatus="unavailable";}
    }
    return respond({status:shared.completeSessionScan?"captured":"partial-capture",
      snapshot:snapshot.connectedAlliances?snapshot:null,guestStatus,guestHistoryStatus,
      guestSnapshot:await latestApprovedGuests(bucket,env),
      retention:"existing-roster-batches-7-days"});
  }catch{return respond({error:"capture-unavailable"},503);}
}
