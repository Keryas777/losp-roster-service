// Temporary, Access-protected, on-demand Scopely API laboratory.
// Raw personal responses are returned no-store to the authorized browser and
// are never persisted or written to R2/GitHub.
import {verifiedAdminEmail} from "./admin-auth.js";
import {getPersonalEventGrant} from "./personal-event-progress.js";
import {API_KEY} from "./player-card.js";
import {object,finite,firstNumber,label,stable,eventsFrom,eventMilestones,progressFact,analyzePersonalEventResponse} from "./personal-event-analysis.js";

const API="https://api.marvelstrikeforce.com";
const APP_ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const BODY_LIMIT=4096, RESPONSE_LIMIT=5_000_000;
const JSON_HEADERS={"Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"private, no-store, max-age=0","CDN-Cache-Control":"no-store",
  "X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer","Vary":"Cookie"};
const json=(body,status=200)=>Response.json(body,{status,headers:JSON_HEADERS});
const isObj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const scopesFor={events:"m3p.f.pr.act",detail:"m3p.f.pr.act",roster:"m3p.f.pr.ros",inventory:"m3p.f.pr.inv"};
const allowedParamKeys={events:new Set(["lang","page","perPage","eventInfo","objRewards"]),
  detail:new Set(["lang","objRewards"]),roster:new Set(["lang"]),
  inventory:new Set(["itemType","lang","since"])};

function responseError(status,payload){
  if(status===429)return "rate-limited";
  if(status===401)return "expired-oauth";
  if(status===403||status===464)return "scope-or-access-denied";
  return isObj(payload)&&typeof payload.error==="string"?payload.error:"provider-error";
}
function validParam(key,value,resource){
  if(!allowedParamKeys[resource]?.has(key))return false;
  if(key==="lang")return ["fr","en","none"].includes(value);
  if(key==="eventInfo"||key==="objRewards")return ["full","true","false"].includes(value);
  if(key==="page")return /^\d{1,4}$/.test(value)&&Number(value)>=1;
  if(key==="perPage")return /^\d{1,3}$/.test(value)&&Number(value)>=1&&Number(value)<=100;
  if(key==="itemType")return ["CONSUMABLE","ISOITEM"].includes(value);
  if(key==="since")return value.length<=80&&/^[A-Za-z0-9:._+-]+$/.test(value);
  return false;
}
async function callApi(token,path,params,fetchImpl){
  const url=new URL(API+path);
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  const started=performance.now();
  let response,raw="";
  try{
    response=await fetchImpl(url,{method:"GET",cache:"no-store",redirect:"manual",
      signal:AbortSignal.timeout(15000),headers:{Authorization:"Bearer "+token,
        "x-api-key":API_KEY,"User-Agent":"APIClient/1.0 (Server)",Accept:"application/json"}});
    raw=await response.text();
  }catch(error){return {ok:false,error:error?.name==="TimeoutError"?"provider-timeout":"provider-unavailable",
    status:null,durationMs:Math.round(performance.now()-started),bytes:0};}
  const durationMs=Math.round(performance.now()-started);
  if(raw.length>RESPONSE_LIMIT)return {ok:false,error:"response-too-large",status:response.status,durationMs,bytes:raw.length};
  let data;
  try{data=JSON.parse(raw);}catch{return {ok:false,error:"invalid-provider-response",status:response.status,durationMs,bytes:raw.length};}
  if(response.status===344)return {ok:true,status:344,durationMs,bytes:raw.length,data:{unchanged:true,providerStatus:344}};
  if(!response.ok)return {ok:false,error:responseError(response.status,data),status:response.status,
    upstreamErrorCode:response.status,durationMs,bytes:raw.length};
  return {ok:true,status:response.status,durationMs,bytes:raw.length,data};
}
function badRequest(){return json({error:"invalid-request"},400);}
function labHtml(){
  return new Response(labDocument(),{headers:{"Content-Type":"text/html; charset=utf-8",
    "Cache-Control":"private, no-store, max-age=0","CDN-Cache-Control":"no-store",
    "X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer","X-Frame-Options":"DENY",
    "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}
function labScript(){return new Response(labClientJs(),{headers:{"Content-Type":"text/javascript; charset=utf-8",
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"}});}

function progressAnalysisModule(){return `const object=${object.toString()};
const finite=${finite.toString()};
const firstNumber=${firstNumber.toString()};
const label=${label.toString()};
const stable=${stable.toString()};
const eventsFrom=${eventsFrom.toString()};
const eventMilestones=${eventMilestones.toString()};
const progressFact=${progressFact.toString()};
export const analyzePersonalEventResponse=${analyzePersonalEventResponse.toString()};
function renderPersonalEventAnalysis(input){
  const root=document.getElementById("progress-analysis");
  if(!root)return;
  try{
    const response=input?.response??input;
    let selectedId=input?.selectedEventId??document.getElementById("events-select")?.value??null;
    if(!selectedId&&response?.resource==="detail")selectedId=eventsFrom(response)[0]?.id??null;
    if(response?.resource==="events"&&!selectedId){
      root.textContent="Sélectionne un événement reçu pour afficher son analyse.";
      return;
    }
    const rows=analyzePersonalEventResponse(response,selectedId);
    root.replaceChildren();
    if(!rows.length){
      root.textContent=response?.resource==="detail"?"Progression non fournie par Scopely":"Sélectionne un événement reçu.";
      return;
    }
    for(const event of rows){
      const h=document.createElement("h3");h.textContent=event.name+" · "+event.id;root.append(h);
      const summary=document.createElement("p");
      summary.textContent="Score : "+(event.score??"inconnu")+" · Jalons : "+event.milestoneCount+
        " · Objectifs connus / inconnus / absents : "+event.knownObjectives+" / "+event.unknownObjectives+" / "+event.absentObjectives;
      root.append(summary);
      for(const fact of event.facts){
        const card=document.createElement("article");card.className="progress-card";
        const title=document.createElement("strong");title.textContent=fact.label+" · "+fact.state;card.append(title);
        const text=document.createElement("p");
        text.textContent="Actuel "+(fact.value??"inconnu")+" / cible "+(fact.target??"inconnue")+
          (fact.percent===null?"":" · "+Math.round(fact.percent)+"%");card.append(text);
        if(fact.percent!==null){const bar=document.createElement("progress");bar.max=100;bar.value=fact.percent;
          bar.setAttribute("aria-label",fact.label);card.append(bar);}
        root.append(card);
      }
      const tiers=document.createElement("p");
      tiers.textContent="Paliers terminés prouvés : "+(event.completedTiers.map(x=>x.tier).join(", ")||"aucun")+
        " · Réclamables : "+(event.claimableTiers.map(x=>x.tier).join(", ")||"aucun");root.append(tiers);
      if(!event.facts.some(fact=>fact.value!==null)){
        const empty=document.createElement("p");empty.textContent="Progression non fournie par Scopely";root.append(empty);
      }
    }
    delete root.dataset.analysisError;
  }catch(error){
    root.replaceChildren();root.dataset.analysisError="true";
    root.textContent="Erreur locale pendant l’analyse des progressions ("+(error?.name||"JavaScript")+"). Réessaie ou recharge le laboratoire.";
  }
}
window.__personalEventLabRenderProgress=renderPersonalEventAnalysis;
document.addEventListener("personal-event-response",event=>renderPersonalEventAnalysis(event.detail));
document.addEventListener("personal-event-selection",event=>renderPersonalEventAnalysis(event.detail));
if(window.__personalEventLabLatest)renderPersonalEventAnalysis(window.__personalEventLabLatest);`}

async function requestScopely(request,env,fetchImpl){
  if(request.method!=="POST")return json({error:"method-not-allowed"},405);
  if(request.headers.get("Origin")!==APP_ORIGIN)return json({error:"forbidden"},403);
  const length=Number(request.headers.get("Content-Length")||0);
  if(length>BODY_LIMIT)return badRequest();
  let input;
  try{input=await request.json();}catch{return badRequest();}
  if(!isObj(input)||!Object.hasOwn(scopesFor,input.resource))return badRequest();
  const resource=input.resource;
  if(resource==="detail"&&!(typeof input.eventId==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(input.eventId)))return badRequest();
  if(input.allPages!==undefined&&typeof input.allPages!=="boolean")return badRequest();
  if(input.params!==undefined&&!isObj(input.params))return badRequest();
  const params={};
  for(const [key,value] of Object.entries(input.params||{})){
    if(typeof value!=="string"||!validParam(key,value,resource))return badRequest();
    params[key]=value;
  }
  if(resource==="events"){
    params.lang??="fr";params.page??="1";params.perPage??="100";
  }else if(resource==="detail")params.lang??="fr";
  else if(resource==="roster")params.lang??="fr";
  else if(resource==="inventory")params.lang??="none";
  const grant=await getPersonalEventGrant(request,env,scopesFor[resource]);
  if(grant.error)return json({error:grant.error,...(grant.requiredScope?{requiredScope:grant.requiredScope}:{})},grant.status);
  const started=performance.now(),calls=[];
  const call=async (path,query)=>{
    const r=await callApi(grant.accessToken,path,query,fetchImpl);
    calls.push({endpoint:path,params:query,status:r.status,durationMs:r.durationMs,bytes:r.bytes,
      ...(r.error?{error:r.error}:{})});
    return r;
  };
  let data;
  if(resource==="events"){
    const allPages=input.allPages!==false;
    const events=[];let page=Number(params.page),expected=null;
    for(let n=0;n<(allPages?8:1);n++,page++){
      const query={...params,page:String(page)};
      const result=await call("/player/v1/events",query);
      if(!result.ok)return json({error:result.error,upstreamStatus:result.status,calls,
        durationMs:Math.round(performance.now()-started)},result.status===429?429:502);
      if(!isObj(result.data)||!isObj(result.data.meta)||!Array.isArray(result.data.data))
        return json({error:"invalid-provider-response",calls,durationMs:Math.round(performance.now()-started)},502);
      if(expected===null&&Number.isSafeInteger(result.data.meta.perTotal))expected=result.data.meta.perTotal;
      events.push(...result.data.data);
      const pageSize=Number(result.data.meta.perPage)||Number(params.perPage);
      if(!allPages||(expected!==null&&events.length>=expected)||result.data.data.length<pageSize)break;
      if(n===7)return json({error:"page-budget-exceeded",calls,durationMs:Math.round(performance.now()-started)},502);
    }
    data={data:events,meta:{perTotal:expected,pages:calls.length}};
  }else if(resource==="detail"){
    const result=await call("/player/v1/events/"+encodeURIComponent(input.eventId),params);
    if(!result.ok)return json({error:result.error,upstreamStatus:result.status,calls,
      durationMs:Math.round(performance.now()-started)},result.status===429?429:502);
    data=result.data;
  }else if(resource==="roster"){
    const result=await call("/player/v1/roster",params);
    if(!result.ok)return json({error:result.error,upstreamStatus:result.status,calls,
      durationMs:Math.round(performance.now()-started)},result.status===429?429:502);
    data=result.data;
  }else{
    const itemTypes=params.itemType?[params.itemType]:["CONSUMABLE","ISOITEM"];
    const results=await Promise.all(itemTypes.map(itemType=>call("/player/v1/inventory",{...params,itemType})));
    const bad=results.find(result=>!result.ok);
    if(bad)return json({error:bad.error,upstreamStatus:bad.status,calls,
      durationMs:Math.round(performance.now()-started)},bad.status===429?429:502);
    data={itemTypes:Object.fromEntries(itemTypes.map((type,index)=>[type,results[index].data]))};
  }
  return json({status:"ok",resource,params,allPages:resource==="events"&&input.allPages!==false,
    requestCount:calls.length,durationMs:Math.round(performance.now()-started),calls,data});
}

export async function handlePersonalEventLab(request,env,fetchImpl=fetch){
  if(env?.PERSONAL_EVENT_LAB_ENABLED!=="true"||env?.MSF_ADMIN_ENABLED!=="true"||
      typeof env?.PERSONAL_EVENT_LAB_ADMIN_EMAIL!=="string"||!env.PERSONAL_EVENT_LAB_ADMIN_EMAIL.includes("@"))
    return new Response("Not Found",{status:404,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
  const identity=await verifiedAdminEmail(request,env,fetchImpl);
  if(!identity||identity!==env.PERSONAL_EVENT_LAB_ADMIN_EMAIL.trim().toLowerCase())
    return new Response("Forbidden",{status:403,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
  const url=new URL(request.url);
  if(url.pathname==="/admin/personal-event-lab"&&request.method==="GET")return labHtml();
  if(url.pathname==="/admin/personal-event-lab/client.js"&&request.method==="GET")return labScript();
  if(url.pathname==="/admin/personal-event-lab/progress-analysis.js"&&request.method==="GET")return new Response(
    progressAnalysisModule(),
    {headers:{"Content-Type":"text/javascript; charset=utf-8","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"}});
  if(url.pathname==="/admin/personal-event-lab/api/query")return requestScopely(request,env,fetchImpl);
  if(url.pathname==="/admin/personal-event-lab/api/status"&&request.method==="GET"){
    const grant=await getPersonalEventGrant(request,env,null);
    const scopes=grant.error?[]:grant.scope.split(/\s+/);
    const required=["m3p.f.pr.act","m3p.f.pr.ros","m3p.f.pr.inv","offline"];
    return json(grant.error?{status:"disconnected",reason:grant.error,missingScopes:required}:
      {status:required.every(scope=>scopes.includes(scope))?"connected":"scope-insufficient",
        scopes,missingScopes:required.filter(scope=>!scopes.includes(scope))});
  }
  return new Response("Not Found",{status:404,headers:{"Cache-Control":"no-store"}});
}

function labDocument(){return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Laboratoire privé — événements MSF</title><style>
:root{font:16px system-ui,sans-serif;color:#eef2ff;background:#101827}body{margin:0}main{max-width:1100px;margin:auto;padding:1rem}h1{font-size:1.5rem}p,small{color:#b7c3d8}.grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}section{background:#182337;border:1px solid #34425a;border-radius:12px;padding:1rem;margin:.8rem 0}label{display:block;margin:.5rem 0;color:#dce6f5}input,select,textarea,button{font:inherit;border-radius:8px;border:1px solid #52627c;padding:.65rem;background:#0e1726;color:#fff;max-width:100%}textarea{width:100%;min-height:5rem;box-sizing:border-box}button{background:#1769aa;border:0;margin:.25rem .3rem .25rem 0;cursor:pointer}button.secondary{background:#44546a}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;background:#0a111d;padding:.8rem;border-radius:8px;font-size:.8rem}.metrics{display:flex;gap:.5rem;flex-wrap:wrap}.metric{background:#263650;padding:.5rem .7rem;border-radius:8px}.error{color:#ffc8c8}.ok{color:#b4f4cb}.warning{border-left:4px solid #f4b942;padding:.5rem}.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}#events-select{min-width:min(100%,24rem)}.progress-card{margin:.6rem 0;padding:.7rem;background:#101827;border-radius:8px}progress{width:100%;height:1.2rem}</style><script src="/admin/personal-event-lab/client.js" defer></script><script type="module" src="/admin/personal-event-lab/progress-analysis.js"></script></head><body><main><h1>Laboratoire privé — données personnelles MSF</h1><p>Lectures immédiates à la demande. Les réponses brutes restent uniquement dans la mémoire de cet onglet et ne sont pas enregistrées.</p><p class="warning">Vérifie que le compte Scopely connecté est ton compte volontaire. Ne copie pas les réponses personnelles dans un dépôt public.</p><section><div id="connection">Vérification de la session…</div><div class="row"><a href="/login/captain"><button>Ouvrir la connexion Scopely existante</button></a><button class="secondary" id="check">Vérifier la session</button></div></section><section><h2>Requête immédiate</h2><div class="grid"><label>Ressource<select id="resource"><option value="events">Liste événements</option><option value="detail">Détail événement</option><option value="roster">Roster</option><option value="inventory">Inventaire</option></select></label><label>Événement ciblé<input id="event-id" autocomplete="off" placeholder="eventId (détail seulement)"></label><label>Paramètres JSON<textarea id="params">{"lang":"fr","eventInfo":"full","objRewards":"full","perPage":"100"}</textarea></label><label><input id="all-pages" type="checkbox" checked> Pagination complète (liste événements)</label></div><p><button id="query">Interroger Scopely sans cache</button><button class="secondary" id="snapshot-before">Enregistrer comme AVANT</button><button class="secondary" id="snapshot-after">Enregistrer comme APRÈS</button><button class="secondary" id="clear">Effacer les relevés mémoire</button></p><div id="metrics" class="metrics"></div><p id="message" aria-live="polite"></p><label>Événements reçus<select id="events-select"><option value="">Aucune liste chargée</option></select></label><pre id="response">Aucune réponse pour l’instant.</pre></section><section><h2>Analyse des progressions</h2><p>Calcul local sur les réponses déjà reçues; aucun appel Scopely supplémentaire.</p><div id="progress-analysis">Interroge ou sélectionne un événement.</div></section><section><h2>Comparaison A/B avant / après</h2><p>Les relevés sont conservés uniquement en mémoire dans cet onglet jusqu’à fermeture ou effacement.</p><div id="diff"></div></section></main></body></html>`;}

export function labClientJs(){return `(()=>{
const $=id=>document.getElementById(id);
let latest=null,before=null,after=null;
const show=(id,value)=>$(id).textContent=typeof value==="string"?value:JSON.stringify(value,null,2);
const compare=(a,b,path="",out=[])=>{
  if(Object.is(a,b))return out;
  if(a&&b&&typeof a==="object"&&typeof b==="object"){
    const keys=new Set([...Object.keys(a),...Object.keys(b)]);
    for(const key of keys)compare(a[key],b[key],Array.isArray(a)?path+"["+key+"]":(path?path+".":"")+key,out);
    return out;
  }
  out.push({path:path||"$",before:a??"<absent>",after:b??"<absent>"});return out;
};
function publishAnalysis(response,selectedEventId=null){
  const input={response,selectedEventId:selectedEventId||null};
  window.__personalEventLabLatest=input;
  if(typeof window.__personalEventLabRenderProgress==="function")window.__personalEventLabRenderProgress(input);
  else document.dispatchEvent(new CustomEvent("personal-event-response",{detail:input}));
}
window.addEventListener("error",event=>{
  if(String(event.filename||"").includes("/progress-analysis.js")){
    const root=$("progress-analysis");
    if(root){root.dataset.analysisError="true";root.textContent="Erreur JavaScript lors du chargement de l’analyse des progressions. Recharge le laboratoire.";}
  }
});
async function status(){
  try{
    const r=await fetch("/admin/personal-event-lab/api/status",{cache:"no-store",credentials:"same-origin"});
    const j=await r.json();
    show("connection",j.status==="connected"?"Connecté · scopes : "+(j.scopes||[]).join(", "):
      j.status==="scope-insufficient"?"Scopes manquants : "+(j.missingScopes||[]).join(", ")+" · utilise la connexion capitaine existante pour les autoriser.":
      "Session Scopely absente ou indisponible · "+(j.reason||"connexion requise"));
  }catch{show("connection","Service de session indisponible.");}
}
async function query(){
  let params;
  try{params=JSON.parse($("params").value||"{}");}catch{show("message","Paramètres JSON invalides.");return;}
  const body={resource:$("resource").value,params,allPages:$("all-pages").checked};
  if(body.resource==="detail")body.eventId=$("event-id").value.trim();
  show("message","Interrogation à la demande…");$("query").disabled=true;const t=performance.now();
  try{
    const r=await fetch("/admin/personal-event-lab/api/query",{method:"POST",cache:"no-store",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data=await r.json();latest={data,receivedAt:new Date().toISOString()};
    let selectedEventId=$("events-select").value||null;
    if(data.resource==="events"&&Array.isArray(data.data?.data)){
      const sel=$("events-select"),previous=selectedEventId;
      sel.replaceChildren(new Option("Choisir un événement", ""));
      for(const event of data.data.data){
        const id=event?.id??event?.eventId;
        if(id===undefined||id===null)continue;
        sel.add(new Option((event.name||id)+" · "+id,String(id)));
      }
      selectedEventId=[...data.data.data].some(event=>String(event?.id??event?.eventId)===String(previous))?previous:null;
      sel.value=selectedEventId||"";
    }else if(data.resource==="detail")selectedEventId=selectedEventId||$("event-id").value.trim()||data.data?.data?.id||data.data?.id||null;
    publishAnalysis(data,selectedEventId);
    show("response",data);
    $("metrics").replaceChildren(...["HTTP "+r.status,"Requête navigateur "+Math.round(performance.now()-t)+" ms",
      "Scopely "+(data.durationMs??"—")+" ms","Appels "+(data.requestCount??data.calls?.length??0)].map(x=>{
        const n=document.createElement("span");n.className="metric";n.textContent=x;return n;
      }));
    show("message",data.status==="ok"?"Réponse reçue; aucun cache applicatif consulté ou alimenté.":
      "Erreur explicite : "+(data.error||"requête refusée"));
  }catch(error){
    show("message","Erreur de transport vers le laboratoire.");
    const root=$("progress-analysis");
    if(root){root.dataset.analysisError="true";root.textContent="Réponse non analysable : erreur locale pendant la réception ou l’analyse.";}
  }finally{$("query").disabled=false;}
}
function snapshot(which){
  if(!latest){show("message","Interroge d’abord Scopely.");return;}
  const copy=structuredClone(latest.data);if(which==="before")before=copy;else after=copy;
  const changes=before&&after?compare(before,after):[];
  show("diff",before&&after?{beforeCaptured:true,afterCaptured:true,changedFields:changes.length,changes}:
    which==="before"?"Relevé AVANT enregistré en mémoire.":"Relevé APRÈS enregistré en mémoire.");
}
$("resource").addEventListener("change",()=>{
  const defaults={events:{lang:"fr",eventInfo:"full",objRewards:"full",perPage:"100"},
    detail:{lang:"fr",objRewards:"full"},roster:{lang:"fr"},inventory:{lang:"none"}};
  $("params").value=JSON.stringify(defaults[$("resource").value],null,2);
});
$("query").addEventListener("click",query);
$("snapshot-before").addEventListener("click",()=>snapshot("before"));
$("snapshot-after").addEventListener("click",()=>snapshot("after"));
$("check").addEventListener("click",status);
$("clear").addEventListener("click",()=>{
  latest=before=after=null;window.__personalEventLabLatest=null;
  show("response","Aucune réponse pour l’instant.");show("diff","Relevés effacés.");$("metrics").replaceChildren();
  const root=$("progress-analysis");if(root){root.dataset.analysisError="";root.textContent="Interroge ou sélectionne un événement.";}
});
$("events-select").addEventListener("change",event=>{
  const selectedEventId=event.target.value||null;
  if(latest)publishAnalysis(latest.data,selectedEventId);
  if(selectedEventId){
    $("resource").value="detail";$("params").value=JSON.stringify({lang:"fr",objRewards:"full"},null,2);
    $("event-id").value=selectedEventId;
  }
});
status();
})();`;}
