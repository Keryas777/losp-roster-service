// Shared private cache handler for the existing consent-scoped Durable Object.
import { API_KEY } from "./player-card.js";
const ROOT="https://api.marvelstrikeforce.com";
const MAX_BYTES=5_000_000, CACHE_MS=300_000, PAGE_SIZE=100;
const HEADERS={"Cache-Control":"private, no-store, max-age=0","CDN-Cache-Control":"no-store",
  "X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer","Vary":"Cookie"};
const json=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const requiredScope={events:"m3p.f.pr.act",detail:"m3p.f.pr.act",roster:"m3p.f.pr.ros",inventory:"m3p.f.pr.inv"};
function unwrap(value,kind){
  let current=value;
  for(let depth=0;depth<5;depth++){
    if(object(current)&&kind==="array"&&Array.isArray(current.data))return {data:current.data,meta:object(current.meta)?current.meta:{}};
    if(object(current)&&kind==="object"&&object(current.data)&&current.data.milestone)return {data:current.data,meta:object(current.meta)?current.meta:{}};
    if(object(current)&&kind==="object"&&current.milestone)return {data:current,meta:{}};
    if(object(current)&&Object.hasOwn(current,"data")){current=current.data;continue;}
    break;
  }
  if(kind==="object"&&object(current))return {data:current,meta:{}};
  return null;
}

async function providerGet(token,path,params,fetchImpl){
  const url=new URL(ROOT+path);
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  let response,body;
  try{
    response=await fetchImpl(url,{method:"GET",cache:"no-store",redirect:"manual",
      signal:AbortSignal.timeout(15000),headers:{Authorization:"Bearer "+token,
        "x-api-key":API_KEY,"User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"}});
    const raw=await response.text();
    if(raw.length>MAX_BYTES)return {error:"response-too-large",status:response.status};
    if(response.status===344){try{body=JSON.parse(raw);}catch{body=null;}}
    else try{body=JSON.parse(raw);}catch{return {error:"invalid-provider-response",status:response.status};}
  }catch(error){return {error:error?.name==="TimeoutError"?"provider-timeout":"provider-unavailable",status:null};}
  if(response.status===344)return {unchanged:true,status:344,data:body};
  if(!response.ok)return {error:response.status===429?"rate-limited":response.status===401?"expired-oauth":
    response.status===403||response.status===464?"scope-or-access-denied":"provider-error",status:response.status};
  return {status:response.status,data:body};
}

async function fetchPaged(token,path,params,fetchImpl,maxPages){
  const rows=[],calls=[];let expected=null,asOf=null;
  for(let page=1;page<=maxPages;page++){
    const reply=await providerGet(token,path,{...params,page,perPage:PAGE_SIZE},fetchImpl);
    calls.push({path,status:reply.status});
    if(reply.error)return {error:reply.error,status:reply.status,calls:calls.length};
    if(reply.unchanged)return {unchanged:true,calls:calls.length,asOf:params.since??null};
    const pageData=unwrap(reply.data,"array");
    if(!pageData)return {error:"invalid-provider-response",status:reply.status,calls:calls.length};
    const meta=pageData.meta;
    if(meta.page!==undefined&&Number(meta.page)!==page)return {error:"inconsistent-page",status:reply.status,calls:calls.length};
    const total=meta.perTotal??meta.total;
    if(total!==undefined){
      if(!Number.isSafeInteger(Number(total))||Number(total)<0)return {error:"invalid-total",status:reply.status,calls:calls.length};
      if(expected!==null&&expected!==Number(total))return {error:"inconsistent-total",status:reply.status,calls:calls.length};
      expected=Number(total);
    }
    if(meta.asOf!==undefined){
      if(typeof meta.asOf!=="string"||(asOf!==null&&asOf!==meta.asOf))return {error:"changed-during-pagination",status:reply.status,calls:calls.length};
      asOf=meta.asOf;
    }
    rows.push(...pageData.data);
    if(expected!==null&&rows.length===expected)return {data:rows,calls:calls.length,asOf};
    if(expected!==null&&rows.length>expected)return {error:"inconsistent-total",status:reply.status,calls:calls.length};
    if(pageData.data.length<PAGE_SIZE)return {data:rows,calls:calls.length,asOf};
  }
  return {error:"page-budget-exceeded",calls:calls.length};
}

async function loadResource(input,fetchImpl){
  const {resource,lang="fr",eventId,itemType}=input;
  if(resource==="events"){
    const result=await fetchPaged(input.token,"/player/v1/events",{lang,eventInfo:"full",objRewards:"full"},fetchImpl,8);
    if(result.error)return result;
    return {data:result.data,calls:result.calls,asOf:result.asOf};
  }
  if(resource==="roster"){
    const result=await fetchPaged(input.token,"/player/v1/roster",{lang},fetchImpl,20);
    if(result.error)return result;
    return {data:result.data,calls:result.calls,asOf:result.asOf};
  }
  if(resource==="detail"){
    const result=await providerGet(input.token,"/player/v1/events/"+encodeURIComponent(eventId),{lang,objRewards:"full"},fetchImpl);
    if(result.error)return result;
    const detail=unwrap(result.data,"object");
    if(!detail)return {error:"invalid-provider-response",status:result.status,calls:1};
    return {data:detail.data,calls:1,asOf:detail.meta.asOf??null};
  }
  if(resource==="inventory"){
    const previousAsOf=input.previous?.upstream?.asOf;
    const result=await fetchPaged(input.token,"/player/v1/inventory",{itemType,lang:"none",...(previousAsOf?{since:previousAsOf}:{})},fetchImpl,20);
    if(result.error)return result;
    if(result.unchanged){
      if(!Array.isArray(input.previous?.data))return {error:"invalid-provider-response",status:344,calls:result.calls};
      return {data:input.previous.data,calls:result.calls,asOf:previousAsOf,unchanged:true};
    }
    return {data:result.data,calls:result.calls,asOf:result.asOf};
  }
  return {error:"invalid-request",status:400};
}

export async function handleEventPlannerCache(request,fetchImpl=fetch){
  if(request.method!=="POST"||new URL(request.url).pathname!=="/planner")return json({error:"not-found"},404);
  let input;try{input=await request.json();}catch{return json({error:"invalid-request"},400);}
  if(!object(input)||typeof input.token!=="string"||!input.token||!requiredScope[input.resource]||
    !['en','fr'].includes(input.lang)&&['events','detail','roster'].includes(input.resource)||
    input.resource==="detail"&&!/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId||"")||
    input.resource==="inventory"&&!['CONSUMABLE','ISOITEM'].includes(input.itemType)||
    typeof input.refresh!=="boolean")return json({error:"invalid-request"},400);
  const suffix=input.resource==="detail"?input.eventId:input.resource==="inventory"?input.itemType:
    ['events','roster'].includes(input.resource)?input.lang:"";
  const slot="planner:"+[input.resource,suffix].filter(Boolean).join(":");
  this.inflight??=new Map();
  if(this.inflight.has(slot))return (await this.inflight.get(slot)).clone();
  const task=(async()=>{
    const now=Number.isSafeInteger(input.requestedAt)?input.requestedAt:Date.now();
    let cached=null;try{cached=await this.ctx.storage.get(slot);}catch{return json({error:"cache-unavailable"},503);}
    if(cached&&Number.isSafeInteger(cached.expiresAt)&&cached.expiresAt>now&&!input.refresh)
      return json({...cached.response,cache:{hit:true,expiresAt:new Date(cached.expiresAt).toISOString()}});
    const loaded=await loadResource({...input,previous:cached?.response},fetchImpl);
    if(loaded.error)return json({error:loaded.error,upstreamStatus:loaded.status??null,calls:loaded.calls||0},loaded.error==="rate-limited"?429:loaded.status===400?400:502);
    const expiresAt=now+CACHE_MS;
    const response={status:"ok",resource:input.resource,...(input.lang?{lang:input.lang}:{}),
      ...(input.eventId?{eventId:input.eventId}:{}),...(input.itemType?{itemType:input.itemType}:{}),
      retrievedAt:new Date(now).toISOString(),cache:{hit:false,expiresAt:new Date(expiresAt).toISOString()},
      upstream:{calls:loaded.calls,asOf:loaded.asOf??null,...(loaded.unchanged?{unchanged:true}:{})},data:loaded.data};
    try{await this.ctx.storage.put(slot,{expiresAt,response});}
    catch{return json({error:"cache-write-failed",calls:loaded.calls||0},503);}
    return json(response);
  })();
  this.inflight.set(slot,task);
  try{return (await task).clone();}finally{this.inflight.delete(slot);}
}

export const eventPlannerInternals={unwrap,fetchPaged,loadResource,providerGet};
