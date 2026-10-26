// Read-only inspection of actual private /player R2 files.
// Authentication is enforced by handleAdmin BEFORE this handler.
// Only allowlisted roots, validated selectors, approved alliances and valid
// OAuth grants. No Scopely fetch, writes, arbitrary keys, tokens or public assets.
import {CAPTAIN_PREFIX,captainConfigReady,getCaptainRecord} from "./captain-vault.js";
import {CONNECTED_ALLIANCE_PREFIX} from "./connected-alliance-index.js";
import {PLAYER_EXTRA_FAMILIES} from "./player-extras-archive.js";
import {readApproval} from "./roster-sync-preflight.js";
import {BATCH_PREFIX,completeKey} from "./private-roster-batches.js";
import {handleRosterR2Coverage} from "./roster-r2-coverage.js";
import {getPlayerCampaignStatus} from "./player-campaign.js";

const ID=/^[a-f0-9]{64}$/;
const RUN=/^[a-f0-9-]{36}$/;
const SOURCE=/^[a-f0-9-]{36}\/(?:alliance-card|members-(?:before|after)|roster-(?:self|member-\d+)-page-\d+)\.json$/;
const FAMILIES=PLAYER_EXTRA_FAMILIES;
const EXTRA_ROOT=BATCH_PREFIX+"player-extras/";
const CHECKPOINT=BATCH_PREFIX+"player-campaign/current.json";
const HEADERS={"Cache-Control":"private, no-store","Pragma":"no-cache",
  "X-Robots-Tag":"noindex, nofollow, noarchive",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(data,status=200)=>Response.json(data,{status,headers:HEADERS});
const validDate=x=>typeof x==="string"&&Number.isFinite(Date.parse(x));
const allowed=(query,keys)=>[...query.keys()].every(k=>keys.includes(k)&&query.getAll(k).length===1);
const short=x=>typeof x==="string"?x.slice(0,80):null;
const previewCount=20;
const MAX_META=32000,MAX_SOURCE=3200000;
async function read(bucket,key,max=MAX_META){
  const obj=await bucket.get(key);
  if(!obj)return {status:"missing"};
  if(Number.isSafeInteger(obj.size)&&obj.size>max)return {status:"too-large"};
  try{
    const body=await obj.text();
    if(body.length>max)return {status:"too-large"};
    return {status:"ok",data:JSON.parse(body),bytes:body.length};
  }catch{return {status:"invalid-json"};}
}
async function account(bucket,env,sid,now){
  const record=await getCaptainRecord(bucket,env.CAPTAIN_ENCRYPTION_KEY_HEX,
    CAPTAIN_PREFIX+sid,now);
  return record?{scopes:new Set(record.scope.split(/\s+/))}:null;
}
async function approved(env,fp){
  const registry=await readApproval(env);
  if(registry.status==="invalid-registry")return null;
  return registry.alliances.find(x=>x.fingerprint===fp)||null;
}
function sliced(document,offset){
  // Return original fields and only 20 actual entries per request.
  // Never silently mislabel a paginated preview as a complete JSON file.
  const v=structuredClone(document),source=v?.providerResponse;
  let list=null;
  if(Array.isArray(source?.data))list=source.data;
  else if(Array.isArray(v?.characters))list=v.characters;
  if(!list)return {document:v,entries:null,offset:0,shown:null,hasMore:false};
  const total=list.length;
  if(source&&Array.isArray(source.data))source.data=list.slice(offset,offset+previewCount);
  else v.characters=list.slice(offset,offset+previewCount);
  return {document:v,entries:total,offset,
    shown:Math.max(0,Math.min(previewCount,total-offset)),
    hasMore:offset+previewCount<total};
}
function entryMeta(value,prefix,now){
  if(value?.version!==1||value.complete!==true||
     !Array.isArray(value.pages)||value.pages.length<1||value.pages.length>8||
     !validDate(value.capturedAt)||!validDate(value.expiresAt)||
     !Number.isSafeInteger(value.total)||value.total<0||
     value.pages.some((p,i)=>p?.page!==i+1||
       typeof p.key!=="string"||!p.key.startsWith(prefix)||
       !/\/page-[1-8]\.json$/.test(p.key)||!Number.isSafeInteger(p.count)||
       p.count<0))return {status:"invalid-manifest"};
  if(Date.parse(value.expiresAt)<=now)return {status:"expired",
    capturedAt:value.capturedAt,expiresAt:value.expiresAt};
  if(Date.parse(value.capturedAt)>now)return {status:"invalid-manifest"};
  return {status:"indexed",capturedAt:value.capturedAt,
    expiresAt:value.expiresAt,pages:value.pages.length,entries:value.total,
    asOf:value.asOf??null,origin:value.trigger||"unknown",pageKeys:value.pages.map(p=>p.key)};
}
async function extraStatus(bucket,prefix,expectedFamily,now){
  const obj=await read(bucket,prefix+"latest.json");
  if(obj.status!=="ok")return {status:obj.status};
  if(obj.data?.resource!==expectedFamily)return {status:"invalid-manifest"};
  const parsed=entryMeta(obj.data,prefix,now);
  if(parsed.status!=="indexed")return parsed;
  const proofs=[];
  for(const key of parsed.pageKeys)proofs.push(Boolean(await bucket.head(key)));
  const {pageKeys,...result}=parsed;
  return {...result,status:proofs.every(Boolean)?"archived":"missing-pages",
    presentPages:proofs.filter(Boolean).length};
}
async function diagnostics(bucket,sid,family){
  const raw=await read(bucket,CHECKPOINT,200000);
  if(raw.status!=="ok")return {status:raw.status,events:[]};
  const c=raw.data;
  if(!Array.isArray(c?.sessions))return {status:"invalid",events:[]};
  const errors=Array.isArray(c.errors)?c.errors.filter(e=>e?.session===sid&&
    e.family===family).slice(-15).map(e=>({
      at:e.at,reason:short(e.reason),retry:e.retry
    })):[];
  return {status:"ok",events:errors,
    note:"Les erreurs antérieures à l'ajout des diagnostics détaillés ne sont pas reconstituées."};
}
async function accounts(bucket){
  const result=[];let cursor,loops=0;
  do{
    const list=await bucket.list({prefix:CAPTAIN_PREFIX,limit:100,
      ...(cursor?{cursor}:{})});
    if(!Array.isArray(list?.objects))throw Error("invalid-list");
    for(const item of list.objects){
      const id=item.key?.slice(CAPTAIN_PREFIX.length);
      if(ID.test(id||"")&&item.key===CAPTAIN_PREFIX+id)
        result.push(id);
      if(result.length>100)throw Error("account-list-too-large");
    }
    if(list.truncated!==true)break;
    if(typeof list.cursor!=="string"||!list.cursor||list.cursor===cursor)
      throw Error("invalid-cursor");
    cursor=list.cursor;
  }while(++loops<5);
  if(loops>=5)throw Error("account-list-incomplete");
  return [...new Set(result)];
}
async function manifest(env,fp,now){
  const item=await approved(env,fp);
  if(!item)return {error:"alliance-not-approved",status:403};
  const record=await read(env.CAPTAIN_BUCKET,completeKey(fp));
  if(record.status!=="ok")return {item,manifestStatus:record.status};
  const m=record.data;
  if(m?.version!==1||m.fingerprint!==fp||!RUN.test(m.runId||"")||
     !Number.isInteger(m.coMembers)||m.coMembers<0||m.coMembers>100||
     m.total!==m.coMembers+1||!validDate(m.expiresAt)||
     !validDate(m.capturedAt))return {item,manifestStatus:"invalid-manifest"};
  if(Date.parse(m.expiresAt)<=now)return {item,manifestStatus:"expired",
    capturedAt:m.capturedAt,expiresAt:m.expiresAt};
  return {item,manifestStatus:"valid",record:m};
}
function view(document,offset){
  // Stored player data can include names/PIDs; never write or cache response.
  const source=sliced(document,offset);
  // Future provider fields that look like credential storage are masked ONLY
  // in the returned admin preview; the original R2 bytes remain untouched.
  const hidden=/^(?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|cookie|password)$/i;
  function redact(v,depth=0){
    if(depth>36)return "[profondeur maximale d'affichage]";
    if(Array.isArray(v))return v.map(x=>redact(x,depth+1));
    if(v&&typeof v==="object"){
      const o={};
      for(const [k,x] of Object.entries(v))
        o[k]=hidden.test(k)?"[masqué]":redact(x,depth+1);
      return o;
    }
    return v;
  }
  source.document=redact(source.document);
  return source;
}
export async function handlePlayerR2Explorer(request,env,now=Date.now()){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  if(!captainConfigReady(env)||!env.CAPTAIN_BUCKET?.list||
     !env.CAPTAIN_BUCKET?.head)return respond({error:"storage-unavailable"},503);
  const p=new URL(request.url).searchParams,mode=p.get("view");
  const allowedKeys=["view","session","family","target","page","offset",
    "fingerprint","member","source","cursor"];
  if(!allowed(p,allowedKeys))return respond({error:"invalid-query"},400);
  const bucket=env.CAPTAIN_BUCKET,offset=p.has("offset")?Number(p.get("offset")):0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>2000||
     offset%previewCount!==0)return respond({error:"invalid-offset"},400);
  try{
    if(mode==="accounts"&&p.size===1){
      const ids=await accounts(bucket),entries=[];
      for(const id of ids){
        const [grant,index]=await Promise.all([
          account(bucket,env,id,now),
          read(bucket,CONNECTED_ALLIANCE_PREFIX+id,1200)
        ]);
        entries.push({session:id,active:!!grant,
          alliance:grant&&index.status==="ok"?short(index.data?.name):null});
      }
      const registry=await readApproval(env);
      const state=await getPlayerCampaignStatus(env);
      const campaign=state.ok?await state.json():{status:"unavailable"};
      return respond({status:"ok",source:"private-r2-only",accounts:entries,
        alliances:registry.alliances,registryStatus:registry.status,
        campaign,warning:"Les contenus sont privés. Le partage actuel n'est pas revérifié auprès de Scopely."});
    }
    if(mode==="extra"&&ID.test(p.get("session")||"")&&
       Object.hasOwn(FAMILIES,p.get("family")||"")&&
       [...p.keys()].every(x=>["view","session","family","cursor"].includes(x))){
      const sid=p.get("session"),family=p.get("family"),def=FAMILIES[family];
      const grant=await account(bucket,env,sid,now);
      if(!grant)return respond({error:"oauth-unavailable"},403);
      const hasScope=grant.scopes.has(def.scope);
      const prefix=EXTRA_ROOT+sid+"/"+family+"/";
      const traces=await diagnostics(bucket,sid,family);
      if(!hasScope)return respond({status:"scope-not-granted",family,traces,
        entries:[]});
      if(!def.shared){
        const target="self";
        return respond({status:"ok",family,session:sid,
          entries:[{target,...await extraStatus(bucket,prefix+target+"/",family,now)}],
          traces,more:false});
      }
      const cursor=p.get("cursor");
      if(cursor!==null&&(!/^[A-Za-z0-9_=-]{1,1024}$/.test(cursor)))
        return respond({error:"invalid-cursor"},400);
      const list=await bucket.list({prefix,limit:100,
        ...(cursor?{cursor}:{})});
      if(!Array.isArray(list?.objects))return respond({error:"invalid-r2-list"},503);
      const targets=[...new Set(list.objects.map(x=>x.key).filter(x=>
        typeof x==="string"&&x.endsWith("/latest.json")).map(x=>
        x.slice(prefix.length,-"/latest.json".length)).filter(x=>ID.test(x)))];
      const entries=[];
      for(const target of targets)
        entries.push({target,...await extraStatus(bucket,prefix+target+"/",family,now)});
      return respond({status:"ok",session:sid,family,entries,traces,
        more:list.truncated===true,nextCursor:list.truncated===true?list.cursor:null,
        note:"Membres identifiés uniquement par empreinte ; historique de partage non revérifié."});
    }
    if(mode==="extra-file"&&ID.test(p.get("session")||"")&&
       Object.hasOwn(FAMILIES,p.get("family")||"")&&
       [...p.keys()].every(x=>["view","session","family","target","page","offset"].includes(x))){
      const sid=p.get("session"),family=p.get("family"),def=FAMILIES[family],
        target=p.get("target")||"self",page=Number(p.get("page"));
      if((def.shared?!ID.test(target):target!=="self")||
         !Number.isSafeInteger(page)||page<1||page>8)
        return respond({error:"invalid-selection"},400);
      const grant=await account(bucket,env,sid,now);
      if(!grant||!grant.scopes.has(def.scope))return respond({error:"oauth-or-scope-unavailable"},403);
      const prefix=EXTRA_ROOT+sid+"/"+family+"/"+target+"/";
      const latest=await read(bucket,prefix+"latest.json");
      if(latest.status!=="ok")return respond({error:latest.status},404);
      if(latest.data?.resource!==family)return respond({error:"invalid-manifest"},409);
      const descriptor=entryMeta(latest.data,prefix,now);
      if(descriptor.status!=="indexed")return respond({error:descriptor.status},409);
      if(page>descriptor.pageKeys.length)return respond({error:"page-out-of-range"},400);
      const stored=await read(bucket,descriptor.pageKeys[page-1],MAX_SOURCE);
      if(stored.status!=="ok")return respond({error:stored.status},stored.status==="missing"?404:409);
      const obj=stored.data;
      if(obj?.version!==1||obj.resource!==family||
         obj.scope!==def.scope||!Object.hasOwn(obj,"providerResponse")||
         !validDate(obj.capturedAt)||obj.capturedAt!==latest.data.capturedAt)
        return respond({error:"source-inconsistent"},409);
      return respond({status:"ok",source:"private-r2-only",
        file:{kind:"provider-page",family,target,page,
          bytes:stored.bytes,endpoint:short(obj.endpoint),
          capturedAt:obj.capturedAt,expiresAt:latest.data.expiresAt},
        ...view(obj,offset)});
    }
    if(mode==="roster"&&ID.test(p.get("fingerprint")||"")&&p.size===2){
      const fp=p.get("fingerprint"),m=await manifest(env,fp,now);
      if(m.error)return respond({error:m.error},m.status);
      const coverage=await handleRosterR2Coverage(new Request(
        "https://r2-inspector.internal/admin/api/roster-r2-coverage?fingerprint="+fp),env,now);
      const report=coverage.ok?(await coverage.json()).alliances?.[0]||null:null;
      const result={status:"ok",alliance:m.item.name,fingerprint:fp,
        manifestStatus:m.manifestStatus,coverage:report};
      if(m.record)Object.assign(result,{runId:m.record.runId,
        lastCompleteAt:m.record.capturedAt,expiresAt:m.record.expiresAt,
        total:m.record.total,coMembers:m.record.coMembers,
        observedMembers:m.record.observedMembers,sharing:m.record.coverage,
        roles:["self",...Array.from({length:m.record.coMembers},(_,i)=>String(i))]});
      return respond(result);
    }
    if((mode==="roster-file"||mode==="roster-sources"||
        mode==="roster-source")&&ID.test(p.get("fingerprint")||"")){
      const fp=p.get("fingerprint"),m=await manifest(env,fp,now);
      if(m.error)return respond({error:m.error},m.status);
      if(!m.record)return respond({error:m.manifestStatus},404);
      const base=BATCH_PREFIX+fp+"/"+m.record.runId+"/";
      if(mode==="roster-file"&&
         [...p.keys()].every(x=>["view","fingerprint","member","offset"].includes(x))){
        const role=p.get("member");
        if(role!=="self"&&(!/^(0|[1-9]\d{0,2})$/.test(role||"")||
          Number(role)>=m.record.coMembers))return respond({error:"invalid-member"},400);
        const key=base+(role==="self"?"member-self.json":"member-"+role+".json");
        const result=await read(bucket,key,MAX_SOURCE);
        if(result.status!=="ok")return respond({error:result.status},404);
        const obj=result.data;
        if(obj?.version!==1||obj.runId!==m.record.runId||
           obj.allianceFingerprint!==fp||
           String(obj.memberIndex)!==role||!Array.isArray(obj.characters))
          return respond({error:"source-inconsistent"},409);
        return respond({status:"ok",source:"private-r2-only",
          file:{kind:"normalized-roster",role,bytes:result.bytes,
            capturedAt:obj.capturedAt,expiresAt:obj.expiresAt},
          ...view(obj,offset)});
      }
      if(mode==="roster-sources"&&
         [...p.keys()].every(x=>["view","fingerprint","cursor"].includes(x))){
        const cursor=p.get("cursor");
        if(cursor!==null&&!/^[A-Za-z0-9_=-]{1,1024}$/.test(cursor))
          return respond({error:"invalid-cursor"},400);
        const list=await bucket.list({prefix:base+"provider-source/",limit:100,
          ...(cursor?{cursor}:{})});
        const sources=(list.objects||[]).map(x=>x.key?.slice((base+"provider-source/").length))
          .filter(x=>SOURCE.test(x||""));
        return respond({status:"ok",source:"private-r2-only",sources,
          more:list.truncated===true,nextCursor:list.truncated===true?list.cursor:null});
      }
      if(mode==="roster-source"&&
         [...p.keys()].every(x=>["view","fingerprint","source","offset"].includes(x))){
        const selection=p.get("source");
        if(!SOURCE.test(selection||""))return respond({error:"invalid-source"},400);
        const stored=await read(bucket,base+"provider-source/"+selection,MAX_SOURCE);
        if(stored.status!=="ok")return respond({error:stored.status},404);
        const obj=stored.data;
        if(obj?.version!==1||obj.kind!=="private-provider-source"||
           obj.runId!==m.record.runId||obj.allianceFingerprint!==fp||
           typeof obj.endpoint!=="string"||
           !obj.endpoint.startsWith("/player/v1/"))
          return respond({error:"source-inconsistent"},409);
        return respond({status:"ok",source:"private-r2-only",
          file:{kind:"provider-source",name:selection,bytes:stored.bytes,
            endpoint:short(obj.endpoint),capturedAt:obj.capturedAt,
            expiresAt:m.record.expiresAt},
          ...view(obj,offset)});
      }
    }
    return respond({error:"invalid-query"},400);
  }catch{
    return respond({error:"r2-inspection-unavailable"},503);
  }
}
