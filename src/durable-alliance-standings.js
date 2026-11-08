// Durable, derived standings observations. Raw AllianceCard responses remain in
// the provider-governed temporary staging area. Never expose this prefix publicly.
// One dated object per observation day; no sliding window or retention rewrite.
// This module does not change consent checks on existing public endpoints.
const ROOT="alliance-standings-history/v1/";
const TYPES=new Set(["losp-season","guest-season","trophies"]);
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const MAX=600000;
export async function preserveStandingsHistory(env,type,snapshots){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put||!TYPES.has(type)||
     !Array.isArray(snapshots))return {status:"unavailable"};
  try{
    let saved=0;
    for(const item of snapshots){
      const day=item?.collectionDayUtc||
        (typeof item?.capturedAt==="string"?item.capturedAt.slice(0,10):"");
      if(!DAY.test(day)||!Number.isFinite(Date.parse(day+"T00:00:00Z")))
        return {status:"invalid-day"};
      const key=ROOT+type+"/"+day+".json";
      const existing=await bucket.get(key);
      let prior=null;
      if(existing){
        if(existing.size>MAX)return {status:"oversized-archive"};
        prior=JSON.parse(await existing.text());
        if(prior?.version!==1||prior?.type!==type||prior?.day!==day||
           !Array.isArray(prior.observations))return {status:"archive-integrity-error"};
      }
      // Append only distinct real observations, including a later correction
      // of the same day. Never discard an earlier capture.
      const observation=JSON.stringify(item);
      const observations=prior?.observations||[];
      if(observations.some(x=>JSON.stringify(x)===observation))continue;
      const updated={version:1,type,day,observations:[...observations,item]};
      const raw=JSON.stringify(updated);
      if(raw.length>MAX)return {status:"archive-full"};
      await bucket.put(key,raw,{httpMetadata:{
        contentType:"application/json",cacheControl:"private, no-store"}});
      saved++;
    }
    return {status:"preserved",saved};
  }catch{return {status:"archive-unavailable"};}
}
