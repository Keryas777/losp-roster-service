// Emergency private snapshot of official AllianceCard rankings before season rollover.
// Stored under the EXISTING roster-batches/v1/ lifecycle (7 days): no new
// R2 retention rule needed and no indefinite historical API-data archive.
import {scanPrivateAllianceRanks} from "./alliance-coverage.js";

const PREFIX="roster-batches/v1/season-ranks/";
const LATEST=PREFIX+"latest.json";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const COOLDOWN=10*60_000;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const validSnapshot=s=>s&&s.version===1&&
  typeof s.capturedAt==="string"&&
  Array.isArray(s.alliances)&&s.alliances.length<=12&&
  s.alliances.every(a=>typeof a.name==="string");
async function latest(bucket){
  const object=await bucket.get(LATEST);
  if(!object)return null;
  const record=JSON.parse(await object.text());
  return validSnapshot(record)?record:null;
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
      const record=await latest(bucket);
      return respond(record?{status:"captured",snapshot:record}:
        {status:"not-captured",snapshot:null});
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
    if(previous&&Number.isFinite(Date.parse(previous.capturedAt))&&
      now-Date.parse(previous.capturedAt)>=0&&
      now-Date.parse(previous.capturedAt)<COOLDOWN)
      return respond({status:"recent-capture",snapshot:previous});
    const snapshot=await scanPrivateAllianceRanks(env,fetchImpl,now);
    if(!snapshot)return respond({error:"oauth-unavailable"},503);
    if(!snapshot.connectedAlliances)
      return respond({error:"no-connected-alliances",scannedSessions:snapshot.scannedSessions,
        unavailableSessions:snapshot.unavailableSessions},409);
    // Immutable source snapshot for this capture, plus an admin latest pointer.
    // Both objects expire after 7 days via the existing R2 lifecycle rule.
    const key=PREFIX+"captures/"+snapshot.capturedAt.replace(/[:.]/g,"-")+
      "-"+crypto.randomUUID()+".json";
    const options={httpMetadata:{contentType:"application/json",
      cacheControl:"private, no-store"}};
    const bytes=JSON.stringify(snapshot);
    await bucket.put(key,bytes,options);
    await bucket.put(LATEST,bytes,options);
    return respond({status:snapshot.completeSessionScan?"captured":"partial-capture",
      snapshot,retention:"existing-roster-batches-7-days"});
  }catch{return respond({error:"capture-unavailable"},503);}
}
