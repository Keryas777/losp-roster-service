// Same-origin private shell for the event planner. A GitHub Pages page cannot
// reliably use the Worker’s SameSite=Lax session cookie in a cross-site fetch.
import { handleCaptainSession } from "./captain-session-routes.js";
import {eventPlannerAccessStatus,eventPlannerAccessResponse} from "./event-planner-auth.js";

const ROOT="/admin/events-planner";
const ASSET_ROOT="/event-planner/";
const PAGE_HEADERS={"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store, max-age=0",
  "CDN-Cache-Control":"no-store","X-Robots-Tag":"noindex","X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Vary":"Cookie",
  "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' https://keryas777.github.io; connect-src 'self' https://keryas777.github.io; img-src 'self' https://assets.marvelstrikeforce.com https://keryas777.github.io; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
const ASSETS=new Set(["index.html","app.js","styles.css",...[
  "classify.js","event-analysis.js","index.js","ledger.js","plan.js","quantity.js","resources.js","subjects.js","calendar.js","command-center.js","iso-crystals.js"
].map(file=>"lib/"+file)]);
function page(html,status=200){return new Response(html,{status,headers:PAGE_HEADERS});}
function signedInShell(message,link,linkText){
  return page('<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Planificateur LoSP</title><link rel="stylesheet" href="https://keryas777.github.io/msf/style.css?v=4"><link rel="stylesheet" href="https://keryas777.github.io/msf/evenements.css?v=24"></head><body class="ev-body"><main class="app ev-page"><header class="header ev-header"><a class="backBtn" href="https://keryas777.github.io/msf/evenements.html" aria-label="Retour aux événements">‹</a><h1 class="ev-header-banner"><img src="https://keryas777.github.io/msf/HeaderObjectifs.webp" alt="Résumé Objectifs"></h1></header><section class="ev-section"><h2>Planificateur d’événements</h2><p>'+message+'</p><p><a href="'+link+'">'+linkText+'</a></p><p>Les jetons OAuth ne sont jamais transmis au navigateur.</p></section></main></body></html>');
}
export async function handleEventPlannerPage(request,env,fetchImpl=fetch){
  const access=await eventPlannerAccessStatus(request,env,fetchImpl);
  if(access!=="allowed")return eventPlannerAccessResponse(access);
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405,headers:{Allow:"GET","Cache-Control":"no-store"}});
  const url=new URL(request.url);
  if(!url.pathname.startsWith(ROOT))return new Response("Not Found",{status:404});
  const suffix=url.pathname.slice(ROOT.length).replace(/^\//,"");
  const asset=suffix||"index.html";
  if(!ASSETS.has(asset)||asset.includes(".."))return new Response("Not Found",{status:404,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
  const status=await handleCaptainSession(request,env);
  let session={status:"temporarily-unavailable"};
  if(status.ok){try{session=await status.json();}catch{}}
  if(session.status!=="connected"){
    if(asset!=="index.html")return new Response("Not Found",{status:404,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
    const body=session.status==="temporarily-unavailable"
      ? "La session Scopely est temporairement indisponible. Réessaie dans un instant."
      : "Aucune session Scopely active dans ce navigateur.";
    return signedInShell(body,"/admin/login/captain?returnTo=events-planner","Autoriser LoSP avec Scopely");
  }
  if(!env?.ASSETS?.fetch)return new Response("Planificateur indisponible",{status:503,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
  let response;
  try{response=await env.ASSETS.fetch(new Request(new URL(ASSET_ROOT+asset,url.origin),{method:"GET",headers:{Accept:request.headers.get("Accept")||"*/*"}}));}
  catch{return new Response("Planificateur indisponible",{status:503,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});}
  if(!response.ok)return new Response("Planificateur indisponible",{status:503,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex"}});
  const headers=new Headers(response.headers);
  headers.set("Cache-Control","private, no-store, max-age=0");headers.set("CDN-Cache-Control","no-store");
  headers.set("X-Robots-Tag","noindex");headers.set("X-Content-Type-Options","nosniff");headers.set("Referrer-Policy","no-referrer");
  headers.set("Vary","Cookie");
  if(asset==="index.html")for(const [key,value] of Object.entries(PAGE_HEADERS))headers.set(key,value);
  for(const cookie of status.headers.getSetCookie?.()||[])headers.append("Set-Cookie",cookie);
  return new Response(response.body,{status:response.status,headers});
}
