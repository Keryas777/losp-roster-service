import {diagnoseAdminAuth,adminReady} from "./admin-auth.js";
import {rosterSyncPreflight,saveRosterSyncApprovals} from "./roster-sync-preflight.js";
import {handlePrivateRosterPilot} from "./private-roster-pilot.js";
import {handleRosterMicrobatch,getRosterBatchStatus} from "./private-roster-batches.js";
import {rosterAutoStatus,handleAdminRosterAutoTest} from "./automatic-roster-scheduler.js";
import {handleRosterR2Coverage} from "./roster-r2-coverage.js";
import {PUBLIC_SOURCE_ROUTES,handlePublicSourceProbe} from "./public-msf-source-probe.js";
import {handleGameArchiveAdmin} from "./game-catalog-archive.js";
import {handleGameArchiveGapAudit} from "./game-archive-gaps.js";
import {handleGameArchiveInspect} from "./game-archive-inspector.js";
import {handleGameArchiveInventory} from "./game-archive-inventory.js";
import {handleGameOrphanAudit} from "./game-archive-orphan-audit.js";
import {handleGameArchiveSchemaAudit} from "./game-archive-schema-audit.js";
import {handleAllianceSeasonRanks} from "./alliance-season-ranks.js";
import {handlePlayerExtraArchive} from "./player-extras-archive.js";
import {handlePlayerCampaignAdmin} from "./player-campaign.js";
import {adminSessionList,adminResource,adminCatalog,adminCoverage,adminRefreshCron,adminMemberCard} from "./admin-data-api.js";

const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">'+
'<meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>Administration LoSP — API MSF</title>'+
'<link rel="stylesheet" href="/admin-explorer.css"></head><body>'+
'<header><h1>Administration LoSP — API MSF</h1><p>Outils privés · données chargées à la demande · aucun appel Scopely au simple affichage.</p></header>'+
'<main><section><h2>Comptes et alliances</h2><p id="summary">Aucun compte interrogé à l’ouverture. Utilise le bouton ci-dessous uniquement quand tu souhaites actualiser les profils et alliances depuis Scopely.</p>'+
'<button id="refresh" type="button">Charger / actualiser les comptes (API MSF)</button> <button id="more" hidden>Comptes suivants</button><div id="alliances" class="scroll"></div></section>'+
'<section><h2>Santé des sessions OAuth</h2>'+
'<p>Rotations réellement confirmées depuis l\'activation du suivi ; les anciennes rotations ne sont pas reconstituées.</p>'+
'<button id="check-refresh" type="button">Actualiser les renouvellements</button>'+
'<p id="refresh-status" role="status"></p><div id="refresh-sessions"></div></section>'+
'<section><h2>Couverture des alliances</h2>'+
'<p>Bilan privé des sessions autorisées. Action manuelle : effectue des lectures officielles Scopely, sans téléchargement des rosters.</p>'+
'<button id="check-coverage" type="button">Vérifier toutes les alliances</button>'+
'<p id="coverage-status" role="status"></p><div id="coverage" class="scroll"></div></section>'+
'<section><h2>Sauvegarde des classements raid / guerre</h2>'+
'<p>Capture datée des alliances dont les sessions OAuth sont connectées : rangs raid et guerre, ligue et trophées de guerre. Ce ne sont pas les points de saison. La saison exacte n’est pas fournie par l’API.</p>'+
'<p>Stockage R2 privé sous la règle existante de 7 jours. Copie le rapport rapidement si nécessaire. Aucune lecture des rosters.</p>'+
'<button id="season-ranks-capture" type="button">Capturer les classements maintenant</button>'+
'<button id="season-ranks-refresh" type="button">Voir la dernière capture</button>'+
'<button id="season-ranks-copy" type="button" disabled>Copier la capture JSON</button>'+
'<p id="season-ranks-status" role="status"></p>'+
'<div id="season-ranks-table" class="scroll"></div></section>'+
'<section><h2>Préparation de la collecte automatique des rosters</h2>'+
'<p>Collecte privée des alliances approuvées, par lots avec reprise. Planification automatique conditionnée à la règle R2 de rétention et au paramètre d’activation. Aucune publication vers la WebApp.</p>'+
'<p id="roster-auto-status" role="status">État de l’automatisation : à consulter sur demande (R2 uniquement).</p>'+
'<button id="roster-auto-refresh" type="button">Actualiser l’état automatique (R2)</button>'+
'<button id="roster-auto-test" type="button">Tester un micro-lot automatique maintenant (2 joueurs maximum)</button>'+
'<p id="roster-auto-test-status" role="status"></p>'+
'<button id="roster-preflight" type="button">Vérifier les alliances connectées</button>'+
'<p id="roster-preflight-status" role="status"></p><div id="roster-preflight-list"></div>'+
'<button id="roster-approve" type="button" disabled>Enregistrer les alliances approuvées</button>'+
'<p id="roster-approve-status" role="status"></p></section>'+
'<section><h2>Couverture réelle des rosters privés R2</h2>'+
'<p>Vérification des alliances déjà approuvées, de leurs progrès et des fichiers R2. Aucun appel Scopely ni lancement de collecte.</p>'+
'<button id="roster-r2-refresh" type="button">Vérifier les alliances en R2</button>'+
'<button id="roster-r2-copy" type="button" disabled>Copier le diagnostic JSON</button>'+
'<p id="roster-r2-status" role="status"></p><div id="roster-r2-report" class="scroll"></div></section>'+
'<section><h2>Collecte globale /player/v1</h2>'+ 
'<p>Un seul lancement pour tous les comptes OAuth actifs et les équipes des membres dont le roster est partagé. Les rosters, profils et fiches d’alliance sont déjà gérés par la collecte existante : pas de doublons. Exécution automatique par étapes même quand cette page est fermée, avec accès privé R2 et respect du consentement.</p>'+ 
'<button id="player-campaign-start" type="button">Collecter toutes les données /player</button>'+ 
'<button id="player-campaign-refresh" type="button">Voir l’avancement (R2)</button>'+ 
'<p id="player-campaign-status" role="status">Aucune vérification automatique à l’ouverture.</p>'+ 
'<div id="player-campaign-report" class="scroll"></div></section>'+ 
'<section><h2>Archives privées /player non couvertes par les rosters</h2>'+
'<p>Différencier les comptes OAuth (équipes, inventaire, souhaits, événements) et les membres non connectés (uniquement équipes si partage du roster actif). Capture manuelle, réponses sources intégrales conservées en R2 privé sept jours. Aucune collecte automatique supplémentaire.</p>'+
'<label>Famille<select id="player-extra-resource">'+
'<option value="personal-squads">Mes équipes enregistrées (OAuth)</option>'+
'<option value="personal-inventory">Mon inventaire (OAuth)</option>'+
'<option value="personal-wishlist">Ma liste de souhaits (OAuth)</option>'+
'<option value="personal-events">Mes événements/progression (OAuth)</option>'+
'<option value="shared-member-squads">Équipes d’un membre partageant son roster</option>'+
'</select></label>'+
'<div id="player-extra-member-wrap" hidden>'+
'<button id="player-extra-members-load" type="button">Charger les membres partageant leur roster</button>'+
'<label>Membre<select id="player-extra-member"><option value="">Charger les membres…</option></select></label></div>'+
'<p>Le compte OAuth est celui sélectionné dans l’Explorer ci-dessous.</p>'+
'<button id="player-extra-capture" type="button">Archiver cette famille</button>'+
'<button id="player-extra-inspect" type="button">Contrôler les archives R2 (zéro appel Scopely)</button>'+
'<p id="player-extra-status" role="status"></p>'+
'<pre id="player-extra-report" class="scroll"></pre></section>'+
'<section><h2>Recherche des services MSF complémentaires</h2>'+ 
'<p>Test en lecture seule d’une seule route historique /services/api/ à la fois. Aucun jeton joueur transmis. En cas de réponse JSON, archive intégrale dans R2 privé.</p>'+ 
'<label>Service<select id="msf-secondary-source">'+
PUBLIC_SOURCE_ROUTES.map(x=>'<option value="'+x.id+'">'+x.id+'</option>').join('')+
'</select></label>'+
'<button id="msf-secondary-probe" type="button">Tester et archiver ce service</button>'+
'<p id="msf-secondary-result" role="status"></p>'+
'<button id="msf-secondary-batch" type="button">Tester les 9 autres services</button>'+
'<p id="msf-secondary-batch-status" role="status"></p>'+
'<div id="msf-secondary-batch-results" class="scroll" aria-live="polite"></div></section>'+
'<section><h2>Collecte officielle des données générales /game/v1</h2>'+
'<p>Collecte privée paginée, avec reprise automatique, jeton OAuth applicatif et zéro donnée joueur. Pas de modification des collectes de rosters.</p>'+
'<p id="game-archive-status" role="status">Statut disponible à la demande (R2 uniquement).</p>'+
'<button id="game-archive-refresh" type="button">Actualiser l’état de la collecte (R2)</button>'+
'<button id="game-archive-start" type="button">Démarrer une collecte générale</button>'+
'<button id="game-archive-tick" type="button">Exécuter le premier micro-lot maintenant</button>'+
'<p id="game-archive-action-status" role="status"></p>'+ 
'<h3>Audit des lacunes R2</h3><p>Lecture seule des écarts déjà consignés, sans nouveaux appels Scopely. Les lacunes peuvent évoluer pendant la collecte.</p>'+
'<button id="game-gap-refresh" type="button">Analyser les lacunes enregistrées</button>'+
'<p id="game-gap-status" role="status"></p><div id="game-gap-summary"></div>'+
'<div class="controls"><label>Famille<select id="game-gap-family"><option value="">Toutes</option></select></label>'+
'<label>Cause<select id="game-gap-cause"><option value="">Toutes</option></select></label></div>'+
'<div id="game-gap-results" class="scroll"></div>'+
'<div class="actions"><button id="game-gap-prev" type="button" disabled>Précédentes</button>'+
'<button id="game-gap-next" type="button" disabled>Suivantes</button></div></section>'+
'<section><h2>Inventaire physique des archives R2</h2>'+
'<p>Compter les reçus, objets SHA-256 et réponses raw réellement présents, puis détecter les objets sans reçu et les références manquantes. Lecture seule, aucun appel Scopely.</p>'+
'<button id="game-r2-inventory-start" type="button">Inventorier les fichiers R2</button>'+
'<button id="game-r2-inventory-copy" type="button" disabled>Copier le bilan JSON</button>'+
'<p id="game-r2-inventory-status" role="status"></p>'+
'<div id="game-r2-inventory-summary" class="scroll"></div></section>'+
'<section><h2>Audit de récupérabilité des JSON orphelins R2</h2>'+
'<p>Analyse reprenable des objets sans reçu, avec contrôle SHA-256, inventaire des indices historiques et classification prudente des structures. Aucun appel Scopely, aucune modification des archives originales.</p>'+
'<button id="game-orphan-start" type="button">Lancer l’audit des orphelins</button>'+
'<button id="game-orphan-refresh" type="button">Actualiser le rapport</button>'+
'<button id="game-orphan-copy" type="button" disabled>Copier le rapport JSON</button>'+
'<p id="game-orphan-status" role="status"></p>'+
'<div id="game-orphan-summary" class="health-cards"></div></section>'+
'<section><h2>Explorer les JSON déjà archivés dans R2</h2>'+
'<p>Échantillonnage privé en lecture seule : reçus, familles réellement collectées et structure de quelques JSON. Aucun nouvel appel Scopely, aucune modification des archives.</p>'+
'<button id="game-inspect-start" type="button">Examiner les premières archives</button>'+
'<button id="game-inspect-next" type="button" disabled>Examiner le lot suivant</button>'+
'<button id="game-inspect-copy" type="button" disabled>Copier le résumé d’analyse</button>'+
'<p id="game-inspect-status" role="status"></p>'+
'<div id="game-inspect-summary"></div>'+
'<div id="game-inspect-results" class="scroll"></div></section>'+
'<section><h2>Audit automatique des structures JSON R2</h2>'+
'<p>Un lancement suffit : le Cron examine les reçus par lots, même si tu fermes la page. Aucun appel Scopely. Les structures sont analysées sur des échantillons bornés ; les fichiers volumineux restent non inspectés.</p>'+
'<button id="game-schema-start" type="button">Lancer l’audit des structures</button>'+
'<button id="game-schema-refresh" type="button">Actualiser le rapport</button>'+
'<button id="game-schema-copy" type="button" disabled>Copier le rapport JSON</button>'+
'<p id="game-schema-status" role="status"></p>'+
'<div id="game-schema-summary" class="health-cards"></div>'+
'<label>Famille<select id="game-schema-family"><option value="">Choisir une famille</option></select></label>'+
'<div id="game-schema-detail" class="scroll"></div></section>'+
'<section><h2>Diagnostic du PID joueur</h2>'+
'<p>Compare le PID en jeu à la fiche officielle du <strong>même joueur</strong>. Le compte est choisi dans Explorer ; pour un coéquipier actuel, charge d\'abord ses membres. Les IDs d\'effectif sont temporaires.</p>'+
'<label>Joueur à analyser (choix obligatoire)<select id="pid-target"><option value="">Choisir un joueur…</option></select></label>'+
'<p id="pid-choice-status" role="status">Sélectionne explicitement le compte connecté ou un membre de son alliance.</p>'+
'<button id="pid-load-members" type="button">Charger les pseudos de l\'alliance actuelle</button>'+
'<p id="pid-members-status" role="status"></p>'+
'<label>PID visible dans le jeu (facultatif)<input id="pid-expected" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="12" placeholder="Ex. 12345678" autocomplete="off"></label>'+
'<button id="pid-check" type="button" disabled>Analyser le joueur choisi</button>'+
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
'<script src="/admin-navigation.js" defer></script>'+
'<script src="/admin-explorer.js" defer></script>'+
'<script src="/admin-season-ranks.js" defer></script>'+
'<script src="/admin-pid-diagnostic.js" defer></script>'+
'<script src="/admin-roster-preflight.js" defer></script>'+ 
'<script src="/admin-roster-r2-coverage.js" defer></script>'+ 
'<script src="/admin-player-extras.js" defer></script>'+ 
'<script src="/admin-player-campaign.js" defer></script>'+ 
'<script src="/admin-secondary-probes.js" defer></script>'+
'<script src="/admin-game-archive.js" defer></script>'+
'<script src="/admin-game-archive-inspector.js" defer></script>'+
'<script src="/admin-game-r2-inventory.js" defer></script>'+
'<script src="/admin-game-orphan-audit.js" defer></script>'+
'<script src="/admin-game-schema-audit.js" defer></script>'+
'<script src="/admin-game-archive-gaps.js" defer></script></body></html>';

export async function handleAdmin(request,env,fetchImpl=fetch){
  const endpoint=new URL(request.url).pathname;
  if(request.method!=="GET"&&!(request.method==="POST"&&
       ["/admin/api/roster-approvals","/admin/api/roster-pilot",
        "/admin/api/roster-batch","/admin/api/roster-auto-test",
        "/admin/api/msf-secondary-probe","/admin/api/game-archive",
        "/admin/api/game-archive-schema-audit",
        "/admin/api/game-archive-orphan-audit",
        "/admin/api/alliance-season-ranks","/admin/api/player-extras",
         "/admin/api/player-campaign"].includes(endpoint)))
    return new Response("Method Not Allowed",{status:405});
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
  if(pathname==="/admin/api/pid-member-card")return adminMemberCard(request,env,fetchImpl);
  if(pathname==="/admin/api/roster-preflight")return rosterSyncPreflight(env,fetchImpl);
  if(pathname==="/admin/api/roster-approvals")return saveRosterSyncApprovals(request,env,fetchImpl);
  if(pathname==="/admin/api/roster-pilot")return handlePrivateRosterPilot(request,env,fetchImpl);
  if(pathname==="/admin/api/roster-batch")return handleRosterMicrobatch(request,env,fetchImpl);
  if(pathname==="/admin/api/roster-batch-status")return getRosterBatchStatus(request,env);
  if(pathname==="/admin/api/roster-r2-coverage")return handleRosterR2Coverage(request,env);
  if(pathname==="/admin/api/roster-auto-status")return Response.json(
    await rosterAutoStatus(env),{headers:{"Cache-Control":"private, no-store"}});
  if(pathname==="/admin/api/roster-auto-test")
    return handleAdminRosterAutoTest(request,env,fetchImpl);
  if(pathname==="/admin/api/msf-secondary-probe")
    return handlePublicSourceProbe(request,env,fetchImpl);
  if(pathname==="/admin/api/game-archive")
    return handleGameArchiveAdmin(request,env,fetchImpl);
  if(pathname==="/admin/api/game-archive-gaps")
    return handleGameArchiveGapAudit(request,env);
  if(pathname==="/admin/api/game-archive-inspect")
    return handleGameArchiveInspect(request,env);
  if(pathname==="/admin/api/game-archive-inventory")
    return handleGameArchiveInventory(request,env);
  if(pathname==="/admin/api/game-archive-schema-audit")
    return handleGameArchiveSchemaAudit(request,env);
  if(pathname==="/admin/api/game-archive-orphan-audit")
    return handleGameOrphanAudit(request,env);
  if(pathname==="/admin/api/alliance-season-ranks")
    return handleAllianceSeasonRanks(request,env,fetchImpl);
  if(pathname==="/admin/api/player-extras")
    return handlePlayerExtraArchive(request,env,fetchImpl);
  if(pathname==="/admin/api/player-campaign")
    return handlePlayerCampaignAdmin(request,env);
  return new Response("Not Found",{status:404});
}
