// Read-only inventory for the private admin dashboard. Sources and cadences
// come from the actual collectors; no Scopely requests or roster data returned.
import {GAME_ROOTS,GAME_ARCHIVE_CRON} from "./game-catalog-archive.js";
import {EPISODIC_TYPES} from "./game-phase2-discovery.js";
import {ROSTER_CRON} from "./automatic-roster-scheduler.js";
import {PLAYER_EXTRA_FAMILIES} from "./player-extras-archive.js";
import {PUBLIC_SOURCE_ROOT,PUBLIC_SOURCE_ROUTES} from "./public-msf-source-probe.js";

const GAME_CONTENT={
  languages:"Langues disponibles",localizations:"Chaînes de traduction et localisations",
  decorations:"Décorations et personnalisations",upgradeData:"Coûts et paliers de progression",
  iso8Abilities:"Capacités et classes ISO-8",
  "analysis/teamOrder":"Ordre des équipes selon les modes",
  traits:"Traits des personnages",characters:"Fiches et caractéristiques des personnages",
  characterInstances:"Instances et statistiques de personnages",
  characterInstanceCaps:"Plafonds des instances de personnages",
  dds:"Dimensions obscures",raidGroups:"Groupes de raids",raids:"Raids et définitions",
  pickYourPoisons:"Épreuves Pick Your Poison",
  survivalTowers:"Tours de survie",events:"Événements du jeu",
  scopes:"Permissions et scopes de l'API"
};
const SECONDARY_CONTENT={
  "get-character-list":"Liste des personnages",
  "get-character-abilities":"Capacités des personnages",
  "get-character-ability-caps":"Plafonds des capacités",
  "get-character-instance-caps":"Plafonds des instances",
  "get-character-max-stat-caps":"Maximums des statistiques",
  "get-traits":"Traits","get-traits-by-category":"Traits par catégorie",
  "get-iso8-abilities":"Capacités ISO-8","get-gear":"Équipements",
  "get-upgrade-tokens":"Jetons d'amélioration",
  "get-localization-heroes":"Traductions des personnages en français"
};
const PERSONAL_CONTENT={
  "personal-squads":"Équipes sauvegardées du compte OAuth",
  "personal-inventory":"Objets et ressources du compte OAuth",
  "personal-wishlist":"Objets souhaités par le compte OAuth",
  "personal-events":"Événements et progression du compte OAuth",
  "shared-member-squads":"Équipes des membres ayant explicitement partagé leur roster"
};
const GAME_FILE="game-archive/v1/runs/{runId}/objects/{sha256}.json (origine) + game-archive/v1/diff/runs/{runId}/objects/{sha256}.json (modifications) + diff/runs/{runId}/checks/*.json";
const PLAYER_FILE="roster-batches/v1/player-extras/{session}/{famille}/{cible}/latest.json + pages";
const ROSTER_FILE="roster-batches/v1/{alliance}/{runId}/provider-source/{capture}/*.json";
const SECONDARY_FILE=id=>PUBLIC_SOURCE_ROOT+id+"/sha256-{hash}.json + latest.json";
const validISO=v=>typeof v==="string"&&Number.isFinite(Date.parse(v));
const timestamp=v=>validISO(v)?v:null;
const row=(id,group,source,file,contains,automatic,enabled,when,evidence,lastAt=null,note="")=>
  ({id,group,source,file,contains,automatic,enabled,when,evidence,lastAt:timestamp(lastAt),note});

async function secondaryEvidence(bucket,route){
  const prefix=PUBLIC_SOURCE_ROOT+route.id+"/";
  try{
    const item=await bucket.get(prefix+"latest.json");
    if(!item)return {evidence:"Aucun pointeur R2",lastAt:null};
    if(Number.isFinite(item.size)&&item.size>4096)
      return {evidence:"Pointeur R2 invalide",lastAt:null};
    const raw=await item.text();
    if(raw.length>4096)return {evidence:"Pointeur R2 invalide",lastAt:null};
    const meta=JSON.parse(raw);
    if(meta?.version!==1||meta.source!==route.id||
       typeof meta.key!=="string"||!meta.key.startsWith(prefix)||
       meta.key===prefix+"latest.json")
      return {evidence:"Pointeur R2 invalide",lastAt:null};
    const object=await bucket.head(meta.key);
    return {evidence:object?
      (meta.indexed===false?"Objet brut présent, indexation non confirmée":"Objet R2 présent"):
      "Pointeur présent, fichier source manquant",
      lastAt:timestamp(meta.receivedAt)};
  }catch{return {evidence:"Contrôle R2 indisponible",lastAt:null};}
}

const nonnegative=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const boundedProgress=(done,total)=>{
  const a=nonnegative(done),b=nonnegative(total);
  return a!==null&&b!==null&&b>0&&a<=b?{done:a,total:b}:null;
};
function activityMonitors(env,state){
  const differential=state.gameDifferential||{};
  const player=state.player||{};
  const roster=state.rosterScheduler||{};
  const rosterTiming=state.rosterTiming||{};
  const alliances=Array.isArray(state.rosters?.alliances)?state.rosters.alliances:[];
  const diffEnabled=env?.GAME_DIFF_ENABLED==="true";
  const playerEnabled=env?.PLAYER_AUTO_ENABLED==="true";
  const rosterEnabled=env?.ROSTER_AUTO_ENABLED==="true"&&
    env?.ROSTER_RETENTION_CONFIRMED==="true";
  const diffStatus=!diffEnabled?"disabled":
    differential.status==="not-started"&&
    !["completed","completed-with-gaps"].includes(state.game?.status)?
      "awaiting-initial-archive":differential.status||"unavailable";
  const game={
    id:"game",title:"/game — différentiel hebdomadaire",status:diffStatus,
    progress:diffEnabled&&["checking","completed","partial"].includes(diffStatus)?
      boundedProgress(differential.checked,differential.queued):null,
    lastAt:timestamp(differential.lastCheckedAt||differential.completedAt),
    startedAt:timestamp(differential.startedAt),
    nextAt:timestamp(differential.nextRunAt),
    detail:"URLs vérifiées / URLs découvertes. Le total peut augmenter pendant une passe ; "+
      "ce n’est pas le pourcentage de toutes les ressources /game."
  };
  const playerStatus=playerEnabled?player.status||"unavailable":"disabled";
  const personal={
    id:"player",title:"/player — campagne quotidienne",status:playerStatus,
    progress:playerEnabled?boundedProgress(player.accountsProcessed,player.connectedAccounts):null,
    lastAt:timestamp(player.updatedAt||player.completedAt),
    startedAt:timestamp(player.startedAt),nextAt:timestamp(player.nextRunAt),
    detail:"Comptes OAuth entièrement parcourus / comptes connectés (pas le nombre de fichiers). "+
      "Certaines familles peuvent être refusées ou échouer."
  };
  const rosterStatus=!rosterEnabled?"disabled":
    alliances.some(a=>a.progress==="in-progress")?"running":
    roster.status==="ready"?"ready":roster.status||"unavailable";
  const latestVerified=timestamp(rosterTiming.lastConfirmedCaptureAt);
  const rosters={
    id:"rosters",title:"/player — rosters des alliances",status:rosterStatus,
    progress:null,lastAt:latestVerified||timestamp(roster.lastTick),
    lastAtLabel:latestVerified?"Dernière collecte attestée":
      "Dernier passage comptabilisé",startedAt:null,nextAt:null,
    detail:"Collecte attestée par le dernier manifeste R2 valide, "+
      "distincte du passage inscrit dans le compteur Cron."+
      (rosterTiming.cronCheckpointBehindCapture?
        " Le compteur Cron est en retard sur la dernière collecte : "+
        "cela nécessite un diagnostic du registre, pas une nouvelle collecte.":"")+
      " Progression des membres disponible séparément pour chaque alliance approuvée."
  };
  return {game,player:personal,rosters};
}

// Data returned here are metadata, never object contents, OAuth IDs or tokens.
export async function buildCollectionFileCatalog(env,state){
  const rows=[];
  const monitors=activityMonitors(env,state);
  const gameDiffOn=env?.GAME_DIFF_ENABLED==="true";
  const playerOn=env?.PLAYER_AUTO_ENABLED==="true";
  const rosterOn=env?.ROSTER_AUTO_ENABLED==="true"&&
    env?.ROSTER_RETENTION_CONFIRMED==="true";
  // Inventory shows the ongoing collection, NOT the historical one-off full archive.
  // The weekly differential is initiated automatically once the full archive is complete.
  const gameWhen="Automatique : première passe après clôture de l’archive initiale et de sa phase 2 ; puis tous les 7 jours après la fin de la passe précédente";
  const gameEvidence="Différentiel : "+(state.gameDifferential?.status||"indisponible")+
    " ; archive de référence : "+(state.game?.status||"indisponible")+
    " ; présence de ce fichier non vérifiée individuellement";
  for(const root of GAME_ROOTS){
    const desc=GAME_CONTENT[root.id]||"Catalogue du jeu";
    rows.push(row("game-"+root.id,"/game",root.path,GAME_FILE,desc,
      true,gameDiffOn,gameWhen,gameEvidence,null,
      "Archive d'origine immuable ; une nouvelle version n'est enregistrée par le différentiel que si le contenu change."));
    if(root.detail)rows.push(row("game-detail-"+root.id,"/game",
      root.detail.replace("{id}","{id officiel}"),GAME_FILE,
      "Détails associés : "+desc.toLowerCase(),true,gameDiffOn,gameWhen,
      gameEvidence,null,"IDs découverts à partir des réponses et listes officielles, sans balayage arbitraire."));
  }
  for(const type of EPISODIC_TYPES)rows.push(row(
    "game-episodic-"+type,"/game","/game/v1/episodics/"+type,
    GAME_FILE,"Épisodes "+type+" et détails liés (chapitres/nœuds documentés)",
    true,gameDiffOn,gameWhen,gameEvidence,null,
    "Phase 2 : l'exécution dépend de son activation et de l'avancement de l'archive initiale."));
  rows.push(row("game-linked","/game","/game/v1/items/{id}, orbRewards/{id}, événements et liens documentés",
    GAME_FILE,"Objets, récompenses, associations personnage/objet et ressources liées",
    true,gameDiffOn,gameWhen,gameEvidence,null,
    "Découverte ciblée, non une preuve de couverture de toutes les combinaisons de paramètres."));

  const rosterEvidence=state.rosters?.status==="ok"?
    "Manifeste par alliance ; pages sources non vérifiées ici":"Vérification R2 indisponible";
  const rosterWhen="Démarrage automatique lors d’un créneau du Cron ("+ROSTER_CRON+
    " UTC) : 02h–06h ou 14h–18h UTC, si les alliances sont approuvées";
  for(const [id,source,description] of [
    ["alliance-card","/player/v1/alliance/card","Fiche, rangs et trophées de l'alliance actuelle"],
    ["alliance-members","/player/v1/alliance/members","Membres, fiches, consentement de partage ; deux lectures par micro-lot"],
    ["personal-roster","/player/v1/roster","Roster complet paginé du compte OAuth"],
    ["shared-roster","/player/v1/roster/member/{id}","Roster paginé des membres actuellement autorisés à partager"]
  ])rows.push(row("player-"+id,"/player",source,ROSTER_FILE,description,true,
    rosterOn,rosterWhen,rosterEvidence,null,
    "Stockage privé de 7 jours ; collecte conditionnée aux autorisations et alliances approuvées."));
  rows.push(row("player-card","/player","/player/v1/card",
    "Pas d'archive brute périodique dédiée confirmée",
    "Profil personnel du compte OAuth",false,false,
    "Lecture à la demande (explorateur et connexion) ; pas de copie R2 régulière prouvée",
    "Non archivé systématiquement",null,
    "Ne pas assimiler une lecture de profil à une sauvegarde périodique."));
  rows.push(row("player-member-card","/player","/player/v1/card/member/{id}",
    "Pas d'archive brute périodique dédiée confirmée",
    "Fiche détaillée d'un membre actuel",false,false,
    "Explorateur et diagnostics à la demande",
    "Non archivé systématiquement"));
  const personal=state.personal||{};
  const playerWhen="Premier démarrage automatique lors du Cron ("+
    GAME_ARCHIVE_CRON+" UTC), si un compte OAuth autorisé est disponible";
  for(const [id,def] of Object.entries(PLAYER_EXTRA_FAMILIES)){
    const personalFamily=personal.families?.find(f=>f.id===id);
    const evidence=def.shared?
      "État par membre non vérifié individuellement dans ce tableau":
      personal.status!=="ok"?"Couverture R2 indisponible":
      personalFamily?"Pages contrôlées : "+personalFamily.archived+"/"+
        personalFamily.eligible+" compte(s) éligible(s), "+
        personalFamily.broken+" archive(s) incomplète(s)":
        "Couverture R2 indisponible";
    rows.push(row("player-"+id,"/player",
      def.path+(def.shared?"{id}":""),PLAYER_FILE,
      PERSONAL_CONTENT[id]||id,true,playerOn,playerWhen,evidence,
      personalFamily?.lastCapture||null,
      "OAuth et partage requis selon la famille ; copies privées à rétention de 7 jours."));
  }
  const sourceEvidence=await Promise.all(PUBLIC_SOURCE_ROUTES.map(x=>
    secondaryEvidence(env.CAPTAIN_BUCKET,x)));
  for(let i=0;i<PUBLIC_SOURCE_ROUTES.length;i++){
    const item=PUBLIC_SOURCE_ROUTES[i],fact=sourceEvidence[i];
    rows.push(row("secondary-"+item.id,"Services MSF +",
      item.path,SECONDARY_FILE(item.id),SECONDARY_CONTENT[item.id]||item.id,
      false,false,"À la demande uniquement ; aucune programmation Cron",
      fact.evidence,fact.lastAt,
      "Service du site MSF distinct de l'API développeur OAuth /game."));
  }
  rows.push(row("season-ranks","Autres collectes",
    "/player/v1/alliance/card (classements)","roster-batches/v1/season-ranks/captures/*.json",
    "Photographie privée des rangs, trophées et alliances",
    false,false,"Capture manuelle administrateur uniquement",
    "Capture individuelle non vérifiée dans cet inventaire"));
  rows.push(row("oauth-refresh","Autres collectes",
    "OAuth /refresh","oauth-monitoring/v1/last-refresh-check.json",
    "Dernier contrôle des accès OAuth (compteurs uniquement, sans token)",
    true,true,"Chaque heure à H:15 UTC (15 * * * *)",
    state.oauth?.status||"indisponible",state.oauth?.checkedAt||null));
  rows.push(row("alliance-coverage","Autres collectes",
    "/player/v1/alliance/card + members (couverture)",
    "oauth-coverage/v1/latest.json",
    "Agrégat privé des alliances, membres et consentements (sans rosters)",
    true,env?.CAPTAIN_COVERAGE_ENABLED==="true",
    "Chaque jour à 03h15 UTC (15 3 * * *) si activé",
    "Présence R2 non vérifiée dans cet inventaire"));
  const observedRows=rows.map(item=>{
    let activity=null;
    if(item.group==="/game")activity={
      status:monitors.game.status,lastAt:monitors.game.lastAt,
      scope:"global",note:"État global du différentiel, pas de preuve propre à cette route"
    };
    else if(item.group==="/player"){
      if(item.id==="player-card"||item.id==="player-member-card"){
        activity={status:"on-demand",lastAt:null,scope:"route"};
      }else if(item.id.startsWith("player-personal-")||
               item.id==="player-shared-member-squads"){
        const family=state.personal?.families?.find(x=>item.id==="player-"+x.id);
        const coverage=family&&state.personal?.status==="ok"?
          boundedProgress(family.archived,family.eligible):null;
        activity={
          status:!playerOn?"disabled":coverage&&coverage.done===coverage.total?
            "archived":coverage?"partial":"not-verified",
          lastAt:timestamp(family?.lastCapture),progress:coverage,
          scope:"family",
          note:"Comptes OAuth autorisés avec archives R2 vérifiées ; non lié au total de la campagne"
        };
      }else activity={
        status:monitors.rosters.status,lastAt:monitors.rosters.lastAt,
        scope:"global",note:"Dernière collecte attestée ou checkpoint global, "+
          "pas une preuve propre à cette route"
      };
    }else if(item.group==="Services MSF +"){
      activity={status:item.evidence==="Objet R2 présent"?"archived":
        item.evidence.startsWith("Objet brut présent")?"archived-unindexed":
        "not-verified",lastAt:item.lastAt,scope:"route"};
    }else if(item.id==="oauth-refresh"){
      activity={status:state.oauth?.status||"unavailable",
        lastAt:timestamp(state.oauth?.checkedAt),scope:"route"};
    }else if(item.id==="alliance-coverage"){
      activity={status:item.enabled?"ready":"disabled",lastAt:null,scope:"route"};
    }else activity={status:"not-verified",lastAt:null,scope:"route"};
    return {...item,activity};
  });
  return {status:"ok",rows:observedRows,
    monitors:[monitors.game,monitors.player,monitors.rosters],
    source:"code-collectors-and-private-r2-only",
    note:"Progressions calculées à partir des états R2 enregistrés par les Cron, pas du temps écoulé. "+
      "Les compteurs /game sont globaux et les découvertes peuvent augmenter le total. "+
      "Les barres /player montrent les comptes traités ou les archives éligibles vérifiées, "+
      "pas la couverture exhaustive de tous les endpoints. "+
      "Chemins entre accolades = modèles, pas des fichiers individuellement prouvés."};
}
