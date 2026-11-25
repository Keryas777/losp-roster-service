// Same-origin, session-bound routes for on-demand Maddoxx planner data.
import { captainSessionKey } from "./captain-vault.js";
import { getPersonalEventGrant } from "./personal-event-progress.js";
import {eventPlannerAccessStatus,eventPlannerAccessResponse} from "./event-planner-auth.js";
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const COOKIE="__Host-losp_captain_session";
const COOKIE_RX=/^[A-Za-z0-9_-]{43}$/;
const HEADERS={"Cache-Control":"private, no-store, max-age=0","CDN-Cache-Control":"no-store",
  "X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer","Vary":"Cookie"};
const json=(value,status=200)=>Response.json(value,{status,headers:HEADERS});
const requiredScope={events:"m3p.f.pr.act",detail:"m3p.f.pr.act",roster:"m3p.f.pr.ros",inventory:"m3p.f.pr.inv"};
function sessionId(request){
  const rows=(request.headers.get("Cookie")||"").split(";").map(value=>value.trim())
    .filter(value=>value.startsWith(COOKIE+"="));
  if(rows.length!==1)return null;
  const id=rows[0].slice(COOKIE.length+1);
  return COOKIE_RX.test(id)?id:null;
}
async function localStorageNamespace(id){
  if(!id)return null;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("losp-event-planner-local-v1:"+id));
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("");
}
export async function handleEventPlannerApi(request,env,fetchImpl=fetch,now=Date.now()){
  const access=await eventPlannerAccessStatus(request,env,fetchImpl);
  if(access!=="allowed")return eventPlannerAccessResponse(access);
  if(request.method!=="GET")return json({error:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||(request.headers.get("Origin")&&request.headers.get("Origin")!==ORIGIN))return json({error:"forbidden"},403);
  const resource=url.searchParams.get("resource");
  const allowed=resource==="status"?new Set(["resource"]):resource==="events"?new Set(["resource","lang","refresh"]):
    resource==="detail"?new Set(["resource","lang","eventId","refresh"]):resource==="roster"?new Set(["resource","lang","refresh"]):
    resource==="inventory"?new Set(["resource","itemType","lang","refresh"]):null;
  if(!allowed||[...url.searchParams.keys()].some(key=>!allowed.has(key)))return json({error:"invalid-request"},400);
  const id=sessionId(request);
  const grant=await getPersonalEventGrant(request,env,null);
  if(grant.error)return json({status:"disconnected",reason:grant.error},grant.status);
  const granted=new Set((grant.scope||"").split(/\s+/).filter(Boolean));
  if(resource==="status")return json({status:"connected",scopes:[...granted],storageNamespace:await localStorageNamespace(id)});
  const lang=url.searchParams.get("lang")||"fr";
  const eventId=url.searchParams.get("eventId");
  const itemType=url.searchParams.get("itemType");
  const refresh=url.searchParams.get("refresh")==="1";
  if(["events","detail","roster","inventory"].includes(resource)&&!['en','fr'].includes(lang))return json({error:"invalid-request"},400);
  if(resource==="detail"&&(!eventId||!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)))return json({error:"invalid-request"},400);
  if(resource==="inventory"&&!['CONSUMABLE','ISOITEM'].includes(itemType))return json({error:"invalid-request"},400);
  if([...url.searchParams.keys()].some(key=>key==="refresh")&&!refresh)return json({error:"invalid-request"},400);
  const scope=requiredScope[resource];
  if(!granted.has(scope))return json({error:"scope-insufficient",requiredScope:scope},403);
  if(!id||!env?.PERSONAL_EVENT_CACHE?.idFromName||!env?.PERSONAL_EVENT_CACHE?.get)return json({error:"not-configured"},503);
  const key=await captainSessionKey(id);
  const stub=env.PERSONAL_EVENT_CACHE.get(env.PERSONAL_EVENT_CACHE.idFromName(key));
  try{
    const response=await stub.fetch(new Request("https://personal-event-cache.internal/planner",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:grant.accessToken,resource,lang,eventId,itemType,refresh,requestedAt:now})
    }));
    return new Response(response.body,{status:response.status,headers:HEADERS});
  }catch{return json({error:"service-unavailable"},503);}
}
