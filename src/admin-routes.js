import {authenticateAdmin,adminReady} from "./admin-auth.js";
import {adminSessionList,adminResource,adminCatalog} from "./admin-data-api.js";

const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">'+
'<meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>Administration LoSP — API MSF</title>'+
'<link rel="stylesheet" href="/admin-explorer.css"></head><body>'+
'<header><h1>Administration LoSP — API MSF</h1><p>Données privées. Lecture seule.</p></header>'+
'<main><section><h2>Comptes et alliances</h2><p id="summary"></p>'+
'<button id="refresh">Actualiser</button> <button id="more" hidden>Comptes suivants</button></section>'+
'<section><h2>Explorer</h2><div class="controls">'+
'<label>Compte<select id="session"></select></label>'+
'<label>Rubrique<select id="resource"></select></label>'+
'<label id="pages-wrap">Page / par page <input id="page" type="number" min="1" max="1000" value="1">'+
'<input id="perPage" type="number" min="1" max="50" value="20"></label>'+
'<label id="member-wrap" hidden>Membre partagé <input id="member" placeholder="ID Scopely"></label>'+
'</div><p class="muted">Tous les champs des réponses, y compris les sous-objets, sont consultables en JSON brut.</p>'+
'<button id="load">Afficher les données</button><p id="status" role="status"></p></section>'+
'<section id="output">Choisis un compte et une rubrique.</section></main>'+
'<script src="/admin-explorer.js" defer></script></body></html>';

export async function handleAdmin(request,env,fetchImpl=fetch){
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  if(!adminReady(env))return new Response("Administration désactivée",{
    status:503,headers:{"Cache-Control":"no-store"}
  });
  if(!await authenticateAdmin(request,env,fetchImpl))
    return new Response("Accès administrateur refusé",{
      status:403,headers:{"Cache-Control":"no-store"}
    });
  const pathname=new URL(request.url).pathname;
  if(pathname==="/admin"||pathname==="/admin/"){
    return new Response(html,{headers:{
      "Content-Type":"text/html; charset=utf-8",
      "Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",
      "X-Robots-Tag":"noindex, nofollow, noarchive","X-Frame-Options":"DENY",
      "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }});
  }
  if(pathname==="/admin/api/catalog")return adminCatalog();
  if(pathname==="/admin/api/sessions")return adminSessionList(env,fetchImpl,new URL(request.url));
  if(pathname==="/admin/api/data")return adminResource(request,env,fetchImpl);
  return new Response("Not Found",{status:404});
}
