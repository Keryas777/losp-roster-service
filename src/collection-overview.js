// Compact cross-collector R2 dashboard. NEVER contacts Scopely.
// Read-only, private and bounded: manifests and HEADs, not original player JSON.
// Routed only after Cloudflare Access + admin allowlist verification.
import {captainConfigReady,CAPTAIN_PREFIX,getCaptainRecord} from "./captain-vault.js";
import {gameArchiveStatus} from "./game-catalog-archive.js";
import {rosterAutoStatus} from "./automatic-roster-scheduler.js";
import {handleRosterR2Coverage} from "./roster-r2-coverage.js";
import {getPlayerCampaignStatus} from "./player-campaign.js";
import {adminRefreshCron} from "./admin-data-api.js";

const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const answer=(v,status=200)=>Response.json(v,{status,headers:HEADERS});
const HEX=/^[0-9a-f]{64}$/;
const FAMILIES=Object.freeze([
  {id:"personal-squads",label:"Équipes personnelles",scope:"m3p.f.pr.ros"},
  {id:"personal-inventory",label:"Inventaire",scope:"m3p.f.pr.inv"},
  {id:"personal-wishlist",label:"Souhaits",scope:"m3p.f.pr.inv"},
  {id:"personal-events",label:"Événements et progression",scope:"m3p.f.pr.act"}
]);
const PREFIX="roster-batches/v1/player-extras/";
const MAX_SESSIONS=100,CONCURRENCY=5,MAX_POINTER_BYTES=32000;
const validDate=x=>typeof x==="string"&&Number.isFinite(Date.parse(x));
async function accounts(bucket){
  const keys=[],seen=new Set();
  let cursor=null,loops=0;
  while(loops++<5){
    const data=await bucket.list({prefix:CAPTAIN_PREFIX,limit:100,
      ...(cursor?{cursor}:{})});
    if(!Array.isArray(data?.objects))throw Error("invalid-list");
    for(const item of data.objects){
      const id=String(item.key||"").slice(CAPTAIN_PREFIX.length);
      if(!HEX.test(id)||item.key!==CAPTAIN_PREFIX+id)continue;
      if(!seen.has(id)){keys.push(id);seen.add(id);}
      if(keys.length>MAX_SESSIONS)throw Error("too-many-sessions");
    }
    if(data.truncated!==true)return keys;
    if(!data.cursor||data.cursor===cursor)throw Error("invalid-cursor");
    cursor=data.cursor;
  }
  throw Error("incomplete-list");
}
async function pool(items,fn){
  const out=new Array(items.length);
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,items.length)},async()=>{
    while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]);}
  }));
  return out;
}
async function snapshot(bucket,sid,family,now){
  const key=PREFIX+sid+"/"+family+"/self/latest.json";
  const found=await bucket.get(key);
  if(!found)return {state:"missing"};
  if(Number.isSafeInteger(found.size)&&found.size>MAX_POINTER_BYTES)
    return {state:"invalid"};
  let v;
  try{
    const raw=await found.text();
    if(raw.length>MAX_POINTER_BYTES)return {state:"invalid"};
    v=JSON.parse(raw);
  }catch{return {state:"invalid"};}
  if(v?.version!==1||v.complete!==true||v.resource!==family||
     !validDate(v.capturedAt)||!validDate(v.expiresAt)||
     !Array.isArray(v.pages)||!v.pages.length||v.pages.length>8||
     !Number.isSafeInteger(v.total)||v.total<0||
     !v.pages.every(p=>typeof p.key==="string"&&
       p.key.startsWith(PREFIX+sid+"/"+family+"/self/")&&
       p.key!==key))
    return {state:"invalid"};
  if(Date.parse(v.expiresAt)<=now)return {state:"expired"};
  const checks=await pool(v.pages,p=>bucket.head(p.key));
  return checks.every(Boolean)?
    {state:"archived",capturedAt:v.capturedAt,entries:v.total,pages:v.pages.length,
      trigger:["automatic-campaign","admin-manual"].includes(v.trigger)?v.trigger:"unknown"}:
    {state:"missing-pages"};
}
async function personalCoverage(env,now){
  const bucket=env.CAPTAIN_BUCKET;
  const ids=await accounts(bucket);
  const grants=await pool(ids,async sid=>{
    const record=await getCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,
      CAPTAIN_PREFIX+sid,now);
    return record?{sid,scopes:new Set(record.scope.trim().split(/\s+/))}:null;
  });
  const active=grants.filter(Boolean);
  const items=active.flatMap(g=>FAMILIES.filter(f=>g.scopes.has(f.scope))
    .map(f=>({sid:g.sid,family:f.id})));
  const facts=await pool(items,x=>snapshot(bucket,x.sid,x.family,now));
  const rows=FAMILIES.map(f=>{
    const data=facts.filter((x,i)=>items[i].family===f.id);
    const saved=data.filter(x=>x.state==="archived");
    return {id:f.id,label:f.label,
      eligible:data.length,archived:saved.length,
      missing:data.filter(x=>x.state==="missing").length,
      broken:data.filter(x=>["invalid","expired","missing-pages"].includes(x.state)).length,
      notGranted:active.length-data.length,
      automatic:saved.filter(x=>x.trigger==="automatic-campaign").length,
      manual:saved.filter(x=>x.trigger==="admin-manual").length,
      provenanceUnknown:saved.filter(x=>x.trigger==="unknown").length,
      totalEntries:saved.reduce((n,x)=>n+x.entries,0),
      lastCapture:saved.map(x=>x.capturedAt).sort().at(-1)||null,
      // null if a family is not authorized for any OAuth account.
      state:!data.length?"not-authorized":
        saved.length===data.length?"archived":
        !saved.length?"not-covered":"partial"};
  });
  return {status:"ok",accountsStored:ids.length,accountsActive:active.length,
    families:rows,mode:"physical-R2-latest-and-page-head",
    note:"Compte OAuth déchiffré localement, aucune donnée de joueur renvoyée."};
}
async function safeRead(fn){
  try{return await fn();}catch{return {status:"unavailable"};}
}
export async function handleCollectionOverview(request,env,now=Date.now()){
  if(request.method!=="GET")return answer({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return answer({error:"invalid-query"},400);
  if(!captainConfigReady(env)||!env?.CAPTAIN_BUCKET?.list||
     !env.CAPTAIN_BUCKET?.head)
    return answer({error:"storage-unavailable"},503);
  // Every dependency reads existing R2 state only. In particular NO
  // adminSessionList/adminCoverage/refresh action is called.
  const [rosters,rosterScheduler,game,player,oauth,personal]=await Promise.all([
    safeRead(async()=>{
      const res=await handleRosterR2Coverage(new Request(
        "https://admin-status.internal/admin/api/roster-r2-coverage"),env,now);
      if(!res.ok)throw Error("roster-overview-unavailable");
      const obj=await res.json();
      return {status:obj.status,registryStatus:obj.registryStatus,
        checkedAt:obj.checkedAt,approvedCount:obj.approvedCount,
        alliances:(obj.alliances||[]).map(a=>({
          name:a.name,progress:a.progress?.status||"unknown",
          capturedAt:a.manifest?.capturedAt||null,
          expiresAt:a.manifest?.expiresAt||null,
          snapshot:a.manifest?.status||"missing",
          // Manifest validity != physical verification of all files.
          verified:false,completed:a.progress?.completed??null,
          eligible:a.progress?.eligibleCoMembers??null,
          personalRosterCollected:a.progress?.personalRosterCollected===true,
          lastCampaign:a.progress?.campaign||null
        }))};
    }),
    safeRead(()=>rosterAutoStatus(env,now)),
    safeRead(()=>gameArchiveStatus(env,now)),
    safeRead(async()=>{
      const res=await getPlayerCampaignStatus(env);
      if(!res.ok)throw Error("player-campaign-unavailable");
      return res.json();
    }),
    safeRead(async()=>{
      const res=await adminRefreshCron(env);
      if(!res.ok)throw Error("oauth-monitor-unavailable");
      return res.json();
    }),
    safeRead(()=>personalCoverage(env,now))
  ]);
  return answer({status:"ok",source:"private-r2-only",
    checkedAt:new Date(now).toISOString(),rosters,rosterScheduler,
    game,player,oauth,personal,
    warning:"Les comptes et endpoints manquants ou non autorisés ne sont jamais comptés comme archivés. "+
      "Rosters : manifests non vérifiés physiquement en détail dans ce bilan; "+
      "l'audit R2 complet reste dans l'onglet Rosters."});
}
