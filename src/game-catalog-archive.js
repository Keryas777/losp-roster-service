// Official MSF developer API: authorized GAME data only (never player paths).
// Bounded, resumable R2 archive; all responses are private and full JSON bytes.
// Scope: list roots and discoverable one-ID details; NOT combinatorial shortcuts.
import {API_KEY} from "./player-card.js";
export const GAME_ARCHIVE_CRON="*/15 * * * *";
export const GAME_ARCHIVE_ROOT="game-archive/v1/";
export const GAME_ARCHIVE_DAILY_LIMIT=180;
export const GAME_ARCHIVE_TICK_LIMIT=3;
const API="https://api.marvelstrikeforce.com",TOKEN_URL=
  "https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const LOCK_ID="e".repeat(64),MAX_BYTES=8_000_000,MAX_TASKS=12000;
const ACTIVE=GAME_ARCHIVE_ROOT+"active.json";
const dailyKey=date=>GAME_ARCHIVE_ROOT+"budget/"+date+".json";
const runKey=id=>GAME_ARCHIVE_ROOT+"runs/"+id+"/progress.json";
const safeHeaders={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
  "X-Robots-Tag":"noindex"};
const response=(x,code=200)=>Response.json(x,{status:code,headers:safeHeaders});
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
export const GAME_ROOTS=roots.map(([id,detail])=>Object.freeze({
  id,path:"/game/v1/"+id,detail:detail?"/game/v1/"+detail:null
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
async function appToken(env,fetchImpl){
  if(!env.SCOPELY_CLIENT_ID||!env.SCOPELY_CLIENT_SECRET)return null;
  const pair=new TextEncoder().encode(env.SCOPELY_CLIENT_ID+":"+env.SCOPELY_CLIENT_SECRET);
  const res=await fetchImpl(TOKEN_URL,{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(12000),
    headers:{Authorization:"Basic "+btoa(String.fromCharCode(...pair)),
      "Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
    body:"grant_type=client_credentials"
  });
  if(!res.ok)return null;
  const data=await res.json();
  return typeof data?.access_token==="string"&&
    data.access_token.length>0&&String(data?.token_type).toLowerCase()==="bearer"?
    data.access_token:null;
}
async function boundedResponse(res){
  if(Number(res.headers.get("content-length")||0)>MAX_BYTES)return {status:"oversized"};
  if(!res.body)return {status:"invalid-body"};
  let chunks=[],size=0;
  const reader=res.body.getReader();
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES){await reader.cancel().catch(()=>{});return {status:"oversized"};}
      chunks.push(value);
    }
  }catch{return {status:"read-error"};}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let data;
  try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{return {status:"invalid-json"};}
  if(!data||typeof data!=="object"||Array.isArray(data)||
      data.data===undefined)return {status:"invalid-shape"};
  return {status:"ok",bytes,data};
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
    roots:GAME_ROOTS.length,cursor:state?.cursor||0,
    totalTasks:state?.tasks?.length||GAME_ROOTS.length,
    archivedResponses:state?.count||0,gapCount:state?.gaps?.length||0,
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
    if(state.status!=="running")return {status:state.status};
    if(state.pauseUntil&&Date.parse(state.pauseUntil)>now)
      return {status:"cooldown",pauseUntil:state.pauseUntil};
    const day=dateOf(now),budgetKey=dailyKey(day);
    const budget=await read(bucket,budgetKey)||{date:day,used:0};
    if(budget.date!==day||!Number.isSafeInteger(budget.used)||
       budget.used<0||budget.used>GAME_ARCHIVE_DAILY_LIMIT)
      return {status:"invalid-budget"};
    if(budget.used>=GAME_ARCHIVE_DAILY_LIMIT)return {status:"daily-limit"};
    let token;
    try{token=await appToken(env,fetchImpl);}
    catch{token=null;}
    if(!token){
      state.lastOutcome="app-oauth-unavailable";
      state.pauseUntil=new Date(now+60*60_000).toISOString();
      await write(bucket,key,state);
      return {status:"app-oauth-unavailable"};
    }
    let calls=0;
    while(calls<GAME_ARCHIVE_TICK_LIMIT&&budget.used<GAME_ARCHIVE_DAILY_LIMIT&&
      state.cursor<state.tasks.length){
      const task=state.tasks[state.cursor];
      if(typeof task?.path!=="string"||!task.path.startsWith("/game/v1/"))
        return {status:"invalid-task"};
      const qs=task.mode==="list"?"?page="+task.page+"&perPage="+task.perPage:"";
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
        if(upstream.status===200)parsed=await boundedResponse(upstream);
      }catch{upstream=null;}
      if(upstream?.status===472||parsed?.status==="oversized"){
        if(task.mode==="list"&&task.perPage>5){
          // Revisit all previous pages at the smaller page size; old R2
          // captures remain but only the new pagination series is authoritative.
          task.perPage=Math.max(5,Math.floor(task.perPage/2));task.page=1;
          task.series=(task.series||0)+1;
          task.seenCount=0;task.expectedTotal=null;
          task.discovered=[];task.missingIds=0;task.lastPageHash=null;
          state.lastOutcome="reduced-page-size";
          await write(bucket,key,state);continue;
        }
        state.lastOutcome="too-large";state.status="blocked";
      }else if(upstream?.status===429){
        state.lastOutcome="rate-limited";
        state.pauseUntil=new Date(now+60*60_000).toISOString();
      }else if(task.mode==="detail"&&[404,422].includes(upstream?.status)){
        // A no-longer-available ID is a documented GAP, not a reason to
        // abandon every other game resource. Never label the run complete.
        state.gaps.push({path:task.path,status:upstream.status});
        state.cursor++;
        state.lastOutcome="detail-unavailable";
      }else if(!upstream||!upstream.ok||parsed?.status!=="ok"){
        state.lastOutcome=upstream?"http-"+upstream.status+
          (parsed?.status?"-"+parsed.status:""):"network-error";
        state.status="blocked";
      }else{
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
          asOf:parsed.data.meta?.asOf||null});
        state.count++;
        let nextPage=false;
        if(task.mode==="list"&&Array.isArray(parsed.data.data)){
          const entries=parsed.data.data,meta=parsed.data.meta||{};
          const total=Number.isSafeInteger(meta.perTotal)&&meta.perTotal>=0?
            meta.perTotal:null;
          if(task.page>1&&entries.length>0&&task.lastPageHash===id){
            state.lastOutcome="duplicate-page";state.status="blocked";
          }else if(task.expectedTotal!==undefined&&task.expectedTotal!==null&&
             total!==null&&task.expectedTotal!==total){
            state.lastOutcome="pagination-total-changed";state.status="blocked";
          }else if(entries.length>task.perPage||
             (meta.page!==undefined&&meta.page!==task.page)||
             (total!==null&&((task.page-1)*task.perPage+entries.length)>total)){
            state.lastOutcome="pagination-inconsistent";state.status="blocked";
          }else{
            task.expectedTotal=total??task.expectedTotal??null;
            task.seenCount=(task.seenCount||0)+entries.length;
            task.lastPageHash=id;
            if(task.expectedTotal!==null&&task.seenCount>task.expectedTotal){
              state.lastOutcome="pagination-overcount";state.status="blocked";
            }
            const root=GAME_ROOTS.find(x=>x.id===task.root);
            if(root?.detail){
              task.discovered??=[];
              for(const entry of entries){
                const value=safeId(typeof entry==="string"?entry:entry?.id);
                if(value){
                  if(!task.discovered.includes(value))task.discovered.push(value);
                }else task.missingIds=(task.missingIds||0)+1;
              }
            }
            nextPage=task.expectedTotal!==null?
              task.seenCount<task.expectedTotal:entries.length===task.perPage;
            if(nextPage&&(entries.length===0||task.page>=1000)){
              state.lastOutcome="pagination-no-progress";state.status="blocked";
            }
            if(!nextPage&&task.expectedTotal!==null&&
               task.seenCount!==task.expectedTotal){
              state.lastOutcome="pagination-incomplete";state.status="blocked";
            }
            // Only enqueue details AFTER every list page has been validated.
            // Thus 472 retries can't leave stale detail IDs from old page sizes.
            if(state.status==="running"&&!nextPage&&root?.detail){
              if(state.tasks.length+task.discovered.length>MAX_TASKS){
                state.lastOutcome="queue-limit";state.status="blocked";
              }else{
                for(const id of task.discovered){
                  const detail=root.detail.replace("{id}",encodeURIComponent(id));
                  if(!state.tasks.some(x=>x.path===detail))
                    state.tasks.push({path:detail,root:task.root,mode:"detail"});
                }
                if(task.missingIds)state.gaps.push({path:task.path,
                  reason:"undiscoverable-detail-id",count:task.missingIds});
                delete task.discovered;delete task.missingIds;
              }
            }
          }
        }
        if(state.status==="running"){
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
    if(state.cursor===state.tasks.length&&state.status==="running"){
      state.status=state.gaps.length?"completed-with-gaps":"completed";
      state.lastOutcome=state.status;await write(bucket,key,state);
    }
    return {status:state.status,processed:calls,
      archivedResponses:state.count,completedTasks:state.cursor,
      totalTasks:state.tasks.length,lastOutcome:state.lastOutcome,
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
