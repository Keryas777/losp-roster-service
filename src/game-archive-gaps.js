// Read-only diagnosis of errors already recorded by the private /game/v1
// archive. No Scopely fetch, cron, locks, R2 mutation or player data.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
import {isItemCharacterAssociation} from "./game-archive-recovery.js";

const ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const json=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const safeRun=id=>typeof id==="string"&&/^[a-f0-9-]{36}$/i.test(id);
const safePath=path=>typeof path==="string"&&path.length<=800&&
  /^\/game\/v1\/[a-zA-Z0-9/_:?.=%&,+-]+$/.test(path)?path:null;
const cleanReason=reason=>typeof reason==="string"&&
  /^[a-z0-9-]{1,90}$/.test(reason)?reason:"unspecified";
const validStatus=status=>Number.isInteger(status)&&
  status>=100&&status<=599?status:null;
const familyOf=path=>{
  if(!path)return "inconnue";
  const relative=path.slice("/game/v1/".length).split("?")[0];
  const chunks=relative.split("/");
  return chunks[0]==="analysis"&&chunks[1]==="teamOrder"
    ?"analysis/teamOrder":chunks[0]||"inconnue";
};
const categoryOf=(reason,status,path)=>{
  if(status===404&&isItemCharacterAssociation(path))
    return "association-objet-personnage-indisponible";
  if(reason==="archived-but-unindexed")return "indexation-requise";
  if(reason==="unpageable-root-detail-fallback")return "alternative-partielle";
  if(reason==="retry-exhausted")return "reprise-a-etudier";
  if(reason==="undiscoverable-detail-id")return "identifiant-manquant";
  if(reason==="unrecognized-object-key")return "schema-a-etudier";
  if(reason.startsWith("pagination-")||reason==="duplicate-page")
    return "pagination-a-etudier";
  if(status===472||reason==="provider-472-not-pageable")
    return "volume-ou-pagination";
  if([401,403,464,474].includes(status))return "acces-a-verifier";
  if([404,422].includes(status))return "introuvable-a-verifier";
  if(status===429)return "temporisation-fournisseur";
  return "a-investiguer";
};
const ordered=map=>[...map].map(([value,count])=>({value,count}))
  .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,"fr"));
const count=(map,key)=>map.set(key,(map.get(key)||0)+1);
const validQuery=(raw,max)=>raw===null?null:
  typeof raw==="string"&&raw.length<=max&&/^[A-Za-z0-9/_-]+$/.test(raw)
    ?raw:undefined;

export async function handleGameArchiveGapAudit(request,env){
  if(request.method!=="GET")return json({error:"method-not-allowed"},405);
  if(!env?.CAPTAIN_BUCKET?.get)return json({error:"storage-unavailable"},503);
  const params=new URL(request.url).searchParams;
  const offsetRaw=params.get("offset"),limitRaw=params.get("limit");
  const offset=offsetRaw===null?0:Number(offsetRaw),
    limit=limitRaw===null?25:Number(limitRaw);
  const family=validQuery(params.get("family"),80),
    cause=validQuery(params.get("cause"),100);
  if(!Number.isSafeInteger(offset)||offset<0||
     !Number.isSafeInteger(limit)||limit<1||limit>50||
     family===undefined||cause===undefined)
    return json({error:"invalid-pagination-or-filter"},400);
  try{
    const activeObject=await env.CAPTAIN_BUCKET.get(ACTIVE);
    if(!activeObject)return json({status:"not-started",total:0,
      distinctPaths:0,byCause:[],byFamily:[],byCategory:[],byHttpStatus:[],
      entries:[],offset,limit,matching:0,nextOffset:null});
    const active=JSON.parse(await activeObject.text());
    if(!safeRun(active?.runId))return json({error:"invalid-state"},503);
    const stateObject=await env.CAPTAIN_BUCKET.get(
      GAME_ARCHIVE_ROOT+"runs/"+active.runId+"/progress.json");
    if(!stateObject)return json({error:"missing-progress"},503);
    const state=JSON.parse(await stateObject.text());
    if(state?.runId!==active.runId||!Array.isArray(state.gaps))
      return json({error:"invalid-state"},503);
    const byCause=new Map(),byFamily=new Map(),byCategory=new Map(),
      byHttpStatus=new Map(),byRecovery=new Map(),paths=new Set();
    const normalized=[];
    for(const original of state.gaps){
      // Never send arbitrary properties (such as private R2 objectKey) to UI.
      const path=safePath(original?.path),reason=cleanReason(original?.reason),
        status=validStatus(original?.status),category=categoryOf(reason,status,path),
        family=familyOf(path),attempts=Number.isSafeInteger(original?.attempts)&&
          original.attempts>0?original.attempts:null,
        affectedCount=Number.isSafeInteger(original?.count)&&original.count>0?
          original.count:null;
      const recoveryRecord=path&&status===472?
        state.recovery?.records?.[path]:null;
      const recoveryStatus=!recoveryRecord?null:
        recoveryRecord.expected.length===recoveryRecord.archived.length?
          "all-split-parts-archived":
        recoveryRecord.archived.length>0?"some-split-parts-archived":
        recoveryRecord.failed.length>0?"split-parts-failed":"split-parts-queued";
      if(recoveryStatus)count(byRecovery,recoveryStatus);
      count(byCause,reason);count(byFamily,family);
      count(byCategory,category);
      count(byHttpStatus,status===null?"non-renseigne":String(status));
      if(path)paths.add(path);
      normalized.push({path,reason,status,family,category,
        ...(recoveryStatus?{recoveryStatus,
          archivedParts:recoveryRecord.archived.length,
          expectedParts:recoveryRecord.expected.length}:{}),
        ...(attempts!==null?{attempts}:{}),
        ...(affectedCount!==null?{affectedCount}:{})});
    }
    const matchingRows=normalized.filter(entry=>
      (!family||entry.family===family)&&(!cause||entry.reason===cause));
    // Newest logged gaps first; the result reflects a live snapshot and
    // may change as the running collector appends more gaps.
    const entries=matchingRows.slice().reverse().slice(offset,offset+limit);
    return json({status:state.status||"unknown",
      collectedAt:new Date().toISOString(),total:normalized.length,
      distinctPaths:paths.size,archivedResponses:state.count||0,
      tasksProcessed:(state.completedOffset||0)+(state.cursor||0),
      byCause:ordered(byCause),byFamily:ordered(byFamily),
      byCategory:ordered(byCategory),byHttpStatus:ordered(byHttpStatus),
      byRecovery:ordered(byRecovery),
      matching:matchingRows.length,entries,offset,limit,
      nextOffset:offset+entries.length<matchingRows.length?
        offset+entries.length:null,
      // Explicitly do NOT treat archived counts or errors as proof that
      // every resource was recovered or definitively inaccessible.
      note:"Signalements cumulatifs. Les variantes archivées ne prouvent pas la reconstitution fidèle de la réponse complète."});
  }catch{
    return json({error:"audit-unavailable"},503);
  }
}
