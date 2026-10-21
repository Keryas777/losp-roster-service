// Admin-only, read-only view of APPROVED roster snapshots already in R2.
// No Scopely GET, OAuth refresh, Durable Object lock or storage mutation.
import {readApproval} from "./roster-sync-preflight.js";
import {BATCH_PREFIX,BATCH_MAX_AGE_MS,completeKey} from "./private-roster-batches.js";

const FP=/^[a-f0-9]{64}$/;
const RUN=/^[a-f0-9-]{36}$/;
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex","Referrer-Policy":"no-referrer"};
const respond=(data,status=200)=>Response.json(data,{status,headers:HEADERS});
const validDate=x=>typeof x==="string"&&Number.isFinite(Date.parse(x));
const progressKey=fp=>BATCH_PREFIX+fp+"/progress.json";
const selfKey=(fp,run)=>BATCH_PREFIX+fp+"/"+run+"/member-self.json";
const memberKey=(fp,run,i)=>BATCH_PREFIX+fp+"/"+run+"/member-"+i+".json";

async function r2JSON(bucket,key){
  const object=await bucket.get(key);
  if(!object)return {state:"missing"};
  const raw=await object.text();
  if(raw.length>30000)return {state:"invalid"};
  try{return {state:"present",value:JSON.parse(raw)};}
  catch{return {state:"invalid"};}
}
function validProgress(p,fp){
  return p?.version===1&&p.fingerprint===fp&&RUN.test(p.runId)&&
    FP.test(p.membershipDigest)&&Number.isInteger(p.completed)&&p.completed>=0&&
    Number.isInteger(p.totalEligible)&&p.totalEligible>=1&&p.totalEligible<=100&&
    p.completed<=p.totalEligible&&validDate(p.startedAt)&&validDate(p.expiresAt)&&
    Date.parse(p.expiresAt)-Date.parse(p.startedAt)===BATCH_MAX_AGE_MS&&
    (p.selfCompleted===undefined||typeof p.selfCompleted==="boolean")&&
    (p.observedMembers===undefined||
      (Number.isInteger(p.observedMembers)&&p.observedMembers>=p.totalEligible+1&&
       p.observedMembers<=100))&&
    (p.campaign===undefined||typeof p.campaign==="string");
}
function validManifest(m,fp){
  return m?.version===1&&m.fingerprint===fp&&RUN.test(m.runId)&&
    FP.test(m.membershipDigest)&&Number.isInteger(m.total)&&
    m.total>=1&&m.total<=100&&m.includesPersonal===true&&
    Number.isInteger(m.coMembers)&&m.coMembers===m.total-1&&
    Number.isInteger(m.observedMembers)&&m.observedMembers===m.total&&
    validDate(m.capturedAt)&&validDate(m.expiresAt);
}
async function checkFiles(bucket,fp,run,coMembers,includeSelf){
  // HEAD checks existence only; it never loads or returns player data.
  const keys=Array.from({length:coMembers},(_,i)=>memberKey(fp,run,i));
  if(includeSelf)keys.push(selfKey(fp,run));
  let missing=0;
  for(let i=0;i<keys.length;i+=5){
    const group=await Promise.all(keys.slice(i,i+5).map(key=>bucket.head(key)));
    missing+=group.filter(x=>!x).length;
  }
  return {checked:keys.length,missing,allPresent:missing===0,
    verification:"r2-head-only"};
}
async function allianceState(bucket,entry,now,full){
  const fp=entry.fingerprint;
  const [progressObject,manifestObject]=await Promise.all([
    r2JSON(bucket,progressKey(fp)),r2JSON(bucket,completeKey(fp))
  ]);
  const p=progressObject.value,m=manifestObject.value;
  const progressOK=progressObject.state==="present"&&validProgress(p,fp);
  const manifestOK=manifestObject.state==="present"&&validManifest(m,fp);
  const progress={status:progressObject.state==="missing"?"not-started":
    !progressOK?"invalid":Date.parse(p.expiresAt)<=now?"expired":
    p.completed<p.totalEligible?"in-progress":p.selfCompleted!==true?
      "complete-co-members":p.totalEligible+1===p.observedMembers?
        "complete":"partial-consent"};
  if(progressOK){
    Object.assign(progress,{campaign:p.campaign||null,startedAt:p.startedAt,
      expiresAt:p.expiresAt,completed:p.completed,eligibleCoMembers:p.totalEligible,
      remaining:p.totalEligible-p.completed,observedMembers:p.observedMembers??null,
      noShareCount:Number.isInteger(p.observedMembers)?
        p.observedMembers-p.totalEligible-1:null,
      personalRosterCollected:p.selfCompleted===true});
    progress.personalFilePresent=p.selfCompleted===true?
      Boolean(await bucket.head(selfKey(fp,p.runId))):null;
    if(full)progress.files=await checkFiles(bucket,fp,p.runId,
      p.completed,p.selfCompleted===true);
  }
  const manifest={status:manifestObject.state==="missing"?"missing":
    !manifestOK?"invalid":Date.parse(m.expiresAt)<=now?"expired":"valid"};
  if(manifestOK){
    const sameRun=progressOK&&p.runId===m.runId&&p.membershipDigest===m.membershipDigest;
    Object.assign(manifest,{capturedAt:m.capturedAt,expiresAt:m.expiresAt,
      members:m.total,coMembers:m.coMembers,
      matchesCurrentProgress:progressOK?sameRun:null});
    manifest.personalFilePresent=Boolean(await bucket.head(selfKey(fp,m.runId)));
    if(full)manifest.files=await checkFiles(bucket,fp,m.runId,m.coMembers,true);
    manifest.verified=manifest.status==="valid"&&manifest.personalFilePresent&&
      (full?manifest.files.allPresent:null);
    // A null value means that not all backing member files were checked.
    if(!full)manifest.verified=null;
  }
  return {name:entry.name,fingerprint:fp,approved:true,progress,manifest};
}
export async function handleRosterR2Coverage(request,env,now=Date.now()){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(k=>k!=="fingerprint")||
    params.getAll("fingerprint").length>1)return respond({error:"invalid-query"},400);
  const selected=params.get("fingerprint");
  if(selected!==null&&!FP.test(selected))return respond({error:"invalid-selection"},400);
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.head)return respond({error:"storage-unavailable"},503);
  try{
    const registry=await readApproval(env);
    if(registry.status==="invalid-registry")return respond({error:"invalid-registry"},503);
    const entries=selected?
      registry.alliances.filter(a=>a.fingerprint===selected):registry.alliances;
    if(selected&&!entries.length)return respond({error:"alliance-not-approved"},403);
    const full=selected!==null;
    const alliances=[];
    for(const item of entries)alliances.push(await allianceState(bucket,item,now,full));
    return respond({status:"ok",source:"private-r2-only",scope:full?"full":"summary",
      checkedAt:new Date(now).toISOString(),registryStatus:registry.status,
      approvedCount:registry.alliances.length,alliances,
      note:full?"Fichiers vérifiés par HEAD R2, sans validation du contenu des rosters.":
        "Pour vérifier tous les fichiers d'une alliance, fournir son fingerprint."});
  }catch{return respond({error:"r2-coverage-unavailable"},503);}
}
