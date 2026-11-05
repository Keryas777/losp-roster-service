// Private, read-only Arena health by CURRENT approved alliance.
// No Scopely calls, OAuth token reads, fingerprints or player names in output.
// Existing short-lived reward receipts and separate LoSP/guest histories only.
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {cachedConnectedAllianceNames} from "./connected-alliance-index.js";

const ROOT="roster-batches/v1/";
const MAX_RECEIPT_BYTES=240000,MAX_HISTORY_BYTES=2000000;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const validTime=s=>typeof s==="string"&&Number.isFinite(Date.parse(s));
const positive=n=>Number.isSafeInteger(n)&&n>0;
const validDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||"")&&
  new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d;
function parisDay(now){
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(now)).filter(p=>
    ["year","month","day"].includes(p.type)).map(p=>[p.type,p.value]));
  return p.year+"-"+p.month+"-"+p.day;
}
async function getJSON(bucket,key,max){
  const object=await bucket.get(key);
  if(!object)return {status:"missing",data:null};
  if(Number.isSafeInteger(object.size)&&object.size>max)
    return {status:"invalid",data:null};
  try{
    const raw=await object.text();
    if(raw.length>max)return {status:"invalid",data:null};
    return {status:"ok",data:JSON.parse(raw)};
  }catch{return {status:"invalid",data:null};}
}
function inspectReceipt(response,fp,day,now){
  if(response.status!=="ok")return {status:response.status,players:0,
    ranks:0,withoutRank:0,observedRanks:0,capturedAt:null,latestObservedAt:null};
  const x=response.data;
  if(x?.version!==1||x.kind!=="alliance-infos-reward"||
     x.campaign!==day+"-reward"||x.allianceFingerprint!==fp||
     typeof x.allianceName!=="string"||!x.allianceName.trim()||
     !validTime(x.capturedAt)||!validTime(x.expiresAt)||
     !Array.isArray(x.rows)||!x.rows.length||x.rows.length>100||
     !x.rows.every(r=>r&&typeof r.name==="string"&&r.name.trim())){
    return {status:"invalid",players:0,ranks:0,withoutRank:0,
      observedRanks:0,capturedAt:null,latestObservedAt:null};
  }
  if(Date.parse(x.expiresAt)<=now)return {status:"expired",players:0,
    ranks:0,withoutRank:0,observedRanks:0,capturedAt:null,latestObservedAt:null};
  const captured=Date.parse(x.capturedAt);
  // Same local day and after the Arena reward cutoff. No historical replay.
  if(captured>now||parisDay(captured)!==day){
    return {status:"invalid",players:0,ranks:0,withoutRank:0,
      observedRanks:0,capturedAt:null,latestObservedAt:null};
  }
  const ranks=x.rows.filter(r=>positive(r.latestArena)).length;
  const observed=new Map();
  if(Array.isArray(x.observedAt)&&x.observedAt.length<=100){
    for(const item of x.observedAt){
      if(typeof item?.name==="string"&&validTime(item.at)&&
         Date.parse(item.at)<=captured&&parisDay(Date.parse(item.at))===day)
        observed.set(item.name,item.at);
    }
  }
  const seen=x.rows.filter(r=>positive(r.latestArena)&&observed.has(r.name));
  return {status:"valid",players:x.rows.length,ranks,
    withoutRank:x.rows.length-ranks,observedRanks:seen.length,
    capturedAt:x.capturedAt,
    latestObservedAt:seen.map(r=>observed.get(r.name)).sort().at(-1)||null,
    // Keep the private provenance only inside this module for history matching.
    _name:x.allianceName};
}
function inspectHistory(x,day){
  if(x.status==="missing")return {status:"missing",date:day,rankedPlayers:0};
  if(x.status!=="ok"||x.data?.version!==1||
    !Array.isArray(x.data.snapshots)||x.data.snapshots.length>32)
    return {status:"invalid",date:day,rankedPlayers:0};
  const candidate=x.data.snapshots.find(s=>s?.date===day&&
    s.sourceKind==="reward"&&s.sourceDay===day&&
    Array.isArray(s.players)&&s.players.length<=500);
  return candidate?{status:"present",date:day,
    rankedPlayers:candidate.players.length,_snapshot:candidate}:
    {status:"missing-day",date:day,rankedPlayers:0};
}
export async function handleAdminArenaCoverage(request,env,now=Date.now()){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return respond({error:"invalid-query"},400);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)return respond({error:"storage-unavailable"},503);
  if(!Number.isFinite(now))return respond({error:"invalid-clock"},503);
  const day=parisDay(now);
  if(!validDay(day))return respond({error:"invalid-clock"},503);
  try{
    const approved=await readCollectibleApprovals(env);
    if(approved.status==="invalid-registry")
      return respond({error:"invalid-registry"},503);
    const list=approved.alliances||[];
    const guests=new Set((approved.guestAlliances||[]).map(a=>a.fingerprint));
    if(list.length>100)return respond({error:"too-many-alliances"},503);
    const names=await cachedConnectedAllianceNames(bucket,guests,now);
    const [lospRaw,guestRaw]=await Promise.all([
      getJSON(bucket,ROOT+"arena-history/rolling.json",MAX_HISTORY_BYTES),
      guests.size?getJSON(bucket,ROOT+"guest-arena-history/rolling.json",
        MAX_HISTORY_BYTES):Promise.resolve({status:"missing",data:null})
    ]);
    const lospHistory=inspectHistory(lospRaw,day);
    const guestHistory=inspectHistory(guestRaw,day);
    // Never expose the source history or private players, only proofs/counts.
    const entries=[];
    for(const a of list){
      const isGuest=guests.has(a.fingerprint);
      const file=ROOT+a.fingerprint+"/campaigns/"+day+"-reward-infos.json";
      const info=inspectReceipt(await getJSON(bucket,file,MAX_RECEIPT_BYTES),
        a.fingerprint,day,now);
      const history=isGuest?guestHistory:lospHistory;
      const archived=info.status==="valid"&&history.status==="present"?
        history._snapshot.players.filter(p=>p?.alliance===info._name&&
          positive(p.arenaRank)).length:0;
      entries.push({name:isGuest?names.get(a.fingerprint)||info._name||"Alliance invitée":
          a.name,scope:isGuest?"guest":"losp",
        receipt:info.status,players:info.players,ranks:info.ranks,
        withoutRank:info.withoutRank,observedRanks:info.observedRanks,
        capturedAt:info.capturedAt,latestObservedAt:info.latestObservedAt,
        history:history.status==="present"?
          (info.status==="valid"?
            (archived===info.ranks?"present":"partial-or-unmatched"):
            "unverifiable"):history.status,
        archivedRanks:archived});
    }
    const summary={total:entries.length,
      losp:entries.filter(x=>x.scope==="losp").length,
      guests:entries.filter(x=>x.scope==="guest").length,
      receipts:entries.filter(x=>x.receipt==="valid").length};
    return respond({status:"ok",source:"private-r2-only",day,
      checkedAt:new Date(now).toISOString(),
      // Group-level statuses are not evidence of an individual measurement.
      history:{losp:lospHistory.status,guests:guestHistory.status},
      summary,alliances:entries});
  }catch{return respond({error:"arena-coverage-unavailable"},503);}
}
