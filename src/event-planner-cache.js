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
function providerCode(body){
  const candidates=[body?.errorCode,body?.error_code,body?.code,
    body?.error,body?.error?.code,body?.error?.errorCode,
    Array.isArray(body?.errors)?body.errors[0]?.code:null];
  for(const value of candidates){
    const code=String(value??"");
    if(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(code))return code;
  }
  return null;
}
function providerDiagnostic(path,params,status,error,code=null){
  const endpoint=path.startsWith("/player/v1/events/")?"/player/v1/events/{eventId}":path;
  const diagnostic={endpoint,httpStatus:Number.isInteger(status)?status:null,
    providerCode:code,error};
  if(["en","fr"].includes(params?.lang))diagnostic.lang=params.lang;
  if(Number.isSafeInteger(Number(params?.page))&&Number(params.page)>0)diagnostic.page=Number(params.page);
  if(["CONSUMABLE","ISOITEM"].includes(params?.itemType))diagnostic.itemType=params.itemType;
  return diagnostic;
}
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
    if(raw.length>MAX_BYTES)return {error:"response-too-large",status:response.status,
      diagnostic:providerDiagnostic(path,params,response.status,"response-too-large")};
    if(response.status===344){try{body=JSON.parse(raw);}catch{body=null;}}
    else try{body=JSON.parse(raw);}catch{return {error:"invalid-provider-response",status:response.status,
      diagnostic:providerDiagnostic(path,params,response.status,"invalid-provider-response")};}
  }catch(error){
    const failure=error?.name==="TimeoutError"?"provider-timeout":"provider-unavailable";
    return {error:failure,status:null,diagnostic:providerDiagnostic(path,params,null,failure)};
  }
  if(response.status===344)return {unchanged:true,status:344,data:body};
  if(!response.ok){
    const error=response.status===429?"rate-limited":response.status===401?"expired-oauth":
      response.status===403||response.status===464?"scope-or-access-denied":"provider-error";
    return {error,status:response.status,
      diagnostic:providerDiagnostic(path,params,response.status,error,providerCode(body))};
  }
  return {status:response.status,data:body};
}

async function fetchPaged(token,path,params,fetchImpl,maxPages){
  const rows=[],calls=[];let expected=null,asOf=null,requestPageSize=PAGE_SIZE;
  for(let page=1;page<=maxPages;page++){
    // Match Maddoxx's working event-list request: let Scopely choose the first
    // page shape, then follow its returned perPage value for later pages.
    const defaultFirstPage=path==="/player/v1/events";
    const requestParams={...params,...(page===1&&defaultFirstPage?{}:{page,perPage:requestPageSize})};
    const reply=await providerGet(token,path,requestParams,fetchImpl);
    calls.push({path,status:reply.status});
    if(reply.error)return {error:reply.error,status:reply.status,calls:calls.length,
      diagnostic:reply.diagnostic?{...reply.diagnostic,page}:undefined};
    if(reply.unchanged)return {unchanged:true,calls:calls.length,asOf:params.since??null};
    const pageData=unwrap(reply.data,"array");
    if(!pageData)return {error:"invalid-provider-response",status:reply.status,calls:calls.length,
      diagnostic:providerDiagnostic(path,requestParams,reply.status,"invalid-provider-response")};
    const meta=pageData.meta;
    if(meta.page!==undefined&&Number(meta.page)!==page)return {error:"inconsistent-page",status:reply.status,calls:calls.length,
      diagnostic:providerDiagnostic(path,requestParams,reply.status,"inconsistent-page")};
    const reportedPageSize=Number(meta.perPage);
    const pageSize=Number.isSafeInteger(reportedPageSize)&&reportedPageSize>0?reportedPageSize:PAGE_SIZE;
    requestPageSize=pageSize;
    const total=meta.perTotal??meta.total;
    if(total!==undefined){
      if(!Number.isSafeInteger(Number(total))||Number(total)<0)return {error:"invalid-total",status:reply.status,calls:calls.length,
        diagnostic:providerDiagnostic(path,requestParams,reply.status,"invalid-total")};
      if(expected!==null&&expected!==Number(total))return {error:"inconsistent-total",status:reply.status,calls:calls.length,
        diagnostic:providerDiagnostic(path,requestParams,reply.status,"inconsistent-total")};
      expected=Number(total);
    }
    if(meta.asOf!==undefined){
      if(typeof meta.asOf!=="string"||(asOf!==null&&asOf!==meta.asOf))return {error:"changed-during-pagination",status:reply.status,calls:calls.length,
        diagnostic:providerDiagnostic(path,requestParams,reply.status,"changed-during-pagination")};
      asOf=meta.asOf;
    }
    rows.push(...pageData.data);
    if(expected!==null&&rows.length===expected)return {data:rows,calls:calls.length,asOf};
    if(expected!==null&&rows.length>expected)return {error:"inconsistent-total",status:reply.status,calls:calls.length,
      diagnostic:providerDiagnostic(path,requestParams,reply.status,"inconsistent-total")};
    if(pageData.data.length<pageSize)return {data:rows,calls:calls.length,asOf};
  }
  return {error:"page-budget-exceeded",calls:calls.length,
    diagnostic:providerDiagnostic(path,{...params,page:maxPages},null,"page-budget-exceeded")};
}

async function loadResource(input,fetchImpl){
  const {resource,lang="fr",eventId,itemType}=input;
  if(resource==="events"){
    const result=await fetchPaged(input.token,"/player/v1/events",{lang},fetchImpl,8);
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
    const result=await fetchPaged(input.token,"/player/v1/inventory",{itemType,lang,...(previousAsOf?{since:previousAsOf}:{})},fetchImpl,20);
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
    input.lang!=="fr"&&['events','detail','roster','inventory'].includes(input.resource)||
    input.resource==="detail"&&!/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId||"")||
    input.resource==="inventory"&&!['CONSUMABLE','ISOITEM'].includes(input.itemType)||
    typeof input.refresh!=="boolean"||input.cacheOnly!==undefined&&typeof input.cacheOnly!=="boolean"||
    input.cacheOnly&&(input.resource!=="roster"||input.refresh))return json({error:"invalid-request"},400);
  const suffix=input.resource==="detail"?input.eventId:input.resource==="inventory"?input.itemType:
    ['events','roster'].includes(input.resource)?input.lang:"";
  const slot="planner:"+[input.resource,suffix].filter(Boolean).join(":");
  this.inflight??=new Map();
  if(this.inflight.has(slot))return (await this.inflight.get(slot)).clone();
  const task=(async()=>{
    const now=Number.isSafeInteger(input.requestedAt)?input.requestedAt:Date.now();
    let cached=null;try{cached=await this.ctx.storage.get(slot);}catch{return json({error:"cache-unavailable"},503);}
    if(input.cacheOnly){
      if(cached&&Number.isSafeInteger(cached.expiresAt)&&cached.expiresAt>now&&
        cached.response?.resource==="roster"&&Array.isArray(cached.response.data))
        return json({...cached.response,cache:{hit:true,expiresAt:new Date(cached.expiresAt).toISOString()}});
      return json({error:"cache-miss",calls:0},404);
    }
    if(cached&&Number.isSafeInteger(cached.expiresAt)&&cached.expiresAt>now&&!input.refresh)
      return json({...cached.response,cache:{hit:true,expiresAt:new Date(cached.expiresAt).toISOString()}});
    const loaded=await loadResource({...input,previous:cached?.response},fetchImpl);
    if(loaded.error){
      const diagnostic=loaded.diagnostic||null;
      if(diagnostic)console.warn("event-planner-provider-failure",JSON.stringify({resource:input.resource,...diagnostic}));
      return json({error:loaded.error,upstreamStatus:loaded.status??null,calls:loaded.calls||0,
        ...(diagnostic?{diagnostic}:{})},loaded.error==="rate-limited"?429:loaded.status===400?400:502);
    }
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
