// One-click, admin-initiated and cron-resumed collection of the /player families
// absent from the existing roster/alliance archives. No browser polling required.
// Only existing OAuth grants; never reads a co-member's private inventory/events.
// All state and provider JSON are private, under the pre-existing 7-day R2 rule.
import {CAPTAIN_PREFIX,captainConfigReady,getCaptainRecord} from "./captain-vault.js";
import {tokenForKey} from "./admin-data-api.js";
import {handlePlayerExtraArchive,PLAYER_EXTRA_FAMILIES} from "./player-extras-archive.js";
import {API_KEY} from "./player-card.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const ROOT="https://api.marvelstrikeforce.com";
const KEY="roster-batches/v1/player-campaign/current.json";
const SESSION=/^[a-f0-9]{64}$/;
const MEMBER=/^[A-Za-z0-9:_-]{1,256}$/;
const LOCK="f".repeat(64); // Reserved private lock namespace (not an alliance fingerprint).
const FAMILIES=Object.freeze(["personal-squads","personal-inventory",
  "personal-wishlist","personal-events"]);
const MAX_SESSIONS=100,MAX_MEMBERS=100;
const DAILY_BUDGET=1000,PER_TICK_BUDGET=10;
const AGE=7*86400000,COOLDOWN=10*60000;
const headers={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const response=(body,status=200)=>Response.json(body,{status,headers});
const meta={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const date=now=>new Date(now).toISOString().slice(0,10);
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(v)))].map(b=>b.toString(16).padStart(2,"0")).join("");
const archiveKey=(sid,family,target="self")=>
  "roster-batches/v1/player-extras/"+sid+"/"+family+"/"+target+"/latest.json";

function clean(s){
  return {status:s?.status||"not-started",startedAt:s?.startedAt||null,
    updatedAt:s?.updatedAt||null,completedAt:s?.completedAt||null,
    connectedAccounts:s?.sessions?.length||0,
    accountsProcessed:s?.sessionIndex||0,
    saved:s?.saved||0,alreadyPresent:s?.alreadyPresent||0,
    skipped:s?.skipped||0,failed:s?.failed||0,
    sharedSquads:s?.sharedSquads||0,
    currentPhase:s?.members!==null?"shared-member-squads":
      FAMILIES[s?.familyIndex]||"finalizing",
    requestsToday:s?.requestsToday||0,
    nextAttemptAt:s?.nextAttemptAt||null,
    lastError:s?.lastError||null,
    rosterCoverage:"handled-by-existing-roster-collection"};
}
async function read(bucket){
  const found=await bucket.get(KEY);
  if(!found)return null;
  const s=JSON.parse(await found.text());
  if(s?.version!==1||!Array.isArray(s.sessions)||
     s.sessions.length>MAX_SESSIONS||!s.sessions.every(x=>SESSION.test(x))||
     !["running","complete","partial"].includes(s.status)||
     !Number.isInteger(s.sessionIndex)||!Number.isInteger(s.familyIndex)||
     s.sessionIndex<0||s.sessionIndex>s.sessions.length||
     s.familyIndex<0||s.familyIndex>FAMILIES.length||
     (!Array.isArray(s.doneShared)||s.doneShared.length>MAX_SESSIONS*MAX_MEMBERS||
       !s.doneShared.every(x=>SESSION.test(x)))||
     s.members!==null&&(!Array.isArray(s.members)||s.members.length>MAX_MEMBERS||
       !s.members.every(x=>MEMBER.test(x)))||
     !Number.isInteger(s.memberIndex)||s.memberIndex<0||
     !Number.isSafeInteger(s.requestsToday)||s.requestsToday<0||
     !Number.isSafeInteger(s.saved)||!Number.isSafeInteger(s.skipped)||
     !Number.isSafeInteger(s.failed)||!Number.isSafeInteger(s.alreadyPresent))
    throw Error("invalid-player-campaign");
  return s;
}
async function save(bucket,s,now){
  s.updatedAt=new Date(now).toISOString();
  await bucket.put(KEY,JSON.stringify(s),meta);
}
async function gate(env,action,holder){
  const b=env?.ROSTER_BATCH_LOCK;
  if(!b?.idFromName||!b?.get)return false;
  const stub=b.get(b.idFromName(LOCK));
  const result=await stub.fetch(new Request("https://player-campaign-lock.internal/",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,holder,fingerprint:LOCK})
  }));
  return result.ok&&(await result.json()).status===
    (action==="acquire"?"acquired":"released");
}
async function sessions(bucket){
  const found=[],keys=new Set();
  let cursor;
  do{
    const page=await bucket.list({prefix:CAPTAIN_PREFIX,limit:100,
      ...(cursor?{cursor}:{})});
    for(const o of page.objects||[]){
      const id=o.key.slice(CAPTAIN_PREFIX.length);
      if(SESSION.test(id)&&!keys.has(id)){
        keys.add(id);found.push(id);
        if(found.length>MAX_SESSIONS)throw Error("too-many-accounts");
      }
    }
    if(page.truncated!==true)break;
    if(typeof page.cursor!=="string"||!page.cursor||page.cursor===cursor)
      throw Error("invalid-account-list");
    cursor=page.cursor;
  }while(true);
  return found.sort();
}
async function grant(env,sid,now){
  return getCaptainRecord(env.CAPTAIN_BUCKET,env.CAPTAIN_ENCRYPTION_KEY_HEX,
    CAPTAIN_PREFIX+sid,now);
}
async function existing(bucket,sid,resource,now,target="self"){
  const r=await bucket.get(archiveKey(sid,resource,target));
  if(!r)return false;
  try{
    const v=JSON.parse(await r.text());
    if(v.version!==1||v.complete!==true||!Array.isArray(v.pages)||
      v.pages.length<1||!Number.isFinite(Date.parse(v.capturedAt))||
      Date.parse(v.capturedAt)>now||now-Date.parse(v.capturedAt)>COOLDOWN)
      return false;
    // A latest pointer alone is not enough to claim physical coverage.
    if(!bucket.head)return false;
    for(const page of v.pages){
      if(!page?.key||!(await bucket.head(page.key)))return false;
    }
    return true;
  }catch{return false;}
}
function move(s){
  s.retries=0;s.nextAttemptAt=null;s.lastError=null;
  if(s.members!==null){
    s.memberIndex++;
    if(s.memberIndex>=s.members.length){
      s.members=null;s.memberIndex=0;s.sessionIndex++;s.familyIndex=0;
    }
  }else if(s.familyIndex<FAMILIES.length){
    // After four personal resources, discover the consented members,
    // not the next OAuth account.
    s.familyIndex++;
  }else{
    s.sessionIndex++;s.familyIndex=0;s.memberIndex=0;
  }
}
function fail(s,reason,now,stopReason=false){
  s.lastError=reason;
  if(stopReason){
    s.nextAttemptAt=new Date(now+60*60000).toISOString();
    s.retries=(s.retries||0)+1;
  }else{
    s.retries=(s.retries||0)+1;
    s.nextAttemptAt=new Date(now+20*60000).toISOString();
  }
  if(s.retries>=3){
    s.failed++;move(s);
  }
}
async function collect(req,env,fetchImpl,now){
  const r=await handlePlayerExtraArchive(new Request(ORIGIN+"/admin/api/player-extras",{
    method:"POST",headers:{Origin:ORIGIN,"Content-Type":"application/json"},
    body:JSON.stringify(req)
  }),env,fetchImpl,now);
  let body=null;
  try{body=await r.json();}catch{}
  return {ok:r.ok,status:body?.status||null,error:body?.error||null,http:r.status};
}
async function sharedMembers(sid,env,fetchImpl){
  const token=await tokenForKey(env,CAPTAIN_PREFIX+sid);
  if(!token)return {error:"session-unavailable"};
  const res=await fetchImpl(ROOT+"/player/v1/alliance/members",{
    method:"GET",redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(12000),
    headers:{Authorization:"Bearer "+token,"x-api-key":API_KEY,
      "User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"}
  });
  if(!res.ok)return {error:res.status===429?"rate-limited":
    res.status===403?"not-authorized":"members-unavailable"};
  const raw=await res.text();
  if(raw.length>3000000)return {error:"members-too-large"};
  const payload=JSON.parse(raw);
  const list=payload?.data;
  if(!Array.isArray(list)||list.length>MAX_MEMBERS||
    list.filter(x=>x?.isSelf===true).length!==1||
    list.some(x=>!MEMBER.test(x?.id))||
    new Set(list.map(x=>x.id)).size!==list.length)
    return {error:"invalid-membership"};
  return {members:list.filter(x=>x.isSelf!==true&&x.card?.rosterShare===true)
    .map(x=>x.id)};
}

export async function startPlayerCampaign(env,now=Date.now()){
  if(!captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK?.get||
     !env.CAPTAIN_BUCKET?.list||!env.CAPTAIN_BUCKET?.head)
    return response({error:"not-configured"},503);
  const holder=crypto.randomUUID();
  if(!(await gate(env,"acquire",holder)))return response({error:"busy"},409);
  try{
    const bucket=env.CAPTAIN_BUCKET,old=await read(bucket);
    if(old?.status==="running")return response(clean(old));
    if(old?.completedAt&&now-Date.parse(old.completedAt)<COOLDOWN)
      return response({...clean(old),recent:true});
    const connected=await sessions(bucket);
    if(!connected.length)return response({error:"no-oauth-accounts"},409);
    const s={version:1,status:"running",startedAt:new Date(now).toISOString(),
      updatedAt:new Date(now).toISOString(),completedAt:null,sessions:connected,
      sessionIndex:0,familyIndex:0,members:null,memberIndex:0,retries:0,doneShared:[],
      saved:0,alreadyPresent:0,skipped:0,failed:0,sharedSquads:0,
      requestsDate:date(now),requestsToday:0,nextAttemptAt:null,lastError:null};
    await save(bucket,s,now);
    return response(clean(s));
  }catch{return response({error:"start-unavailable"},503);}
  finally{await gate(env,"release",holder);}
}
export async function getPlayerCampaignStatus(env){
  if(!captainConfigReady(env))return response({error:"not-configured"},503);
  try{return response(clean(await read(env.CAPTAIN_BUCKET)));}
  catch{return response({error:"status-unavailable"},503);}
}
export async function handlePlayerCampaignAdmin(request,env,now=Date.now()){
  if(request.method==="GET"&&new URL(request.url).search==="")
    return getPlayerCampaignStatus(env);
  if(request.method!=="POST")return response({error:"method-not-allowed"},405);
  if(new URL(request.url).origin!==ORIGIN||new URL(request.url).search||
    request.headers.get("Origin")!==ORIGIN||
    !(request.headers.get("Content-Type")||"").toLowerCase()
      .startsWith("application/json"))return response({error:"forbidden"},403);
  try{
    if((await request.text()).trim()!=='{"action":"start"}')
      return response({error:"invalid-action"},400);
  }catch{return response({error:"invalid-action"},400);}
  return startPlayerCampaign(env,now);
}
export async function runPlayerCampaignTick(env,fetchImpl=fetch,now=Date.now()){
  if(!captainConfigReady(env)||!env?.ROSTER_BATCH_LOCK?.get)
    return {status:"disabled"};
  const bucket=env.CAPTAIN_BUCKET;
  let current;
  try{current=await read(bucket);}catch{return {status:"invalid-state"};}
  if(current?.status!=="running")return {status:"idle"};
  if(current.nextAttemptAt&&Date.parse(current.nextAttemptAt)>now)
    return {status:"cooldown"};
  const holder=crypto.randomUUID();
  if(!(await gate(env,"acquire",holder)))return {status:"busy"};
  try{
    const s=await read(bucket);
    if(s?.status!=="running")return {status:"idle"};
    if(s.nextAttemptAt&&Date.parse(s.nextAttemptAt)>now)
      return {status:"cooldown"};
    if(s.requestsDate!==date(now)){
      s.requestsDate=date(now);s.requestsToday=0;
    }
    if(s.requestsToday+PER_TICK_BUDGET>DAILY_BUDGET){
      s.nextAttemptAt=new Date(now+60*60000).toISOString();
      await save(bucket,s,now);
      return {status:"daily-budget-reached"};
    }
    // Reserve the entire bounded request budget *before* any provider GET.
    // If execution crashes, the provider count is overestimated (safe).
    s.requestsToday+=PER_TICK_BUDGET;
    await save(bucket,s,now);
    let used=0;
    const limitedFetch=async(url,options)=>{
      if(new URL(url).hostname==="api.marvelstrikeforce.com"){
        if(used>=PER_TICK_BUDGET)throw Error("player-campaign-tick-budget");
        used++;
      }
      return fetchImpl(url,options);
    };
    if(s.sessionIndex>=s.sessions.length){
      s.status=s.failed?"partial":"complete";s.completedAt=new Date(now).toISOString();
      await save(bucket,s,now);return {status:s.status};
    }
    const sid=s.sessions[s.sessionIndex];
    const record=await grant(env,sid,now);
    if(!record){
      s.skipped++;s.familyIndex=FAMILIES.length;s.members=null;
      move(s);await save(bucket,s,now);return {status:"no-longer-authorized"};
    }
    const scope=new Set(record.scope.split(/\s+/));
    if(s.members===null&&s.familyIndex<FAMILIES.length){
      const family=FAMILIES[s.familyIndex],def=PLAYER_EXTRA_FAMILIES[family];
      if(!scope.has(def.scope)){s.skipped++;move(s);
        await save(bucket,s,now);return {status:"scope-not-granted"};}
      if(await existing(bucket,sid,family,now)){
        s.alreadyPresent++;move(s);await save(bucket,s,now);
        return {status:"already-archived"};
      }
      const result=await collect({session:sid,resource:family},env,limitedFetch,now);
      if(result.ok&&["archived","recent-capture"].includes(result.status)){
        s.saved+=Number(result.status==="archived");
        s.alreadyPresent+=Number(result.status==="recent-capture");
        move(s);
      }else if(["not-authorized","not-found"].includes(result.error)){
        s.skipped++;move(s);
      }else fail(s,result.error||result.status||"unknown",now,
        result.http===429||result.error==="rate-limited");
      await save(bucket,s,now);return {status:result.status||result.error||"failed"};
    }
    if(s.members===null){
      if(!scope.has("m3p.f.ar.ros")||!scope.has("m3p.f.ar.pro")){
        s.skipped++;move(s);await save(bucket,s,now);
        return {status:"scope-not-granted"};
      }
      let found;
      try{found=await sharedMembers(sid,env,limitedFetch);}
      catch{found={error:"members-unavailable"};}
      if(found.error){
        if(found.error==="not-authorized"){s.skipped++;move(s);}
        else fail(s,found.error,now,found.error==="rate-limited");
        await save(bucket,s,now);return {status:found.error};
      }
      s.members=found.members;s.memberIndex=0;s.retries=0;
      if(!s.members.length){move(s);}
      await save(bucket,s,now);return {status:"members-discovered"};
    }
    // Co-member IDs are transient: the existing archive routine revalidates
    // current rosterShare=true both before and after each member's GET.
    const member=s.members[s.memberIndex];
    if(!member){s.members=null;move(s);await save(bucket,s,now);
      return {status:"members-finished"};}
    const target=await digest(member);
    if(s.doneShared.includes(target)){
      s.alreadyPresent++;move(s);await save(bucket,s,now);
      return {status:"already-collected-by-another-session"};
    }
    if(await existing(bucket,sid,"shared-member-squads",now,target)){
      s.alreadyPresent++;s.doneShared.push(target);move(s);await save(bucket,s,now);
      return {status:"already-archived"};
    }
    const result=await collect({session:sid,resource:"shared-member-squads",member},
      env,limitedFetch,now);
    if(result.ok&&["archived","recent-capture"].includes(result.status)){
      s.saved+=Number(result.status==="archived");
      s.alreadyPresent+=Number(result.status==="recent-capture");
      s.sharedSquads++;s.doneShared.push(target);move(s);
    }else if(["not-found","not-authorized"].includes(result.error)){
      // Unsupported shared squads route => do not hammer this endpoint for
      // every consenting member of the same OAuth account.
      s.skipped+=s.members.length-s.memberIndex;
      s.memberIndex=s.members.length-1;move(s);
    }else if(["not-currently-shared","member-consent-changed"].includes(result.error)){
      s.skipped++;move(s);
    }else fail(s,result.error||result.status||"unknown",now,
      result.http===429||result.error==="rate-limited");
    await save(bucket,s,now);return {status:result.status||result.error||"failed"};
  }catch{return {status:"tick-unavailable"};}
  finally{await gate(env,"release",holder);}
}
