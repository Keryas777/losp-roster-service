// Official MSF developer API: authorized GAME data only (never player paths).
// Bounded, resumable R2 archive; all responses are private and full JSON bytes.
// Scope: list roots and discoverable one-ID details; NOT combinatorial shortcuts.
import {API_KEY} from "./player-card.js";
import {discoverGamePhase2,phase2RootTasks} from "./game-phase2-discovery.js";
import {characterRecoveryTasks,splitFailedAbilities,isItemCharacterAssociation} from "./game-archive-recovery.js";
export const GAME_ARCHIVE_CRON="* * * * *";
export const GAME_ARCHIVE_ROOT="game-archive/v1/";
// Internal emergency circuit-breaker, NOT a provider quota. Six GET/minute
// permits at most 8,640 automated GET/day; 9,000 leaves room for admin ticks.
// It must not prevent one complete initial scan solely through mis-sizing.
export const GAME_ARCHIVE_DAILY_LIMIT=9000;
export const GAME_ARCHIVE_TICK_LIMIT=6;
const API="https://api.marvelstrikeforce.com",TOKEN_URL=
  "https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
// A memory buffer threshold, not a size limit: larger payloads are streamed
// to R2 intact. Long task queues are likewise spilled to R2 in batches.
const LOCK_ID="e".repeat(64),BUFFER_BYTES=8_000_000,ACTIVE_TASK_WINDOW=600,QUEUE_CHUNK_SIZE=500;
const ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const dailyKey=date=>GAME_ARCHIVE_ROOT+"budget/"+date+".json";
const runKey=id=>GAME_ARCHIVE_ROOT+"runs/"+id+"/progress.json";
const queueKey=(id,chunk)=>GAME_ARCHIVE_ROOT+"runs/"+id+"/queue/"+String(chunk).padStart(8,"0")+".json";
const seenKey=(id,shard)=>GAME_ARCHIVE_ROOT+"runs/"+id+"/phase2-seen/"+shard+".json";
const receiptPrefix=id=>GAME_ARCHIVE_ROOT+"runs/"+id+"/receipts/";
// 16 small, exact-match R2 shards: no Bloom false positives or huge state JSON.
function seenShard(path){
  let h=2166136261;
  for(let i=0;i<path.length;i++)h=Math.imul(h^path.charCodeAt(i),16777619);
  return (h>>>0)%16;
}
async function enqueuePhase2(bucket,state,candidates){
  const buckets=new Map();
  for(const task of candidates){
    if(typeof task.path!=="string"||!task.path.startsWith("/game/v1/"))continue;
    const shard=seenShard(task.path);
    if(!buckets.has(shard))buckets.set(shard,[]);
    buckets.get(shard).push(task);
  }
  for(const [shard,group] of buckets){
    const key=seenKey(state.runId,shard);
    const known=new Set(await read(bucket,key)||[]);
    const fresh=group.filter(task=>!known.has(task.path));
    if(!fresh.length)continue;
    // Commit queue/progress BEFORE marking paths as known. Failure can cause
    // an extra task but never lose an unfetched resource.
    await enqueueDetails(bucket,state,fresh);
    await write(bucket,runKey(state.runId),state);
    for(const task of fresh)known.add(task.path);
    await write(bucket,key,[...known]);
    state.phase2.discovered=(state.phase2.discovered||0)+fresh.length;
  }
}
async function scanPhase2Receipts(bucket,state){
  const p=state.phase2,runId=state.runId;
  if(!bucket.list){state.lastOutcome="phase2-r2-list-unavailable";return;}
  const prefix=receiptPrefix(runId);
  let steps=0;
  while(steps<6){
    if(p.pos>=(p.keys||[]).length){
      if(p.end){
        p.status="running";
        await enqueuePhase2(bucket,state,phase2RootTasks());
        state.lastOutcome="phase2-discovery-ready";
        return;
      }
      const listing=await bucket.list({prefix,limit:30,
        ...(p.cursor?{cursor:p.cursor}:{})});
      p.keys=(listing.objects||[]).map(entry=>entry.key);
      p.pos=0;p.nextCursor=listing.truncated?listing.cursor:null;
      p.end=!listing.truncated;
      if(!p.keys.length){
        if(p.end)continue;
        state.lastOutcome="phase2-empty-r2-page";return;
      }
    }
    const key=p.keys[p.pos];
    const receipt=await read(bucket,key);
    if(receipt?.status===200&&typeof receipt.objectKey==="string"&&
        receipt.objectKey.startsWith(GAME_ARCHIVE_ROOT+"runs/"+runId+"/objects/")){
      const source=await read(bucket,receipt.objectKey);
      if(source?.data!==undefined)
        await enqueuePhase2(bucket,state,
          discoverGamePhase2(receipt.path||"",source));
    }
    p.pos++;p.scanned=(p.scanned||0)+1;steps++;
    if(p.pos===p.keys.length){
      p.keys=[];p.pos=0;p.cursor=p.nextCursor;p.nextCursor=null;
    }
  }
  state.lastOutcome="phase2-scanning-receipts";
}

const safeHeaders={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex"};
const response=(x,code=200)=>Response.json(x,{status:code,headers:safeHeaders});
// These finite IDs are taken from Scopely OpenAPI beta 0.2.1 schemas,
// never inferred from unrelated keys or generated as parameter combinations.
const OBJECT_DETAIL_IDS=Object.freeze({
  "upgradeData":["playerLevelTotalXp","allianceLevelTotalXp",
    "characterLevelTotalXp","characterXpCosts","yellowStarTotalShards",
    "yellowStarTotalCosts","abilityLevelRequirements","abilityUpgradeCosts",
    "iso8MatrixLevelRequirements","iso8MatrixUpgradeCosts",
    "iso8AbilityUpgradeCosts","iso8FuseCosts"],
  "iso8Abilities":["striker","fortifier","healer","skirmisher","raider"],
  "analysis/teamOrder":["roster","blitz","tower","raids","arena","war","crucible"]
});
const roots=Object.freeze([
  ["languages",null],["localizations","localizations/{id}"],
  ["decorations",null],["upgradeData","upgradeData/{id}"],
  ["iso8Abilities","iso8Abilities/{id}"],
  ["analysis/teamOrder","analysis/teamOrder/{id}"],
  ["traits",null],["characters","characters/{id}"],
  ["characterInstances","characterInstances/{id}"],
  ["characterInstanceCaps",null],["dds","dds/{id}"],
  ["raidGroups",null],["raids","raids/{id}"],
  ["pickYourPoisons","pickYourPoisons/{id}"],
  ["survivalTowers","survivalTowers/{id}"],
  ["events","events/{id}"],["scopes",null]
]);
// OpenAPI beta 0.2.1: these GETs do not declare page/perPage parameters.
const NON_PAGINATED_ROOTS=new Set([
  "decorations","upgradeData","iso8Abilities","analysis/teamOrder"
]);
export const GAME_ROOTS=roots.map(([id,detail])=>Object.freeze({
  id,path:"/game/v1/"+id,detail:detail?"/game/v1/"+detail:null,
  pageable:!NON_PAGINATED_ROOTS.has(id),
  objectKeys:OBJECT_DETAIL_IDS[id]||null
}));
const read=async(b,key)=>{const item=await b.get(key);return item?JSON.parse(await item.text()):null;};
const write=(b,key,value)=>b.put(key,JSON.stringify(value),{
  httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}});
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
const safeId=id=>{
  if(typeof id!=="string"&&typeof id!=="number")return null;
  const v=String(id);return /^[A-Za-z0-9:_-]{1,200}$/.test(v)?v:null;
};
const dateOf=now=>new Date(now).toISOString().slice(0,10);
async function withLock(env,action,holder){
  const b=env.ROSTER_BATCH_LOCK;
  const stub=b.get(b.idFromName(LOCK_ID));
  const result=await stub.fetch(new Request("https://roster-lock.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,holder,fingerprint:LOCK_ID})
  }));
  return result.ok&&(await result.json()).status===(action==="acquire"?"acquired":"released");
}
// Best-effort isolate-local reuse: never store app OAuth tokens in R2 or logs.
// Workers may start a fresh isolate at any time, so reauthentication remains safe.
const appTokenCache=new WeakMap();
async function appToken(env,fetchImpl,now=Date.now()){
  if(!env.SCOPELY_CLIENT_ID||!env.SCOPELY_CLIENT_SECRET)return null;
  const cached=appTokenCache.get(env);
  if(cached?.clientId===env.SCOPELY_CLIENT_ID&&cached.expiresAt>now+60_000)
    return cached.token;
  const pair=new TextEncoder().encode(env.SCOPELY_CLIENT_ID+":"+env.SCOPELY_CLIENT_SECRET);
  const res=await fetchImpl(TOKEN_URL,{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(12000),
    headers:{Authorization:"Basic "+btoa(String.fromCharCode(...pair)),
      "Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
    body:"grant_type=client_credentials"
  });
  if(!res.ok)return null;
  const data=await res.json();
  if(typeof data?.access_token!=="string"||!data.access_token.length||
     String(data?.token_type).toLowerCase()!=="bearer")return null;
  // Unknown expiry => valid for this tick only, do not assume session length.
  if(Number.isSafeInteger(data.expires_in)&&data.expires_in>=120)
    appTokenCache.set(env,{clientId:env.SCOPELY_CLIENT_ID,
      token:data.access_token,expiresAt:now+data.expires_in*1000});
  return data.access_token;
}
async function readGameBody(res,bucket,runId){
  if(!res.body)return {status:"invalid-body"};
  const reader=res.body.getReader(),chunks=[];
  let size=0,done=false;
  try{
    while(size<=BUFFER_BYTES){
      const part=await reader.read();
      if(part.done){done=true;break;}
      chunks.push(part.value);size+=part.value.byteLength;
    }
  }catch{return {status:"read-error"};}
  if(!done){
    // Multipart R2 accepts streams with unknown Content-Length and keeps
    // Worker memory bounded. A generic ReadableStream cannot be passed to
    // R2.put without a known length in the production runtime.
    const objectKey=GAME_ARCHIVE_ROOT+"runs/"+runId+"/raw/"+crypto.randomUUID()+".json";
    const upload=await bucket.createMultipartUpload(objectKey,{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    const PART=6*1024*1024,parts=[];
    let buffer=new Uint8Array(PART),filled=0,number=1;
    async function addChunk(chunk){
      let offset=0;
      while(offset<chunk.byteLength){
        const take=Math.min(PART-filled,chunk.byteLength-offset);
        buffer.set(chunk.subarray(offset,offset+take),filled);
        filled+=take;offset+=take;
        if(filled===PART){
          parts.push(await upload.uploadPart(number++,buffer));
          buffer=new Uint8Array(PART);filled=0;
        }
      }
    }
    try{
      for(const chunk of chunks)await addChunk(chunk);
      for(;;){
        const part=await reader.read();
        if(part.done)break;
        size+=part.value.byteLength;
        await addChunk(part.value);
      }
      if(filled)parts.push(await upload.uploadPart(number++,buffer.subarray(0,filled)));
      await upload.complete(parts);
    }catch(error){
      await upload.abort().catch(()=>{});
      throw error;
    }
    return {status:"archived-unindexed",objectKey,byteCount:size};
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let data;
  try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{return {status:"invalid-json",bytes};}
  if(!data||typeof data!=="object"||Array.isArray(data)||
      data.data===undefined)return {status:"invalid-shape",bytes};
  return {status:"ok",bytes,data};
}
function resetList(task){
  task.page=1;task.series=(task.series||0)+1;
  task.seenCount=0;task.expectedTotal=null;
  task.discovered=[];task.missingIds=0;
  task.lastPageHash=null;task.seenIds=[];
  delete task.phase2Discovered;
}
function deferRetry(state,task,reason,now,restartList=false){
  task.retries=(task.retries||0)+1;
  if(task.retries>=16){
    // Never lose track of an unavailable resource and never stall the
    // other routes forever. Recovery of gaps is a separate follow-up pass.
    state.gaps.push({path:task.path,reason:"retry-exhausted",
      outcome:reason,attempts:task.retries});
    state.cursor++;state.pauseUntil=null;
    state.lastOutcome="retry-exhausted-gap";
    return;
  }
  const delay=Math.min(60,2**Math.min(task.retries-1,6))*60_000;
  state.lastOutcome=reason;
  state.pauseUntil=new Date(now+delay).toISOString();
  if(restartList&&task.mode==="list")resetList(task);
}
const currentDone=state=>(state.completedOffset||0)+state.cursor;
const currentTotal=state=>(state.completedOffset||0)+state.tasks.length+
  (state.pendingTasks||0);
async function enqueueDetails(bucket,state,items){
  // Preserve the existing inline queue for small campaigns (including
  // campaigns begun before this change). Spill additional tasks to R2.
  const paths=new Set(state.tasks.map(x=>x.path));
  const fresh=items.filter(item=>{
    if(paths.has(item.path))return false;
    paths.add(item.path);return true;
  });
  if(!fresh.length)return;
  if(!(state.pendingTasks>0)){
    const inline=Math.max(0,ACTIVE_TASK_WINDOW-state.tasks.length);
    state.tasks.push(...fresh.splice(0,inline));
  }
  for(let i=0;i<fresh.length;i+=QUEUE_CHUNK_SIZE){
    const batch=fresh.slice(i,i+QUEUE_CHUNK_SIZE);
    const index=state.spillWrite||0;
    // Persist chunks before updating progress. A failed progress write can
    // safely repeat/overwrite the same numbered chunk at the next tick.
    await write(bucket,queueKey(state.runId,index),batch);
    state.spillWrite=index+1;
    state.pendingTasks=(state.pendingTasks||0)+batch.length;
  }
}
async function loadNextQueue(bucket,state){
  if(state.cursor<state.tasks.length||!(state.pendingTasks>0))return;
  const chunk=await read(bucket,queueKey(state.runId,state.spillRead||0));
  if(!Array.isArray(chunk)||!chunk.length||
      !chunk.every(item=>typeof item?.path==="string"&&
        item.path.startsWith("/game/v1/")))throw Error("missing-queue-chunk");
  state.completedOffset=(state.completedOffset||0)+state.tasks.length;
  state.cursor=0;state.tasks=chunk;
  state.spillRead=(state.spillRead||0)+1;
  state.pendingTasks-=chunk.length;
  await write(bucket,runKey(state.runId),state);
}
// Scan the original, append-only R2 gap log in small steps while preserving
// normal collector throughput. This also backfills failures from older Workers.
async function scanRecoveryGaps(bucket,state){
  const recovery=state.recovery;
  let scanned=0;
  while(recovery.gapCursor<state.gaps.length&&scanned<8){
    const gap=state.gaps[recovery.gapCursor],source=gap?.path;
    if(gap?.status===472&&typeof source==="string"){
      const variants=characterRecoveryTasks(source);
      if(variants.length&&!recovery.records[source]){
        // Store the recovery bookkeeping in progress.json and create the
        // tasks using the EXISTING durable R2 queue.
        await enqueueDetails(bucket,state,variants);
        recovery.records[source]={
          expected:variants.map(x=>x.path),archived:[],failed:[]
        };
        recovery.scheduled+=variants.length;
      }
    }
    recovery.gapCursor++;scanned++;
  }
}
// Existing gaps are never removed. A follow-up part is recorded only after
// its original bytes and receipt have been durably persisted to R2.
function recordRecovery(state,task,path,ok){
  if(!task?.recoveryOf||!state.recovery)return;
  const record=state.recovery.records[task.recoveryOf];
  if(!record)return;
  const field=ok?"archived":"failed";
  if(!record[field].includes(path))record[field].push(path);
}
function registerAbilityParts(state,task,variants){
  const record=state.recovery?.records?.[task?.recoveryOf];
  if(!record)return;
  const seen=new Set(record.expected);
  for(const part of variants)
    if(!seen.has(part.path)){record.expected.push(part.path);seen.add(part.path);}
  state.recovery.scheduled+=variants.length;
}
function initial(){
  return {version:1,runId:crypto.randomUUID(),status:"running",
    startedAt:new Date().toISOString(),cursor:0,gaps:[],count:0,
    tasks:GAME_ROOTS.map(x=>({path:x.path,root:x.id,
      page:1,perPage:100,mode:"list"})),pauseUntil:null,lastOutcome:null};
}
export async function gameArchiveStatus(env,now=Date.now()){
  if(!env?.CAPTAIN_BUCKET?.get)return {status:"storage-unavailable"};
  const active=await read(env.CAPTAIN_BUCKET,ACTIVE);
  const state=active?.runId?await read(env.CAPTAIN_BUCKET,runKey(active.runId)):null;
  const budget=await read(env.CAPTAIN_BUCKET,dailyKey(dateOf(now)));
  return {status:state?.status||"not-started",autoEnabled:env.GAME_ARCHIVE_AUTO_ENABLED==="true",
    roots:GAME_ROOTS.length,cursor:state?currentDone(state):0,
    totalTasks:state?currentTotal(state):GAME_ROOTS.length,
    archivedResponses:state?.count||0,gapCount:state?.gaps?.length||0,
    // Admin-only, game-data URI (never player identifiers or OAuth tokens).
    currentResource:state?.tasks?.[state.cursor]?.path||null,
    phase2:state?.phase2?{status:state.phase2.status,
      scannedReceipts:state.phase2.scanned||0,discovered:state.phase2.discovered||0}:null,
    recovery:state?.recovery?{
      scannedGaps:state.recovery.gapCursor,
      scheduledParts:state.recovery.scheduled,
      affectedCharacters:Object.keys(state.recovery.records).length
    }:null,
    lastOutcome:state?.lastOutcome||null,requestsToday:budget?.used||0,
    dailyLimit:GAME_ARCHIVE_DAILY_LIMIT,pauseUntil:state?.pauseUntil||null};
}
// Admin explicitly starts a NEW immutable run. Existing private archives remain.
export async function startGameArchive(env,now=Date.now()){
  if(env?.GAME_ARCHIVE_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(!env?.CAPTAIN_BUCKET?.put||!env?.ROSTER_BATCH_LOCK?.get)return {status:"storage-unavailable"};
  const holder=crypto.randomUUID();
  if(!await withLock(env,"acquire",holder))return {status:"busy"};
  try{
    const current=await read(env.CAPTAIN_BUCKET,ACTIVE);
    if(current?.runId){
      const old=await read(env.CAPTAIN_BUCKET,runKey(current.runId));
      if(old?.status==="running")return {status:"already-running"};
    }
    const state=initial();
    state.startedAt=new Date(now).toISOString();
    await write(env.CAPTAIN_BUCKET,runKey(state.runId),state);
    await write(env.CAPTAIN_BUCKET,ACTIVE,{version:1,runId:state.runId});
    return {status:"started",roots:GAME_ROOTS.length};
  }finally{await withLock(env,"release",holder).catch(()=>{});}
}
export async function runGameArchiveTick(env,fetchImpl=fetch,now=Date.now()){
  if(env?.GAME_ARCHIVE_AUTO_ENABLED!=="true")return {status:"disabled"};
  if(!env?.CAPTAIN_BUCKET?.get||!env?.ROSTER_BATCH_LOCK?.get)
    return {status:"storage-unavailable"};
  const holder=crypto.randomUUID();
  if(!await withLock(env,"acquire",holder))return {status:"busy"};
  try{
    const bucket=env.CAPTAIN_BUCKET,active=await read(bucket,ACTIVE);
    if(!active?.runId)return {status:"not-started"};
    const key=runKey(active.runId),state=await read(bucket,key);
    if(!state||state.version!==1||state.runId!==active.runId||
       !Array.isArray(state.tasks)||!Array.isArray(state.gaps)||
       !Number.isSafeInteger(state.cursor))return {status:"invalid-state"};
    // A campaign blocked by the previous arbitrary limits or transient
    // errors must resume in place, without discarding the existing R2 run.
    if(state.status==="blocked"){
      state.status="running";state.pauseUntil=null;
      await write(bucket,key,state);
    }
    // Phase 2 is opt-in and reuses the SAME immutable run. On an older
    // completed archive, revisit receipts first, then discover linked GETs.
    if(["completed","completed-with-gaps"].includes(state.status)&&
       env.GAME_ARCHIVE_PHASE2_ENABLED==="true"&&!state.phase2){
      state.phase2={version:1,status:"scanning",keys:[],pos:0,
        cursor:null,nextCursor:null,end:false,scanned:0,discovered:0};
      state.status="running";
      await write(bucket,key,state);
    }
    // Recovery can be activated on a completed older run without allocating
    // a new run ID or disturbing the phase-two receipt scanner.
    if(env.GAME_ARCHIVE_RECOVERY_ENABLED==="true"&&!state.recovery){
      state.recovery={version:1,gapCursor:0,scheduled:0,records:{}};
      if(["completed","completed-with-gaps"].includes(state.status))
        state.status="running";
      await write(bucket,key,state);
    }
    if(state.status!=="running")return {status:state.status};
    if(state.phase2?.status==="scanning"){
      try{await scanPhase2Receipts(bucket,state);}
      catch{state.lastOutcome="phase2-scan-retry";}
      await write(bucket,key,state);
      return {status:state.phase2.status==="scanning"?"phase2-scanning":"running",
        scannedReceipts:state.phase2.scanned||0,
        discovered:state.phase2.discovered||0,
        completedTasks:currentDone(state),totalTasks:currentTotal(state),
        lastOutcome:state.lastOutcome};
    }
    if(state.pauseUntil&&Date.parse(state.pauseUntil)>now)
      return {status:"cooldown",pauseUntil:state.pauseUntil};
    if(state.recovery){
      await scanRecoveryGaps(bucket,state);
      await write(bucket,key,state);
    }
    const day=dateOf(now),budgetKey=dailyKey(day);
    const budget=await read(bucket,budgetKey)||{date:day,used:0};
    if(budget.date!==day||!Number.isSafeInteger(budget.used)||
       budget.used<0||budget.used>GAME_ARCHIVE_DAILY_LIMIT)
      return {status:"invalid-budget"};
    if(budget.used>=GAME_ARCHIVE_DAILY_LIMIT)return {status:"daily-limit"};
    let token;
    try{token=await appToken(env,fetchImpl,now);}
    catch{token=null;}
    if(!token){
      state.lastOutcome="app-oauth-unavailable";
      state.pauseUntil=new Date(now+60*60_000).toISOString();
      await write(bucket,key,state);
      return {status:"app-oauth-unavailable"};
    }
    let calls=0;
    while(calls<GAME_ARCHIVE_TICK_LIMIT&&budget.used<GAME_ARCHIVE_DAILY_LIMIT){
      await loadNextQueue(bucket,state);
      if(state.cursor>=state.tasks.length)break;
      const task=state.tasks[state.cursor];
      if(typeof task?.path!=="string"||!task.path.startsWith("/game/v1/"))
        return {status:"invalid-task"};
      const root=GAME_ROOTS.find(x=>x.id===task.root);
      // Older R2 runs called all 17 roots "list"; their persisted mode
      // must not force unsupported page/perPage query parameters.
      const pageable=task.mode==="list"&&root?.pageable!==false;
      const qs=pageable?(task.path.includes("?")?"&":"?")+
        "page="+task.page+"&perPage="+task.perPage:"";
      const path=task.path+qs;
      // Reserve the budget *before* the upstream GET. Token POST isn't a game GET.
      budget.used++;calls++;await write(bucket,budgetKey,budget);
      let upstream,parsed;
      try{
        upstream=await fetchImpl(API+path,{
          method:"GET",redirect:"manual",cache:"no-store",
          signal:AbortSignal.timeout(15000),
          headers:{"x-api-key":API_KEY,"User-Agent":"APIClient/1.0 (Server)",
            Authorization:"Bearer "+token,Accept:"application/json"}
        });
        if(upstream.status===200)parsed=await readGameBody(upstream,bucket,state.runId);
      }catch{upstream=null;}
      if(parsed?.status==="archived-unindexed"){
        const receipt=GAME_ARCHIVE_ROOT+"runs/"+state.runId+
          "/receipts/unindexed-"+crypto.randomUUID()+".json";
        await write(bucket,receipt,{version:1,path,status:200,sha256:null,
          objectKey:parsed.objectKey,bytes:parsed.byteCount,
          indexed:false,capturedAt:new Date(now).toISOString()});
        state.count++;
        if(task.mode==="list"&&task.perPage>1){
          task.perPage=Math.max(1,Math.floor(task.perPage/2));
          resetList(task);
          state.lastOutcome="large-page-archived-retrying-smaller";
        }else{
          state.gaps.push({path,reason:"archived-but-unindexed",objectKey:parsed.objectKey});
          state.cursor++;state.lastOutcome="large-response-archived-unindexed";
        }
      }else if(upstream?.status===472){
        if(pageable&&task.perPage>1){
          task.perPage=Math.max(1,Math.floor(task.perPage/2));
          resetList(task);state.lastOutcome="reduced-page-size";
        }else{
          // Scopely documents finite detail routes for these unpageable
          // roots. Follow every documented ID, including on OLD R2 runs,
          // instead of losing upgrades/ISO8/team order when the root is 472.
          if(root?.objectKeys&&root.detail){
            await enqueueDetails(bucket,state,root.objectKeys.map(id=>({
              path:root.detail.replace("{id}",encodeURIComponent(id)),
              root:task.root,mode:"detail"
            })));
          }
          // If a split ability response is still 472, ask for the four
          // documented ability types separately. Never recurse further.
          if(task.recoveryPart==="abilities"){
            const variants=splitFailedAbilities(task);
            if(variants.length){
              await enqueueDetails(bucket,state,variants);
              registerAbilityParts(state,task,variants);
            }
          }
          if(task.recoveryOf)recordRecovery(state,task,task.path,false);
          state.gaps.push({path,status:472,reason:root?.objectKeys?
            "unpageable-root-detail-fallback":"provider-472-not-pageable"});
          state.cursor++;state.lastOutcome=root?.objectKeys?
            "root-472-fallback-details":"provider-472-gap";
        }
      }else if(upstream?.status===429){
        state.lastOutcome="rate-limited";
        state.pauseUntil=new Date(now+60*60_000).toISOString();
      }else if([403,404,422,464,474].includes(upstream?.status)){
        if(task.recoveryOf)recordRecovery(state,task,task.path,false);
        state.gaps.push({path:task.path,status:upstream.status,
          ...(upstream.status===404&&isItemCharacterAssociation(task.path)
            ?{reason:"item-association-unavailable"}:{})});
        state.cursor++;state.lastOutcome="detail-unavailable";
      }else if(!upstream||!upstream.ok||parsed?.status!=="ok"){
        // Never mark a retryable upstream failure as permanently blocked.
        const reason=upstream?"http-"+upstream.status+
          (parsed?.status?"-"+parsed.status:""):"network-error";
        deferRetry(state,task,reason,now);
      }else{
        task.retries=0;state.pauseUntil=null;
        const id=await sha(parsed.bytes);
        const archive=GAME_ARCHIVE_ROOT+"runs/"+state.runId+"/objects/"+id+".json";
        if(!await bucket.get(archive))
          await bucket.put(archive,parsed.bytes,{
            httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
          });
        const receipt=GAME_ARCHIVE_ROOT+"runs/"+state.runId+
          "/receipts/"+String(state.cursor).padStart(6,"0")+"-"+
          String(task.page||0).padStart(5,"0")+"-s"+(task.series||0)+".json";
        await write(bucket,receipt,{version:1,path,status:200,sha256:id,
          objectKey:archive,bytes:parsed.bytes.byteLength,
          capturedAt:new Date(now).toISOString(),
          asOf:parsed.data.meta?.asOf||null,
          ...(task.recoveryOf?{recoveryOf:task.recoveryOf,
            recoveryPart:task.recoveryPart}: {})});
        if(task.recoveryOf)recordRecovery(state,task,task.path,true);
        state.count++;
        let nextPage=false;
        if(pageable&&Array.isArray(parsed.data.data)){
          const entries=parsed.data.data,meta=parsed.data.meta||{};
          const total=Number.isSafeInteger(meta.perTotal)&&meta.perTotal>=0?
            meta.perTotal:null;
          // Cross-page identity tracking catches overlapping but nonidentical
          // pages (and duplicate IDs within one page), without losing raw JSON.
          const encountered=new Set(task.seenIds||[]),pageIds=[];
          let overlap=false;
          for(const entry of entries){
            const entryId=safeId(typeof entry==="string"?entry:entry?.id);
            if(!entryId)continue;
            if(encountered.has(entryId))overlap=true;
            encountered.add(entryId);pageIds.push(entryId);
          }
          if(task.page>1&&entries.length>0&&task.lastPageHash===id){
            deferRetry(state,task,"duplicate-page",now,true);
          }else if(overlap){
            deferRetry(state,task,"pagination-overlapping-ids",now,true);
          }else if(task.expectedTotal!==undefined&&task.expectedTotal!==null&&
             total!==null&&task.expectedTotal!==total){
            deferRetry(state,task,"pagination-total-changed",now,true);
          }else if(entries.length>task.perPage||
             (meta.page!==undefined&&meta.page!==task.page)||
             (total!==null&&((task.page-1)*task.perPage+entries.length)>total)){
            deferRetry(state,task,"pagination-inconsistent",now,true);
          }else{
            task.seenIds??=[];
            task.seenIds.push(...pageIds);
            task.expectedTotal=total??task.expectedTotal??null;
            task.seenCount=(task.seenCount||0)+entries.length;
            task.lastPageHash=id;
            if(task.expectedTotal!==null&&task.seenCount>task.expectedTotal){
              deferRetry(state,task,"pagination-overcount",now,true);
            }
            const root=GAME_ROOTS.find(x=>x.id===task.root);
            if(root?.detail){
              task.discovered??=[];
              const known=new Set(task.discovered);
              for(const entry of entries){
                const value=safeId(typeof entry==="string"?entry:entry?.id);
                if(value){
                  if(!known.has(value)){known.add(value);task.discovered.push(value);}
                }else task.missingIds=(task.missingIds||0)+1;
              }
            }
            nextPage=task.expectedTotal!==null?
              task.seenCount<task.expectedTotal:entries.length===task.perPage;
            if(nextPage&&entries.length===0){
              deferRetry(state,task,"pagination-no-progress",now,true);
            }
            if(!nextPage&&task.expectedTotal!==null&&
               task.seenCount!==task.expectedTotal){
              deferRetry(state,task,"pagination-incomplete",now,true);
            }
            // Only enqueue details AFTER every list page has been validated.
            // Thus 472 retries can't leave stale detail IDs from old page sizes.
            if(!state.pauseUntil&&!nextPage&&root?.detail){
              const details=task.discovered.map(id=>({
                path:root.detail.replace("{id}",encodeURIComponent(id)),
                root:task.root,mode:"detail"
              }));
              await enqueueDetails(bucket,state,details);
              if(task.missingIds)state.gaps.push({path:task.path,
                reason:"undiscoverable-detail-id",count:task.missingIds});
              delete task.discovered;delete task.missingIds;
            }
          }
        }
        // Some official roots return a keyed object, not an array.
        // Capture documented finite detail variants after storing the root.
        if(task.mode==="list"&&!Array.isArray(parsed.data.data)&&
           parsed.data.data&&typeof parsed.data.data==="object"){
          const root=GAME_ROOTS.find(x=>x.id===task.root);
          if(root?.objectKeys){
            const keys=Object.keys(parsed.data.data);
            if(keys.some(id=>!root.objectKeys.includes(id)))
              state.gaps.push({path:task.path,reason:"unrecognized-object-key"});
            // Always request the complete, finite set officially documented.
            // The summary may omit a field without proving it unavailable.
            await enqueueDetails(bucket,state,root.objectKeys.map(id=>({
              path:root.detail.replace("{id}",encodeURIComponent(id)),
              root:task.root,mode:"detail"
            })));
          }
        }
        if(!state.pauseUntil&&state.phase2?.status==="running"){
          const discovered=discoverGamePhase2(path,parsed.data);
          if(task.mode==="list"){
            task.phase2Discovered??=[];
            const paths=new Set(task.phase2Discovered.map(x=>x.path));
            for(const entry of discovered){
              if(!paths.has(entry.path)){
                paths.add(entry.path);task.phase2Discovered.push(entry);
              }
            }
            // A page must not yield permanent follow-ups until the complete
            // pagination series has passed the consistency checks.
            if(!nextPage){
              await enqueuePhase2(bucket,state,task.phase2Discovered);
              delete task.phase2Discovered;
            }
          }else await enqueuePhase2(bucket,state,discovered);
        }
        if(!state.pauseUntil){
          if(nextPage){
            task.page++; // keep current list task until all pages are stored
            state.lastOutcome="page-archived";
          }else{
            state.cursor++;
            state.lastOutcome="resource-archived";
          }
        }
      }
      await write(bucket,key,state);
      if(state.status!=="running"||state.pauseUntil&&Date.parse(state.pauseUntil)>now)break;
    }
    if(state.cursor===state.tasks.length&&!(state.pendingTasks>0)&&
       (!state.recovery||state.recovery.gapCursor>=state.gaps.length)&&
       state.status==="running"){
      if(state.phase2?.status==="running")state.phase2.status="done";
      state.status=state.gaps.length?"completed-with-gaps":"completed";
      state.lastOutcome=state.status;await write(bucket,key,state);
    }
    return {status:state.status,processed:calls,
      archivedResponses:state.count,completedTasks:currentDone(state),
      totalTasks:currentTotal(state),lastOutcome:state.lastOutcome,
      recovery:state.recovery?{scannedGaps:state.recovery.gapCursor,
        scheduledParts:state.recovery.scheduled}:null,
      requestsToday:budget.used};
  }catch{return {status:"unavailable"};}
  finally{await withLock(env,"release",holder).catch(()=>{});}
}
export async function handleGameArchiveAdmin(request,env,fetchImpl=fetch,now=Date.now()){
  if(request.method==="GET")return response(await gameArchiveStatus(env,now));
  if(request.method!=="POST")return response({status:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
    !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return response({status:"forbidden"},403);
  let action;
  try{
    const raw=await request.text();
    if(raw.length>80)throw Error("large");
    const data=JSON.parse(raw);
    if(!data||typeof data!=="object"||Array.isArray(data)||
      Object.keys(data).length!==1||!["start","tick"].includes(data.action))
      throw Error("invalid");
    action=data.action;
  }catch{return response({status:"invalid-payload"},400);}
  return response(action==="start"?await startGameArchive(env,now):
    await runGameArchiveTick(env,fetchImpl,now));
}
