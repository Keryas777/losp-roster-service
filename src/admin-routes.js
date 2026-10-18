import {diagnoseAdminAuth,adminReady} from "./admin-auth.js";
import {adminSessionList,adminResource,adminCatalog,adminCoverage,adminRefreshCron} from "./admin-data-api.js";

const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">'+
'<meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>Administration LoSP — API MSF</title>'+
'<link rel="stylesheet" href="/admin-explorer.css"></head><body>'+
'<header><h1>Administration LoSP — API MSF</h1><p>Données privées. Lecture seule.</p></header>'+
'<main><section><h2>Comptes et alliances</h2><p id="summary"></p>'+
'<button id="refresh">Actualiser</button> <button id="more" hidden>Comptes suivants</button><div id="alliances" class="scroll"></div></section>'+
'<section><h2>Santé des sessions OAuth</h2>'+
'<p>Rotations réellement confirmées depuis l\'activation du suivi ; les anciennes rotations ne sont pas reconstituées.</p>'+
'<button id="check-refresh" type="button">Actualiser les renouvellements</button>'+
'<p id="refresh-status" role="status"></p><div id="refresh-sessions"></div></section>'+
'<section><h2>Couverture des alliances</h2>'+
'<p>Bilan privé des sessions déjà autorisées. Relecture en direct de Scopely, sans téléchargement de rosters ni activation du scan quotidien.</p>'+
'<button id="check-coverage" type="button">Vérifier toutes les alliances</button>'+
'<p id="coverage-status" role="status"></p><div id="coverage" class="scroll"></div></section>'+
'<section><h2>Diagnostic du PID joueur</h2>'+
'<p>Vérifie si la fiche Scopely du compte sélectionné contient le PID permanent visible dans MSF. Une seule lecture officielle, sans sauvegarde.</p>'+
'<label>PID visible dans le jeu (facultatif)<input id="pid-expected" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="12" placeholder="Ex. 12345678" autocomplete="off"></label>'+
'<button id="pid-check" type="button">Analyser le profil du compte sélectionné</button>'+
'<p id="pid-status" role="status"></p><div id="pid-result"></div></section>'+
'<section><h2>Explorer</h2><div class="controls">'+
'<label>Compte<select id="session"></select></label>'+
'<label>Rubrique<select id="resource"></select></label>'+
'<label id="pages-wrap">Page / par page <input id="page" type="number" min="1" max="1000" value="1">'+
'<input id="perPage" type="number" min="1" max="50" value="20"></label>'+
'<label id="member-wrap" hidden>Membre partageant son roster <select id="member"></select></label>'+
'<label id="entity-wrap" hidden>Identifiant du détail <input id="entity" placeholder="ID Scopely"></label>'+
'</div><p class="muted">Tous les champs des réponses, y compris les sous-objets, sont consultables en JSON brut.</p>'+
'<button id="load">Afficher les données</button><p id="status" role="status"></p></section>'+
'<section id="output">Choisis un compte et une rubrique.</section></main>'+
'<script src="/admin-explorer.js" defer></script>'+
'<script src="/admin-pid-diagnostic.js" defer></script></body></html>';

export async function handleAdmin(request,env,fetchImpl=fetch){
  if(request.method!=="GET")return new Response("Method Not Allowed",{status:405});
  if(!adminReady(env))return new Response("Administration désactivée",{
    status:503,headers:{"Cache-Control":"no-store"}
  });
  const authStatus=await diagnoseAdminAuth(request,env,fetchImpl);
  if(authStatus!=="ok"){
    // Temporary opt-in troubleshooting: only a fixed reason code, never a
    // token, email, claim, key, config value, or other private information.
    const extra=env.MSF_ADMIN_DIAGNOSTICS_ENABLED==="true"
      ? " (diagnostic : "+authStatus+")" : "";
    return new Response("Accès administrateur refusé"+extra,{
      status:403,headers:{"Cache-Control":"no-store"}
    });
  }
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
  if(pathname==="/admin/api/coverage")return adminCoverage(env,fetchImpl);
  if(pathname==="/admin/api/refresh-cron")return adminRefreshCron(env);
  if(pathname==="/admin/api/data")return adminResource(request,env,fetchImpl);
  return new Response("Not Found",{status:404});
}
