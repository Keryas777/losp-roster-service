// Durable R2-only inventory of /game/v1 ability-material IDs.
// Manually started under Admin Access; the existing minute Cron resumes it.
// Never reads /player, calls Scopely, or alters source objects/receipts/diffs.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,ACTIVE=ROOT+"active.json";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const LOCK="9".repeat(64),PAGE=20,CONCURRENCY=4; // Separate DO from game collector, differential, orphan and provenance audits.
const MAX_BYTES=750_000,MAX_STATE_BYTES=3_000_000,DAY=86400000,TTL=30*DAY;
const RUN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}\.json$/;
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const json=(v,status=200)=>Response.json(v,{status,headers:HEADERS});
const key=run=>ROOT+"runs/"+run+"/material-audit/v1/progress.json";
const prefix=run=>ROOT+"runs/"+run+"/objects/";
const date=x=>x instanceof Date?x.getTime():
  typeof x==="string"?Date.parse(x):NaN;
const fresh=(x,now)=>{const t=date(x);return Number.isFinite(t)&&t>0&&
  t<=now+300000&&now-t<TTL;};
const sha256=async x=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(x)))]
  .map(n=>n.toString(16).padStart(2,"0")).join("");
const validBucket=e=>e?.CAPTAIN_BUCKET?.get&&e.CAPTAIN_BUCKET?.list&&
  e.CAPTAIN_BUCKET?.put&&e?.ROSTER_BATCH_LOCK?.get&&
  e.ROSTER_BATCH_LOCK?.idFromName?e.CAPTAIN_BUCKET:null;
async function read(b,k,limit=MAX_STATE_BYTES){
  const o=await b.get(k);
  if(!o)return null;
  if(!Number.isFinite(o.size)||o.size>limit)throw Error("oversized-metadata");
  const value=await o.text();
  if(new TextEncoder().encode(value).byteLength>limit)throw Error("oversized-metadata");
  return JSON.parse(value);
}
const write=(b,k,s)=>b.put(k,JSON.stringify(s),{
  httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
async function lease(env,holder,action){
  const binding=env.ROSTER_BATCH_LOCK;
  const response=await binding.get(binding.idFromName(LOCK)).fetch(
    new Request("https://game-material-audit.internal/",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fingerprint:LOCK,holder,action})}));
  return response.ok&&(await response.json()).status===
    (action==="acquire"?"acquired":"released");
}
const iso=now=>new Date(now).toISOString();
function initial(run,now){
  return {version:2,runId:run,status:"running",cursor:null,
    startedAt:iso(now),updatedAt:iso(now),finishedAt:null,
    expiresAt:iso(now+TTL),stats:{
      listed:0,examined:0,matched:0,tooLarge:0,expired:0,
      unavailable:0,invalid:0,noMaterialId:0,pages:0
    },items:{}};
}
const expired=(s,now)=>Number.isFinite(date(s?.expiresAt))&&
  date(s.expiresAt)<=now;
function publicReport(s,now){
  if(!s)return {status:"not-started",
    note:"Lancer une fois l'audit pour qu'il continue via le Cron, même page fermée."};
  if(expired(s,now))return {status:"expired",runId:s.runId,
    note:"Rapport arrivé à expiration : aucune donnée archivée n'est exposée."};
  if(s.version!==2)return {status:"upgrade-required",runId:s.runId,
    legacyStatus:s.status,legacyListed:s.stats?.listed||0,
    note:"Ancien audit d'identifiants sans icônes. "+
      "La nouvelle extraction exige une analyse complète et un redémarrage explicite."};
  return {kind:"LoSP-MSF-R2-ability-materials-audit",version:2,
    runId:s.runId,status:s.status,startedAt:s.startedAt,
    updatedAt:s.updatedAt,finishedAt:s.finishedAt,expiresAt:s.expiresAt,
    source:"private-R2-original-game-archive",
    provenance:"blob-sha256-verified-original-endpoint-unproven",
    stats:s.stats,distinctIds:Object.keys(s.items).length,
    materials:Object.entries(s.items).map(([id,value])=>{
      // Prefer a directly observed official icon to a sparse earlier
      // reference; keep every conflicting source variant in the report.
      const variants=[...(value.metadata||[])].sort((a,b)=>
        Number(Boolean(b.icon))-Number(Boolean(a.icon))||
        Number(Boolean(b.name))-Number(Boolean(a.name))||
        Number(Boolean(b.description))-Number(Boolean(a.description))||
        b.fileCount-a.fileCount);
      const best=variants[0]||null;
      return {id,fileCount:value.fileCount,
        sampleSha256:value.sampleSha256,sampleUploadedAt:value.sampleUploadedAt,
        category:value.category,characterId:value.characterId,
        abilityType:value.abilityType,name:best?.name||null,
        description:best?.description||null,icon:best?.icon||null,
        metadataStatus:variants.length?"observed-item-fields":"id-reference-only",
        metadataEvidenceCount:variants.reduce((n,x)=>n+x.fileCount,0),
        metadataVariants:variants};
    }).sort((a,b)=>a.id.localeCompare(b.id)),
    coverage:{
      originalObjects:true,differentialObjects:false,rawUnindexed:false,
      maxObjectBytes:MAX_BYTES,maxSourceAgeDays:30,
      note:"Each ID is found in a hash-verified official game JSON blob. "+
        "An ID reference does not certify an individual /items/{id} endpoint. "+
        "Files omitted for size, expiry or integrity prevent global completeness."
    }};
}
export async function handleGameMaterialAudit(request,env,now=Date.now()){
  if(!["GET","POST"].includes(request.method))return json({error:"method-not-allowed"},405);
  if(new URL(request.url).search)return json({error:"unsupported-query"},400);
  const b=validBucket(env);
  if(!b)return json({error:"storage-unavailable"},503);
  try{
    const active=await read(b,ACTIVE,4096);
    if(!RUN.test(active?.runId||""))return json({error:"no-active-run"},404);
    const progressKey=key(active.runId);
    const previous=await read(b,progressKey);
    if(request.method==="GET")return json(publicReport(previous,now));
    const url=new URL(request.url);
    if(url.origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
       !/^application\/json\b/i.test(request.headers.get("Content-Type")||""))
      return json({error:"forbidden"},403);
    const raw=await request.text();
    if(raw.length>80)return json({error:"invalid-action"},400);
    const action=JSON.parse(raw)?.action;
    if(!["start","restart"].includes(action))
      return json({error:"invalid-action"},400);
    if(action==="start"&&previous&&!expired(previous,now)&&
       !(previous.version===1&&(previous.stats?.listed||0)===0))
      return json(publicReport(previous,now));
    if(action==="restart"&&previous?.version===2&&
       previous.status==="running"&&!expired(previous,now))
      return json({error:"audit-running"},409);
    // No implicit restart. A deliberate restart is allowed only on completion
    // or after expiry; source bytes and receipts are never touched.
    if(action==="restart"&&previous?.version===2&&
       previous.status!=="snapshot-complete"&&!expired(previous,now))
      return json({error:"not-completed"},409);
    const holder=crypto.randomUUID();
    if(!await lease(env,holder,"acquire"))return json({error:"audit-busy"},409);
    try{
      const current=await read(b,progressKey);
      if(action==="start"&&current&&!expired(current,now)&&
         !(current.version===1&&(current.stats?.listed||0)===0))
        return json(publicReport(current,now));
      if(action==="restart"&&current?.version===2&&
         current.status==="running"&&!expired(current,now))
        return json({error:"audit-running"},409);
      const s=initial(active.runId,now);
      await write(b,progressKey,s);
      return json(publicReport(s,now));
    }finally{await lease(env,holder,"release");}
  }catch{return json({error:"material-audit-unavailable"},503);}
}
// Trust only exact item fields returned by the archived JSON, never construct
// an icon URL from an ID. Do not infer an upgrade from a story reward alone.
const MATERIAL=/^ABILITY_MATERIAL_[A-Z0-9_]{1,80}$/i;
const UNIQUE=/^ABILITY_MATERIAL_UNIQUE_ABILITY_MAT_(.+)_(BASIC|SPECIAL|ULTIMATE|PASSIVE)$/;
const CDN=/^https:\/\/assets\.marvelstrikeforce\.com\/(?:imgs|key_art)\/[A-Za-z0-9_./%-]{1,240}\.(?:png|webp|jpg|jpeg)$/i;
const clean=(v,max)=>typeof v==="string"&&v.length>0&&v.length<=max&&
  !/[\u0000-\u001f\u007f]/.test(v)?v:null;
function classification(id){
  const unique=UNIQUE.exec(id);
  if(unique)return {category:"awakened-unique-material",
    characterId:unique[1],abilityType:unique[2]};
  return {category:"ordinary-material",characterId:null,abilityType:null};
}
const signature=m=>JSON.stringify([m.name,m.description,m.icon]);
export function collectMaterials(payload){
  const ids=new Set(),metadata=new Map(),stack=[payload];
  while(stack.length){
    const value=stack.pop();
    if(typeof value==="string"){
      if(MATERIAL.test(value))ids.add(value.toUpperCase());
      continue;
    }
    if(!value||typeof value!=="object")continue;
    if(!Array.isArray(value)&&typeof value.id==="string"&&
       MATERIAL.test(value.id)){
      const id=value.id.toUpperCase();
      ids.add(id);
      // A real material item has an exact ID and optional name, description,
      // icon. Validate each field and preserve conflicting observed variants.
      const m={name:clean(value.name,220),
        description:clean(value.description,900),
        icon:typeof value.icon==="string"&&CDN.test(value.icon)?value.icon:null};
      if(m.name||m.description||m.icon){
        if(!metadata.has(id))metadata.set(id,new Map());
        metadata.get(id).set(signature(m),m);
      }
    }
    for(const entry of Object.values(value))stack.push(entry);
  }
  return {ids:[...ids],metadata:Object.fromEntries(
    [...metadata].map(([id,variants])=>[id,[...variants.values()]]))};
}

async function inspect(b,entry,root,now){
  const name=entry.key.slice(root.length);
  if(!HASH.test(name))return {status:"invalid"};
  if(!Number.isFinite(entry.size)||entry.size>MAX_BYTES)
    return {status:"tooLarge"};
  if(!fresh(entry.uploaded,now))return {status:"expired"};
  // A transient R2 transport error throws: the checkpoint will NOT advance.
  const obj=await b.get(entry.key);
  if(!obj)return {status:"unavailable"};
  if(!Number.isFinite(obj.size)||obj.size>MAX_BYTES)
    return {status:"tooLarge"};
  const uploaded=obj.uploaded??entry.uploaded;
  if(!fresh(uploaded,now))return {status:"expired"};
  const raw=await obj.text();
  if(new TextEncoder().encode(raw).byteLength!==obj.size)
    return {status:"invalid"};
  if(!raw.toLowerCase().includes("ability_material_"))
    return {status:"examined"};
  const sha=name.slice(0,-5);
  if(await sha256(raw)!==sha)return {status:"invalid"};
  let payload;
  try{payload=JSON.parse(raw);}
  catch{return {status:"invalid"};}
  if(!payload||typeof payload!=="object"||Array.isArray(payload)||
    !Object.hasOwn(payload,"data"))return {status:"invalid"};
  const found=collectMaterials(payload);
  return {status:"matched",ids:found.ids,metadata:found.metadata,
    sha,uploadedAt:iso(date(uploaded)),
    expiresAt:date(uploaded)+TTL};
}
export async function runGameMaterialAuditTick(env,now=Date.now()){
  const b=validBucket(env);
  if(!b)return {status:"storage-unavailable"};
  const holder=crypto.randomUUID();
  let acquired=false;
  try{
    acquired=await lease(env,holder,"acquire");
    if(!acquired)return {status:"busy"};
    const active=await read(b,ACTIVE,4096);
    if(!RUN.test(active?.runId||""))return {status:"not-started"};
    const progressKey=key(active.runId),s=await read(b,progressKey);
    if(!s||s.runId!==active.runId)return {status:"not-started"};
    if(s.version!==2)return {status:"upgrade-required"};
    if(expired(s,now)){
      // Physically remove only this generated report at the source TTL.
      // Never delete original blobs, receipts, other audits or credentials.
      if(b.delete)await b.delete(progressKey);
      return {status:"expired"};
    }
    if(s.status!=="running")return {status:s.status};
    const root=prefix(s.runId);
    const listing=await b.list({prefix:root,limit:PAGE,
      ...(s.cursor?{cursor:s.cursor}:{})});
    if(!Array.isArray(listing?.objects)||listing.objects.length>PAGE||
       listing.objects.some(x=>typeof x?.key!=="string"||!x.key.startsWith(root))||
       listing.truncated&&(!listing.cursor||listing.cursor===s.cursor))
      return {status:"invalid-page"};
    const entries=listing.objects,results=new Array(entries.length);
    let next=0;
    await Promise.all(Array.from({length:Math.min(CONCURRENCY,entries.length)},
      async()=>{
        while(next<entries.length){
          const index=next++;
          results[index]=await inspect(b,entries[index],root,now);
        }
      }));
    for(const result of results){
      s.stats.listed++;
      if(result.status==="matched"){
        s.stats.examined++;s.stats.matched++;
        if(!result.ids.length)s.stats.noMaterialId++;
        for(const id of result.ids){
          const existing=s.items[id];
          if(existing)existing.fileCount++;
          else s.items[id]={...classification(id),fileCount:1,
            sampleSha256:result.sha,sampleUploadedAt:result.uploadedAt,
            metadata:[]};
          const record=s.items[id];
          for(const observed of result.metadata[id]||[]){
            const previous=record.metadata.find(x=>
              signature(x)===signature(observed));
            if(previous)previous.fileCount++;
            else record.metadata.push({...observed,fileCount:1,
              sampleSha256:result.sha,sampleUploadedAt:result.uploadedAt});
          }
        }
        s.expiresAt=iso(Math.min(date(s.expiresAt),result.expiresAt));
      }else if(result.status==="examined")s.stats.examined++;
      else if(Object.hasOwn(s.stats,result.status))s.stats[result.status]++;
      else s.stats.invalid++;
    }
    s.stats.pages++;
    s.cursor=listing.truncated?listing.cursor:null;
    if(!listing.truncated){
      s.status="snapshot-complete";
      s.finishedAt=iso(now);
    }
    s.updatedAt=iso(now);
    await write(b,progressKey,s);
    return {status:s.status,listed:s.stats.listed,matched:s.stats.matched,
      distinctIds:Object.keys(s.items).length};
  }catch{return {status:"audit-unavailable"};}
  finally{if(acquired)try{await lease(env,holder,"release");}catch{}}
}
