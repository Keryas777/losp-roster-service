import { analyzeMilestoneEvent } from "./lib/event-analysis.js";
import { RESOURCES, classifyObjective, observeEvent, resourcesInUse, declareResource, refreshResource, estimateResource, parseQuantity } from "./lib/index.js";

const $=id=>document.getElementById(id);
const API="/captain/api/event-planner";
const CATALOG_BASE="https://keryas777.github.io/msf/data/";
const STORAGE_KEY="losp-event-planner-v1";
const number=new Intl.NumberFormat("fr-FR");
const date=new Intl.DateTimeFormat("fr-FR",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Paris"});
const state={eventsEn:[],eventsFr:[],roster:null,characters:[],inventory:null,inventoryReason:null,skipped:new Set(),stock:{},history:[],details:new Map(),rewardDetails:new Map(),selectedId:null,analysis:null,observations:[],drafts:{},tab:"events",loadingStock:false,refreshing:false};

function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function fmt(value){return value==null?"Données indisponibles":number.format(value);}
function eventDate(seconds){return Number.isFinite(Number(seconds))?date.format(new Date(Number(seconds)*1000)):"Date inconnue";}
function getEvent(id,language="en"){return (language==="en"?state.eventsEn:state.eventsFr).find(item=>String(item.id)===String(id))||null;}
function milestoneObjective(event){return event?.milestone?.brackets?.find(row=>row?.objective)?.objective||null;}
function stripTags(value){return String(value??"").replace(/<[^>]*>/g,"").replace(/\s+/g," ").trim();}
function displayName(event){return stripTags(event?.name)||"Événement sans titre";}
function eventTypeLabel(event){
  const labels={info:"Information",bonus:"Bonus",blitz:"Blitz",episodic:"Épisodique",milestone:"Jalons",raid:"Raid",raidSeason:"Saison de raid",warSeason:"Saison de guerre",donation:"Don",battlePass:"Battle Pass",strikePass:"Strike Pass",tower:"Tour",pickYourPoison:"À vous de choisir"};
  const type=labels[event?.type]||stripTags(event?.type)||"Événement";
  if(event?.type==="milestone"&&event?.milestone?.type)return `${type} · ${event.milestone.type}`;
  return type;
}
function errorText(error){
  if(error?.body?.error==="scope-insufficient")return "Cette autorisation ne donne pas accès à cette donnée.";
  if(error?.body?.reason==="not-connected"||error?.body?.reason==="consent-revoked")return "Session Scopely absente ou révoquée.";
  if(error?.body?.error==="rate-limited")return "Scopely limite temporairement les requêtes. Réessaie dans un instant.";
  return "Donnée indisponible pour le moment.";
}
async function api(params){
  const query=new URLSearchParams(params);
  const response=await fetch(API+"?"+query.toString(),{method:"GET",credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
  let body;try{body=await response.json();}catch{body={error:"invalid-response"};}
  if(!response.ok){const error=new Error(body.error||"request-failed");error.status=response.status;error.body=body;throw error;}
  return body;
}
function loadLocal(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}");
    if(Array.isArray(saved.skipped))state.skipped=new Set(saved.skipped.filter(id=>typeof id==="string"));
    if(saved.stock&&typeof saved.stock==="object"&&!Array.isArray(saved.stock))state.stock=saved.stock;
    if(Array.isArray(saved.history))state.history=saved.history.slice(-500);
  }catch{state.skipped=new Set();state.stock={};state.history=[];}
}
function saveLocal(){
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify({skipped:[...state.skipped],stock:state.stock,history:state.history.slice(-500)}));}
  catch{banner("Les réglages locaux ne peuvent pas être enregistrés dans ce navigateur.","warning");}
}
function banner(message,kind="warning"){
  const box=el("p",kind,message);$("connection").replaceChildren(box);
}
async function loadCatalog(){
  const load=async path=>{const response=await fetch(CATALOG_BASE+path,{cache:"force-cache",mode:"cors"});if(!response.ok)throw new Error("catalog-unavailable");return response.json();};
  try{
    const [catalog,traits,eventTraits]=await Promise.all([load("msf-characters.json"),load("dd-character-traits.json"),load("dd-event-character-traits.json")]);
    const regular=traits?.characters||{},special=eventTraits?.characters||{};
    state.characters=(Array.isArray(catalog)?catalog:[]).filter(item=>item?.id&&item.player_Character===true).map(item=>({
      id:item.id,nameEn:item.nameEn||item.nameKey||item.id,nameFr:item.nameFr||null,
      portrait:item.portraitUrl||null,traits:[...new Set([...(regular[item.id]||[]),...(special[item.id]||[])])]
    }));
  }catch{state.characters=[];}
}
function setTab(name){
  state.tab=name;
  document.querySelectorAll(".planner-tabs [role=tab]").forEach(button=>{
    const active=button.dataset.tab===name;button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;
  });
  document.querySelectorAll(".tab-panel").forEach(panel=>panel.hidden=panel.id!=="panel-"+name);
  if(name==="objectives")renderObjectives();
  if(name==="plan")renderPlan();
  if(name==="stock")renderStock();
}
function activeEvents(){const now=Date.now()/1000;return state.eventsEn.filter(event=>Number(event?.startTime)<=now&&Number(event?.endTime)>now);}
function rewardsFrom(event){
  const objective=milestoneObjective(event),tiers=objective?.tiers||{},rewards={};
  for(const [tier,row] of Object.entries(tiers)){
    const entries=row?.rewards?.allOf||row?.rewards?.anyOf||[];
    rewards[tier]=entries.map(item=>({itemId:item?.item?.id||item?.id,quantity:Number(item?.quantity)||0})).filter(item=>item.itemId);
  }
  return rewards;
}
function buildObservations(){
  state.observations=activeEvents().map(event=>observeEvent(event,state.rewardDetails.get(String(event.id))||rewardsFrom(event)));
  for(const resource of Object.keys(state.stock)){
    if(state.stock[resource]?.ledger)state.stock[resource].ledger=refreshResource(state.stock[resource].ledger,resource,state.observations);
  }
  saveLocal();
}
function inventoryValue(resource){
  const itemId=RESOURCES[resource]?.itemId;
  if(!state.inventory||!itemId||!Object.hasOwn(state.inventory,itemId))return null;
  return state.inventory[itemId];
}
function stockEstimate(resource){
  const ledger=state.stock[resource]?.ledger;if(!ledger)return null;
  const estimate=estimateResource(ledger);
  const progressUnknown=state.observations.some(event=>(event.unknownCounters||[]).some(counter=>counter.resource===resource));
  return progressUnknown?{...estimate,value:Number(ledger.declared)||0,source:"declared",spentSince:null,earnedSince:null,dataUnavailable:true}:estimate;
}
function effectiveStock(){
  const used=resourcesInUse(state.observations,[...state.skipped]);
  return Object.fromEntries(used.map(key=>{
    const apiValue=inventoryValue(key);
    const saved=stockEstimate(key);
    if(apiValue!==null)return [key,{value:apiValue,source:"api"}];
    if(saved)return [key,saved];
    return [key,null];
  }).filter(([,value])=>value?.value!=null));
}
function currentAnalysis(){
  if(!state.selectedId)return null;
  const detail=state.details.get(String(state.selectedId))||{};
  const eventEn=detail.en||getEvent(state.selectedId,"en"),eventFr=detail.fr||getEvent(state.selectedId,"fr");
  if(!eventEn)return null;
  return analyzeMilestoneEvent({eventEn,eventFr,roster:state.roster||[],rosterKnown:Array.isArray(state.roster),characters:state.characters,stock:effectiveStock()});
}
function renderEvents(){
  const events=activeEvents(),visible=events.filter(event=>!state.skipped.has(String(event.id)));
  $("event-count").textContent=`${visible.length} actif${visible.length===1?"":"s"} · ${events.length-visible.length} ignoré${events.length-visible.length===1?"":"s"}`;
  const list=$("events-list");list.replaceChildren();
  if(!visible.length){list.append(el("div","empty-card",events.length?"Tous les événements actifs sont ignorés.":"Aucun événement actif n’a été renvoyé par Scopely."));}
  for(const event of visible){
    const id=String(event.id),card=el("article","event-card");card.dataset.eventId=id;card.setAttribute("aria-current",String(id===String(state.selectedId)));
    const select=el("button","event-card__select");select.type="button";select.dataset.action="select";select.dataset.eventId=id;
    select.append(el("h3","",displayName(getEvent(id,"fr")||event)));
    const meta=el("div","event-meta");meta.append(el("span","tag",eventTypeLabel(getEvent(id,"fr")||event)),el("span","",`Fin ${eventDate(event.endTime)}`));
    select.append(meta);
    const actions=el("div","event-card__actions");
    const skip=el("button","small-button","Ignorer");skip.type="button";skip.dataset.action="skip";skip.dataset.eventId=id;skip.setAttribute("aria-label","Ignorer "+displayName(event));
    actions.append(skip);card.append(select,actions);list.append(card);
  }
  const skippedList=$("skipped-list");skippedList.replaceChildren();
  const skipped=events.filter(event=>state.skipped.has(String(event.id)));
  if(!skipped.length){skippedList.append(el("p","muted","Aucun événement ignoré."));}
  for(const event of skipped){const row=el("div","event-card");row.append(el("span","",displayName(getEvent(event.id,"fr")||event)));const restore=el("button","small-button","Réintégrer");restore.type="button";restore.dataset.action="restore";restore.dataset.eventId=String(event.id);row.append(restore);skippedList.append(row);}
  if(state.selectedId&&!visible.some(event=>String(event.id)===String(state.selectedId)))state.selectedId=visible[0]?.id||null;
  if(!state.selectedId&&visible.length)state.selectedId=visible[0].id;
  if(!state.selectedId){$("selected-event").replaceChildren(el("p","muted","Choisis un événement pour afficher son analyse."));state.analysis=null;}
}
function statusTag(status){const labels={done:"Terminé confirmé",doable:"Faisable gratuitement",resource:"Ressource requise",blocked:"Bloqué par le roster",unknown:"Données indisponibles"};return labels[status]||"Données indisponibles";}
function loadDetailPair(id){
  const key=String(id);if(state.details.has(key))return Promise.resolve(state.details.get(key));
  const existing=state.details.get("loading:"+key);if(existing)return existing;
  const refresh=state.refreshing?"1":undefined;
  const task=Promise.allSettled([api({resource:"detail",eventId:key,lang:"en",...(refresh?{refresh}: {})}),api({resource:"detail",eventId:key,lang:"fr",...(refresh?{refresh}: {})})]).then(results=>{
    const pair={};if(results[0].status==="fulfilled")pair.en=results[0].value.data;
    if(results[1].status==="fulfilled")pair.fr=results[1].value.data;
    pair.error=results.find(item=>item.status==="rejected")?.reason||null;
    state.details.set(key,pair);
    if(pair.en)state.rewardDetails.set(key,rewardsFrom(pair.en));
    buildObservations();return pair;
  }).finally(()=>state.details.delete("loading:"+key));
  state.details.set("loading:"+key,task);return task;
}
async function showSelected(id){
  state.selectedId=String(id);renderEvents();
  const root=$("selected-event"),event=getEvent(id,"en"),fr=getEvent(id,"fr")||event;
  if(!event)return;
  root.replaceChildren();root.append(el("p","muted","Chargement des détails Scopely…"));
  await loadDetailPair(id);
  if(state.selectedId!==String(id))return;
  const analysis=currentAnalysis();state.analysis=analysis;
  renderSelected(event,fr,analysis);
  if(state.tab==="objectives")renderObjectives();if(state.tab==="plan")renderPlan();if(state.tab==="stock")renderStock();
}
function addActionRow(list,action){
  const row=el("li","action-row");const name=action.label||action.character?.name||"Objectif sans libellé";
  addSafeImage(row,action.character?.portrait,"character-portrait");const copy=el("div","action-row__copy");copy.append(el("strong","",name),el("span","status status--"+action.status,statusTag(action.status)));
  const details=[];
  if(action.progressState==="unknown")details.push("Progression : données indisponibles");
  else if(action.progress!=null&&action.cap!=null)details.push(`${fmt(action.progress)} / ${fmt(action.cap)} pts`);
  if(action.remainingUnits!=null)details.push(`${fmt(action.soFarUnits)} / ${fmt(action.capUnits)} unités`);
  if(action.fightsLeft!=null)details.push(`${fmt(action.fightsLeft)} action(s) restante(s)`);
  if(action.reason?.code)details.push(reasonText(action));
  if(action.resourceLabel)details.push(action.resourceLabel);
  if(action.assumptions?.length)details.push("Hypothèse : "+action.assumptions.join(", "));
  if(details.length)copy.append(el("p","row-detail",details.join(" · ")));
  row.append(copy);
  list.append(row);
}
function reasonText(action){
  const reason=action.reason;
  if(reason.code==="notOwned")return "Personnage non présent dans le roster";
  if(["yellowStars","redStars","gearTier","level"].includes(reason.code))return `Roster ${fmt(reason.have)} · ${fmt(reason.need)} requis`;
  if(reason.code==="traitShort")return `Trait : ${reason.have}/${reason.need} personnages requis (hypothèse Maddoxx)`;
  if(reason.code==="external")return "Hors roster";
  if(reason.code==="rosterUnavailable")return "Roster indisponible : faisabilité inconnue";
  return "Condition non remplie";
}
function objectiveSection(title,rows,emptyText){
  const section=el("section","panel-card");section.append(el("h3","",title));
  if(!rows.length){section.append(el("p","muted",emptyText));return section;}
  const list=el("ul","action-list");rows.forEach(action=>addActionRow(list,action));section.append(list);return section;
}
function addSafeImage(parent,url,className,alt=""){
  if(typeof url!=="string"||!/^https:\/\/assets\.marvelstrikeforce\.com\//.test(url))return;
  const image=el("img",className);image.src=url;image.alt=alt;image.loading="lazy";parent.append(image);
}
function renderSelected(event,fr,analysis){
  const root=$("selected-event");root.replaceChildren();
  const head=el("div","selected-head"),copy=el("div");copy.append(el("p","eyebrow","Analyse personnelle"),el("h2","",displayName(fr||event)));
  copy.append(el("p","",`${eventDate(event.startTime)} → ${eventDate(event.endTime)}`));head.append(copy);
  const image=event.cardArt||event.popupArt;
  if(typeof image==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\//.test(image)){const img=el("img");img.alt="";img.src=image;img.loading="lazy";head.append(img);}
  root.append(head);
  const actions=el("div","plan-actions"),skip=el("button","button button-secondary",state.skipped.has(String(event.id))?"Réintégrer cet événement":"Ignorer cet événement");skip.type="button";skip.dataset.action=state.skipped.has(String(event.id))?"restore":"skip";skip.dataset.eventId=String(event.id);actions.append(skip);root.append(actions);
  if(!state.roster){root.append(el("p","warning","Roster personnel indisponible. Les conditions liées aux personnages et les actions faisables ne sont pas estimées."));}
  if(!analysis){root.append(el("p","warning","Données de scoring indisponibles pour cette réponse. Aucun objectif n’est déclaré terminé."));renderObjectives();renderPlan();return;}
  if(!analysis.supported){
    const message=event.type!=="milestone"?"Événement classé et consultable. Le moteur Maddoxx calcule la planification pour les événements à jalons avec des données de scoring; le calendrier public garde les détails de cet événement.":"Données de scoring insuffisantes. Les calculs Maddoxx restent actifs pour les lignes reconnues dès que Scopely fournit leurs valeurs.";
    root.append(el("p","warning",message));
    const details=stripTags(fr?.description||fr?.details||fr?.subName||event?.description||event?.details||"");
    if(details)root.append(el("section","panel-card",details));
    renderObjectives();renderPlan();return;
  }
  const metrics=el("div","metric-row");
  const progressLabel=analysis.event.progressState==="available"?`${fmt(analysis.event.points)} pts · progression Scopely`:
    analysis.event.progressState==="estimated"?`${fmt(analysis.event.points)} pts · somme Maddoxx estimée`:
    analysis.event.progressState==="partial"?`${fmt(analysis.event.reportedActionPoints)} pts recensés · total incomplet`:
    "Données indisponibles";
  metrics.append(el("span","metric",`Progression : ${progressLabel}`));
  metrics.append(el("span","metric",`Actions gratuites connues : ${fmt(analysis.event.doablePoints)} pts`));
  metrics.append(el("span","metric",`Roster : ${state.roster.length} personnages`));root.append(metrics);
  const rows=el("div","analysis-grid");
  const done=analysis.actions.filter(action=>action.status==="done");
  const remaining=analysis.actions.filter(action=>action.status!=="done");
  rows.append(objectiveSection("Objectifs terminés",done,"Aucun objectif terminé n’est confirmé par les données reçues."));
  rows.append(objectiveSection("Objectifs restants",remaining,"Tous les compteurs reçus sont terminés."));
  const tiers=el("section","panel-card");tiers.append(el("h3","","Paliers et récompenses"));
  if(!analysis.tiers.length)tiers.append(el("p","muted","Paliers indisponibles."));
  else{
    const tierList=el("ul","tier-list");for(const tier of analysis.tiers){
      const row=el("li","tier-row"),mark=analysis.event.completedTierKnown?Number(tier.tier)<=analysis.event.currentTier?"✓":"·":"?";
      row.append(el("span","tier-number",`${mark} ${tier.tier}`));const info=el("div");info.append(el("strong","",`${fmt(tier.goal)} points`));
      if(tier.rewards?.length){const rewardList=el("ul","tier-rewards");for(const reward of tier.rewards){const rewardRow=el("li","reward-row");addSafeImage(rewardRow,reward.icon,"reward-icon");rewardRow.append(el("span","",`${fmt(reward.quantity)} ${reward.name}`));rewardList.append(rewardRow);}info.append(rewardList);}
      row.append(info);tierList.append(row);
    }tiers.append(tierList);
  }
  const claim=analysis.event.claimableTiersKnown?analysis.event.claimableTiers.length?analysis.event.claimableTiers.join(", "):"Aucun":"Données indisponibles";
  const premium=Array.isArray(analysis.event.claimableTiersPremium)?analysis.event.claimableTiersPremium.length?analysis.event.claimableTiersPremium.join(", "):"Aucun":"Données indisponibles";
  tiers.append(el("p","row-detail",`Paliers terminés confirmés : ${analysis.event.completedTierKnown?fmt(analysis.event.currentTier):"Données indisponibles"} · À réclamer : ${claim} · Premium : ${premium}`));rows.append(tiers);
  const grouped=el("section","panel-card");grouped.append(el("h3","","Actions et leviers du roster"));
  if(analysis.groups.length){const list=el("ul","action-list");for(const group of analysis.groups){const representative=analysis.actions.find(action=>group.actions.includes(action.index));if(representative)addActionRow(list,{...representative,status:group.status,doablePoints:group.doablePoints,remaining:representative.remaining,fightsLeft:group.fightsLeft});}grouped.append(list);}
  else grouped.append(el("p","muted","Aucune action classée à partir du scoring reçu."));
  if(analysis.levers.length){grouped.append(el("h4","","Améliorations possibles"));const list=el("ul","action-list");for(const lever of analysis.levers){const li=el("li","action-row");addSafeImage(li,lever.character.portrait,"character-portrait");const copy=el("div");copy.append(el("strong","",`${lever.character.name} · ${lever.kind} ${lever.from} → ${lever.to}`),el("p","row-detail",`+${fmt(lever.gain)} pts · ${lever.steps} niveau(x)`));li.append(copy);list.append(li);}grouped.append(list);}
  rows.append(grouped);root.append(rows);
  if(analysis.unparsed.length){const unknown=el("details","panel-card");unknown.append(el("summary","","Lignes non analysées · "+analysis.unparsed.length));const list=el("ul","action-list");for(const item of analysis.unparsed){const li=el("li","action-row");li.append(el("strong","",item.label||item.labelEn||"Objectif"),el("p","row-detail",reasonLabel(item.reason)));list.append(li);}unknown.append(list);root.append(unknown);}
  renderObjectives();renderPlan();
}
function reasonLabel(code){const labels={unknownName:"Nom absent du catalogue",ambiguousName:"Nom ambigu",unknownResource:"Ressource non reconnue",unknownIon:"Ion non reconnu",unknownMode:"Mode inconnu",unknownForm:"Forme non reconnue",multiMethod:"Plusieurs méthodes combinées",meta:"Points issus d’un sous-événement",earn:"Gain non calculable"};return labels[code]||"Données indisponibles";}
function renderObjectives(){
  const target=$("objectives-view");target.replaceChildren();
  const analysis=state.analysis;
  if(!analysis?.supported){target.append(el("p","warning",!state.roster?"Roster indisponible : objectifs terminés et actions personnelles ne peuvent pas être confirmés.":"Choisis un événement dont les données de scoring sont disponibles."));return;}
  target.append(objectiveSection("Terminés confirmés",analysis.actions.filter(item=>item.status==="done"),"Aucun objectif terminé confirmé."));
  target.append(objectiveSection("Restants ou inconnus",analysis.actions.filter(item=>item.status!=="done"),"Aucun objectif restant connu."));
  if(analysis.event.progressState==="unknown")target.append(el("p","warning","Le score global et les compteurs utiles ne sont pas fournis. Le plan ne leur substitue pas zéro."));
  if(analysis.event.progressState==="partial")target.append(el("p","warning",`${fmt(analysis.event.reportedActionPoints)} points de compteurs sont lisibles, mais au moins un compteur manque : le total et les paliers restent inconnus.`));
}
function resourcePlanLabel(item){
  const names=(item.resources||[item.resource]).filter(Boolean).map(key=>RESOURCES[key]?.label?.fr||key).join(" / ");
  return `${fmt(item.units)} ${names}${item.perDay?` · ${fmt(item.perDay)} par jour`:""}${item.points?` · ${fmt(item.points)} pts`:""}`;
}
function renderPlan(){
  const target=$("plan-view");target.replaceChildren();const analysis=state.analysis;
  if(!analysis?.supported){target.append(el("p","warning","Analyse personnelle indisponible pour l’événement sélectionné."));return;}
  if(analysis.plan?.status==="unavailable"){
    const message=analysis.event.progressState==="partial"?"Les compteurs de score sont incomplets. Le plan Maddoxx reste disponible, mais aucun total ni palier n’est calculé à partir de cette somme partielle.":"Données de score ou de paliers indisponibles. Le plan Maddoxx reste chargé, mais aucun palier ni coût n’est estimé à partir d’une valeur manquante.";
    target.append(el("p","warning",message));
    return;
  }
  const plan=analysis.plan,summary=el("section","panel-card");summary.append(el("h3","","Projection gratuite"));
  if(analysis.event.progressState==="estimated")summary.append(el("p","warning","Le score de départ est estimé en additionnant les compteurs plafonnés Maddoxx fournis; les paliers réellement réclamés restent inconnus."));
  summary.append(el("p","",`${fmt(plan.secure.points)} points sécurisés · palier de score ${fmt(plan.secure.tier)} · ${fmt(plan.planDays)} jour(s) de planification`));
  summary.append(el("p","row-detail",`${fmt(plan.secure.fromDoable)} pts par actions gratuites connues · ${fmt(plan.secure.fromEnergy)} pts d’énergie disponible`));
  if(analysis.event.completedTierKnown)summary.append(el("p","row-detail",`Paliers terminés confirmés : ${fmt(analysis.event.currentTier)}`));
  else summary.append(el("p","row-detail","Paliers terminés : données indisponibles; la projection de score ne les présente pas comme réclamés."));
  target.append(summary);
  const planCard=el("section","panel-card");planCard.append(el("h3","","Prochains paliers atteignables"));
  if(!plan.steps.length)planCard.append(el("p","ok","Le dernier palier est déjà sécurisé selon le score connu."));
  for(const step of plan.steps){
    const box=el("div","plan-step");box.append(el("h4","",`Palier ${step.tier} · ${fmt(step.goal)} pts · manque ${fmt(step.missing)}`));
    if(step.leverPoints)box.append(el("p","",`+${fmt(step.leverPoints)} pts par améliorations possibles du roster`));
    if(step.verdict)box.append(el("p",step.verdict==="feasible"?"ok":"warning",step.verdict==="feasible"?"Atteignable avec le stock déclaré ou l’inventaire reçu.":step.verdict==="need"?"Stock à déclarer pour chiffrer cette étape.":"Stock connu partiel; le reste est un besoin, pas une recommandation."));
    for(const spend of step.spends||[])box.append(el("p","row-detail",`${spend.fromStock?"Dans le stock connu : ":"Besoin : "}${resourcePlanLabel(spend)}`));
    for(const spend of step.shortfall||[])box.append(el("p","row-detail",`À prévoir : ${resourcePlanLabel(spend)}`));
    for(const alternative of step.alternatives||[])box.append(el("p","row-detail",`Alternative : ${resourcePlanLabel(alternative)}`));
    if(step.uncovered)box.append(el("p","warning",`${fmt(step.uncovered)} pts restent non couverts par les lignes connues.`));
    planCard.append(box);
  }
  target.append(planCard);
  if(analysis.offRoster.length){const outside=el("section","panel-card");outside.append(el("h3","","Sources hors roster"));for(const item of analysis.offRoster)outside.append(el("p","row-detail",`${item.label} · ${fmt(item.points)} pts`));target.append(outside);}
}
function resourceLabel(key){return RESOURCES[key]?.label?.fr||key;}
function renderStock(){
  const root=$("stock-view");root.replaceChildren();
  if(!state.eventsEn.length){root.append(el("p","warning","Les événements personnels n’ont pas été reçus; la liste des ressources demandées est indisponible."));return;}
  const used=resourcesInUse(state.observations,[...state.skipped]);
  if(!used.length){root.append(el("p","muted","Aucune ressource de stock n’est requise par les événements actifs non ignorés."));return;}
  const intro=el("p",state.inventory?"muted":"warning",state.inventory?"Inventaire autorisé. Une ressource absente de la réponse n’est pas assimilée à zéro.":`Inventaire indisponible${state.inventoryReason?" · "+errorText(state.inventoryReason):""}. Tu peux déclarer ton stock.`);root.append(intro);
  for(const key of used){
    const card=el("article","stock-card"),head=el("h3","",resourceLabel(key));
    const involved=state.observations.filter(item=>item.uses.includes(key)).map(item=>displayName(getEvent(item.id,"fr")||getEvent(item.id,"en")||{}));
    const info=el("p","",involved.length?"Demandé par : "+involved.join(", "):"Demandé par les événements actifs.");card.append(head,info);
    const apiValue=inventoryValue(key),saved=stockEstimate(key);
    const shown=apiValue!==null?apiValue:saved?.value??null;
    const source=apiValue!==null?"Inventaire Scopely":saved?.source==="estimated"?"Estimation Maddoxx":saved?.source==="declared"?"Déclaration locale":"Données indisponibles";
    const sourceLine=el("p","row-detail",`${source}${saved?.declaredAt?` · déclarée le ${eventDate(saved.declaredAt/1000)}`:""}${saved?.spentSince?` · ${fmt(saved.spentSince)} unités dépensées estimées`:""}${saved?.earnedSince?` · ${fmt(saved.earnedSince)} reçues`:""}`);card.append(sourceLine);
    if(saved?.dataUnavailable)card.append(el("p","warning","Les compteurs Scopely sont incomplets : l’estimation des dépenses est indisponible. La planification utilise la dernière déclaration locale."));
    if(saved?.declaredAt&&Date.now()-saved.declaredAt>86400000)card.append(el("p","warning","Déclaration de plus de 24 h : vérifie ou confirme l’estimation."));
    const row=el("div","stock-row"),label=el("label","",shown===null?"Quantité à déclarer":"Quantité connue / remplacement manuel");
    const input=el("input");input.type="text";input.inputMode="decimal";input.autocomplete="off";input.placeholder=shown===null?"Données indisponibles":"";input.value=state.drafts[key]??"";input.dataset.stockKey=key;label.append(input);row.append(label);
    const save=el("button","button button-secondary",shown===null?"Enregistrer":"Déclarer / corriger");save.type="button";save.dataset.action="save-stock";save.dataset.resource=key;row.append(save);
    if(saved&&saved.source==="estimated") {const confirm=el("button","small-button","Valider l’estimation");confirm.type="button";confirm.dataset.action="confirm-stock";confirm.dataset.resource=key;row.append(confirm);}
    card.append(row);root.append(card);
  }
  if(state.loadingStock)root.prepend(el("p","muted","Lecture des événements actifs pour mettre à jour les récompenses et les compteurs…"));
  if(state.history.length){const details=el("details","stock-card");details.append(el("summary","","Historique des déclarations · "+state.history.length));for(const entry of state.history.slice(-20).reverse())details.append(el("p","row-detail",`${resourceLabel(entry.resource)} · ${eventDate(entry.at/1000)} · ${fmt(entry.estimated)} → ${fmt(entry.declared)}`));root.append(details);}
}
async function refreshLedger(){
  if(state.loadingStock)return;state.loadingStock=true;renderStock();
  try{
    const events=activeEvents().filter(event=>event.type==="milestone");
    for(let start=0;start<events.length;start+=3){
      const batch=events.slice(start,start+3).filter(event=>!state.rewardDetails.has(String(event.id)));
      await Promise.all(batch.map(async event=>{const pair=await loadDetailPair(event.id);if(pair.en)state.rewardDetails.set(String(event.id),rewardsFrom(pair.en));}));
    }
    buildObservations();
  }finally{state.loadingStock=false;renderStock();}
}
function declareStock(key,input,confirm=false){
  const result=parseQuantity(input);if(result.error){banner(`Quantité non reconnue pour ${resourceLabel(key)}.`,"error");return;}
  const prior=state.stock[key]?.ledger;
  const estimate=prior?estimateResource(refreshResource(prior,key,state.observations)):null;
  const value=confirm?(estimate?.value??result.value):result.value;
  state.history.push({resource:key,at:Date.now(),estimated:estimate?.value??null,declared:value});
  state.stock[key]={...(state.stock[key]||{}),ledger:declareResource({resource:key,value,now:Date.now(),observations:state.observations})};
  delete state.drafts[key];saveLocal();renderStock();
  if(state.selectedId){state.analysis=currentAnalysis();renderSelected(getEvent(state.selectedId,"en"),getEvent(state.selectedId,"fr"),state.analysis);}
}
function renderConnection(status){
  const box=$("connection");box.replaceChildren();
  if(status.status!=="connected"){
    box.append(el("strong","","Connexion requise"),el("p","row-detail",errorText({body:{reason:status.reason}})));
    const link=el("a","button","Autoriser LoSP avec Scopely");link.href="/login/captain?returnTo=events-planner";box.append(link);return;
  }
  const required=["m3p.f.pr.act","m3p.f.pr.ros"],missing=required.filter(scope=>!status.scopes.includes(scope));
  const line=el("p","",missing.length?"Événements ou roster : accès manquant.":"Session Scopely active · données lues à la demande.");
  box.append(line);
  if(missing.length){const link=el("a","button","Réautoriser l’accès requis");link.href="/login/captain?returnTo=events-planner&reauthorize=1";box.append(link);}
  if(!status.scopes.includes("m3p.f.pr.inv"))box.append(el("p","row-detail","Inventaire non autorisé : le plan utilisera les déclarations de stock disponibles."));
}
async function loadOverview(forceRefresh=false){
  state.refreshing=forceRefresh;
  if(forceRefresh){state.details.clear();state.rewardDetails.clear();}
  $("refresh").disabled=true;$("event-count").textContent="Chargement des événements personnels…";
  const session=await api({resource:"status"}).catch(error=>({status:"disconnected",reason:error?.body?.reason||error?.body?.error||"session-unavailable"}));
  renderConnection(session);if(session.status!=="connected"){state.refreshing=false;$("refresh").disabled=false;return;}
  const fetchSafe=async params=>{try{return await api({...params,...(forceRefresh?{refresh:"1"}:{})});}catch(error){return {error};}};
  const [english,french,roster,consumables,isoitems,catalogResult]=await Promise.all([
    fetchSafe({resource:"events",lang:"en"}),fetchSafe({resource:"events",lang:"fr"}),
    fetchSafe({resource:"roster",lang:"fr"}),fetchSafe({resource:"inventory",itemType:"CONSUMABLE"}),
    fetchSafe({resource:"inventory",itemType:"ISOITEM"}),loadCatalog().then(()=>({ok:true}))
  ]);
  if(english.error){banner("Les événements personnels sont indisponibles · "+errorText(english.error),"error");$("event-count").textContent="Événements indisponibles";$("events-list").replaceChildren(el("p","warning","Vérifie la session et les scopes d’événements."));state.refreshing=false;$("refresh").disabled=false;return;}
  state.eventsEn=Array.isArray(english.data)?english.data:[];state.eventsFr=Array.isArray(french.data)?french.data:[];
  state.roster=Array.isArray(roster.data)?roster.data:null;
  const invOk=[consumables,isoitems].some(result=>!result.error);
  state.inventory=invOk?{}:null;state.inventoryReason=consumables.error||isoitems.error||null;
  for(const result of [consumables,isoitems])if(Array.isArray(result.data))for(const item of result.data){
    const id=item?.item??item?.id,quantity=typeof item?.quantity==="number"?item.quantity:Number(item?.quantity);
    if(typeof id==="string"&&Number.isFinite(quantity))state.inventory[id]=quantity;
  }
  buildObservations();renderEvents();
  if(state.selectedId)showSelected(state.selectedId);
  if(state.characters.length===0)banner("Catalogue de personnages indisponible. Les objectifs restent visibles, mais les noms ou traits non résolus ne seront pas évalués.","warning");
  else renderConnection(session);
  state.refreshing=false;$("refresh").disabled=false;
}

$("refresh").addEventListener("click",()=>loadOverview(true));
document.querySelectorAll(".planner-tabs [role=tab]").forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.tab)));
$("events-list").addEventListener("click",event=>{
  const button=event.target.closest("[data-action]");if(!button)return;
  const id=button.dataset.eventId;
  if(button.dataset.action==="select")showSelected(id);
  if(button.dataset.action==="skip"){state.skipped.add(id);saveLocal();if(state.selectedId===id)state.selectedId=null;renderEvents();}
});
$("skipped-list").addEventListener("click",event=>{const button=event.target.closest('[data-action="restore"]');if(button){state.skipped.delete(button.dataset.eventId);saveLocal();renderEvents();}});
$("selected-event").addEventListener("click",event=>{const button=event.target.closest("[data-action]");if(!button)return;const id=button.dataset.eventId;if(button.dataset.action==="skip")state.skipped.add(id);else if(button.dataset.action==="restore")state.skipped.delete(id);saveLocal();renderEvents();});
$("refresh-stock").addEventListener("click",refreshLedger);
$("stock-view").addEventListener("input",event=>{const input=event.target.closest("[data-stock-key]");if(input)state.drafts[input.dataset.stockKey]=input.value;});
$("stock-view").addEventListener("click",event=>{
  const button=event.target.closest("[data-action]");if(!button)return;
  const key=button.dataset.resource;
  if(button.dataset.action==="save-stock")declareStock(key,state.drafts[key]||"");
  if(button.dataset.action==="confirm-stock")declareStock(key,String(estimateResource(state.stock[key].ledger).value),true);
});
loadLocal();loadOverview();
