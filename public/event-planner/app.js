import { analyzeMilestoneEvent } from "./lib/event-analysis.js";
import { RESOURCES, classifyObjective, observeEvent, resourcesInUse, declareResource, refreshResource, estimateResource, parseQuantity } from "./lib/index.js";
import { installCalendarSnapshot, currentCalendarGroups, mergeCalendarEvent, calendarGroups } from "./lib/calendar.js";

const $=id=>document.getElementById(id);
const API="/admin/api/event-planner";
const CATALOG_BASE="https://keryas777.github.io/msf/data/";
const STORAGE_KEY="losp-event-planner-v1";
const number=new Intl.NumberFormat("fr-FR");
const date=new Intl.DateTimeFormat("fr-FR",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Paris"});
const syncDate=new Intl.DateTimeFormat("fr-FR",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Paris"});
const state={eventsEn:[],eventsFr:[],calendarEvents:[],eligibleEventIds:null,calendarError:null,roster:null,characters:[],inventory:null,inventoryReason:null,inventoryTypes:{},skipped:new Set(),stock:{},history:[],details:new Map(),rewardDetails:new Map(),selectedId:null,analysis:null,observations:[],drafts:{},tab:"events",loadingStock:false,refreshing:false,detailLoading:false,listScrollY:0};

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
  if(error?.body?.error==="scope-or-access-denied")return "Scopely a refusé cette requête. Consulte le diagnostic technique.";
  if(error?.body?.error==="provider-error")return "Scopely a répondu avec une erreur. Consulte le diagnostic technique.";
  return "Donnée indisponible pour le moment.";
}
function renderDiagnostic(error){
  const body=error?.body||{},detail=body.diagnostic||{};
  const panel=el("details","planner-diagnostic"),summary=el("summary","","Diagnostic technique · propriétaire");
  const list=el("dl","planner-diagnostic-list");
  const endpoint=typeof detail.endpoint==="string"&&/^\/player\/v1\/[A-Za-z0-9_{}\/-]+$/.test(detail.endpoint)?detail.endpoint:"/player/v1/events";
  const httpStatus=Number.isInteger(error?.status)?error.status:"non reçu";
  const providerStatus=Number.isInteger(detail.httpStatus)?detail.httpStatus:"non reçu";
  const rawCode=detail.providerCode||detail.error||body.error;
  const code=typeof rawCode==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(rawCode)?rawCode:"non fourni";
  const rows=[["Ressource",endpoint],["HTTP Worker",httpStatus],["HTTP Scopely",providerStatus],
    ["Code",code],["Langue",["en","fr"].includes(detail.lang)?detail.lang:"—"],
    ["Page",Number.isSafeInteger(detail.page)&&detail.page>0?detail.page:"—"]];
  for(const [label,value] of rows){list.append(el("dt","",label),el("dd","",value));}
  panel.append(summary,list);return panel;
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
function scrollImmediately(top){
  const root=document.documentElement,previous=root.style.scrollBehavior;
  root.style.scrollBehavior="auto";window.scrollTo(0,top);
  requestAnimationFrame(()=>{root.style.scrollBehavior=previous;});
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
async function loadCalendar(){
  try{
    const response=await fetch(CATALOG_BASE+"evenements-snapshot.json",{cache:"no-store",mode:"cors"});
    if(!response.ok)throw new Error("catalog-unavailable");
    const installed=installCalendarSnapshot(await response.json());
    state.calendarEvents=installed.events;state.eligibleEventIds=installed.eligibleEventIds;state.calendarError=null;
    return installed;
  }catch(error){state.calendarEvents=[];state.calendarError=error;return null;}
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
function calendarView(){
  const groups=currentCalendarGroups(state.calendarEvents,state.eligibleEventIds);
  return Object.fromEntries(Object.entries(groups).map(([key,events])=>[key,events.map(event=>mergeCalendarEvent(event,getEvent(event.id,"en")))]));
}
function activeEvents(){return Object.values(calendarView()).flat();}
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
function inventoryItemId(row){
  const item=row?.item;
  return typeof item==="string"?item:typeof item?.id==="string"?item.id:typeof row?.id==="string"?row.id:null;
}
function inventoryRows(row){return Array.isArray(row?.data)?row.data:[];}
function installInventoryResult(type,result){
  if(result?.error){
    const previous=state.inventoryTypes[type];
    state.inventoryTypes[type]=previous?.rows?{...previous,refreshError:result.error}:{error:result.error,rows:[],retrievedAt:null,asOf:null,cache:null};
    return;
  }
  const rows=inventoryRows(result);
  state.inventoryTypes[type]={rows,retrievedAt:result.retrievedAt||null,asOf:result.upstream?.asOf||null,
    unchanged:Boolean(result.upstream?.unchanged),cache:result.cache||null,error:null};
  for(const item of rows){
    const id=inventoryItemId(item),quantity=typeof item?.quantity==="number"?item.quantity:Number(item?.quantity);
    if(id&&Number.isFinite(quantity))state.inventory[id]=quantity;
  }
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
  const groups=calendarView(),events=Object.values(groups).flat(),visible=events.filter(event=>!state.skipped.has(String(event.id)));
  $("event-count").textContent=state.calendarError?"Catalogue public LoSP indisponible · liste masquée":
    `${visible.length} événement${visible.length===1?"":"s"} affiché${visible.length===1?"":"s"} · ${events.length-visible.length} ignoré${events.length-visible.length===1?"":"s"}`;
  const list=$("events-list");list.replaceChildren();
  if(state.calendarError){list.append(el("div","empty-card","Le catalogue utilisé par la page publique n’a pas pu être chargé. La liste personnelle non filtrée reste masquée."));}
  else if(!visible.length){list.append(el("div","empty-card",events.length?"Tous les événements LoSP en cours sont ignorés.":"Aucun événement LoSP n’est actuellement en cours."));}
  for(const group of calendarGroups){
    const entries=(groups[group.key]||[]).filter(event=>!state.skipped.has(String(event.id)));
    if(!entries.length)continue;
    const section=el("section","ev-calendar-group"),head=el("div","ev-calendar-group-head");
    head.append(el("h3","ev-calendar-group-title",group.icon+" "+group.label),el("span","ev-calendar-group-count",entries.length));
    const grid=el("div","ev-grid");
    for(const event of entries){
      const id=String(event.id),localized=getEvent(id,"fr")||event,card=el("article","ev-card planner-event-card");
      card.dataset.eventId=id;card.setAttribute("aria-current",String(id===String(state.selectedId)));
      const command=event.type==="milestone"&&event.locationHints?.includes("lohub_wrapper");
      const candidates=command?[event.icon]:[event.cardArt,event.popupArt,...(Array.isArray(event.hubArt)?event.hubArt:[]),event.icon];
      const imageUrl=candidates.find(url=>typeof url==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\/(?:key_art|imgs)\/[\w.%-]+\.(?:png|jpg|jpeg|webp)$/i.test(url))||"";
      const cover=el("div","ev-cover"+(command?" ev-cover--command":"")+(!imageUrl?" ev-cover--placeholder":""));
      const fallback=el("span","ev-cover-fallback",({milestone:"🏆",episodic:"⚔️",pickYourPoison:"🔥"})[event.type]||"✦");
      fallback.hidden=Boolean(imageUrl);cover.append(fallback);
      if(imageUrl){const image=el("img",command?"ev-command-icon":imageUrl.includes("/imgs/")?"ev-icon-img":"");image.alt="";image.loading="lazy";image.decoding="async";image.src=imageUrl;
        image.addEventListener("error",()=>{image.remove();fallback.hidden=false;cover.className+=" ev-cover--placeholder";},{once:true});cover.append(image);}
      const copy=el("div","ev-card-copy"),top=el("div","ev-card-top");top.append(el("span","ev-category",group.label));
      if(event.type==="milestone")top.append(el("span","ev-scope",event.milestone?.type==="alliance"?"Alliance":"Solo"));
      if(event.calendarVariantKind==="tiers")top.append(el("span","ev-tier-tag",`${event.calendarVariants.length} paliers`));
      copy.append(top,el("h3","",displayName(localized)));
      const subtitle=stripTags(localized.subName||localized.details||"");if(subtitle)copy.append(el("p","ev-sub",subtitle));
      const dayEnd=Math.max(0,Math.ceil((Number(event.endTime)*1000-Date.now())/86400000));
      copy.append(el("div","ev-dates",`${eventDate(event.startTime)} → ${eventDate(event.endTime)}`));
      const actions=el("div","ev-card-actions"),relative=el("span","ev-relative",`Fin dans ${dayEnd} j`);
      const select=el("button","ev-detail-btn","Analyser  ›");select.type="button";select.dataset.action="select";select.dataset.eventId=id;
      const skip=el("button","planner-skip-button","Ignorer");skip.type="button";skip.dataset.action="skip";skip.dataset.eventId=id;skip.setAttribute("aria-label","Ignorer "+displayName(event));
      actions.append(relative,select,skip);copy.append(actions);card.append(cover,copy);grid.append(card);
    }
    section.append(head,grid);list.append(section);
  }
  const skippedList=$("skipped-list");skippedList.replaceChildren();
  const skipped=events.filter(event=>state.skipped.has(String(event.id)));
  if(!skipped.length){skippedList.append(el("p","muted","Aucun événement ignoré."));}
  for(const event of skipped){const row=el("div","event-card");row.append(el("span","",displayName(getEvent(event.id,"fr")||event)));const restore=el("button","small-button","Réintégrer");restore.type="button";restore.dataset.action="restore";restore.dataset.eventId=String(event.id);row.append(restore);skippedList.append(row);}
  if(state.selectedId&&!events.some(event=>String(event.id)===String(state.selectedId))){state.selectedId=null;$("selected-event").hidden=true;$("event-list-view").hidden=false;}
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
  state.listScrollY=window.scrollY;state.selectedId=String(id);state.detailLoading=true;
  const root=$("selected-event");$("event-list-view").hidden=true;root.hidden=false;root.replaceChildren();
  const bar=el("div","planner-detail-bar"),back=el("button","planner-back","‹  Liste des événements");
  back.type="button";back.dataset.action="back-list";bar.append(back,el("span","planner-detail-state","Chargement des détails personnels…"));
  const loading=el("div","loading-state");loading.setAttribute("role","status");loading.setAttribute("aria-live","polite");
  loading.append(el("span","loading-spinner"),el("span","","Récupération de la progression, des objectifs et des récompenses…"));
  root.append(bar,loading);scrollImmediately(0);
  const pair=await loadDetailPair(id);state.detailLoading=false;
  if(state.selectedId!==String(id))return;
  const curated=activeEvents().find(item=>String(item.id)===String(id));
  const event=mergeCalendarEvent(curated,pair.en||getEvent(id,"en"));
  const fr=mergeCalendarEvent(curated,pair.fr||getEvent(id,"fr"))||event;
  if(!event){root.replaceChildren(bar,el("p","error","Les détails de cet événement n’ont pas été reçus."));return;}
  const analysis=currentAnalysis();state.analysis=analysis;
  renderSelected(event,fr,analysis,pair.error);
  if(state.tab==="objectives")renderObjectives();if(state.tab==="plan")renderPlan();if(state.tab==="stock")renderStock();
}
function returnToList(){
  $("selected-event").hidden=true;$("event-list-view").hidden=false;
  requestAnimationFrame(()=>scrollImmediately(state.listScrollY));
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
function renderSelected(event,fr,analysis,detailError=null){
  const host=$("selected-event");host.replaceChildren();
  const bar=el("div","planner-detail-bar"),back=el("button","planner-back","‹  Liste des événements");
  back.type="button";back.dataset.action="back-list";bar.append(back,el("span","planner-detail-state","Fiche d’événement"));
  const root=el("div","planner-detail-content");host.append(bar,root);
  const hero=el("header","planner-detail-hero"),imageUrl=event.cardArt||event.popupArt||event.icon;
  if(typeof imageUrl==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\/(?:key_art|imgs)\/[\w.%-]+\.(?:png|jpg|jpeg|webp)$/i.test(imageUrl)){const img=el("img");img.alt="";img.src=imageUrl;img.loading="lazy";img.decoding="async";hero.append(img);}
  const copy=el("div","planner-detail-hero-copy");copy.append(el("span","ev-category",eventTypeLabel(event)),el("h2","",displayName(fr||event)),el("p","",`Fin ${eventDate(event.endTime)}`));hero.append(copy);root.append(hero);
  const actions=el("div","detail-action-bar"),skip=el("button","button button-secondary",state.skipped.has(String(event.id))?"Réintégrer":"Ignorer cet événement");
  skip.type="button";skip.dataset.action=state.skipped.has(String(event.id))?"restore":"skip";skip.dataset.eventId=String(event.id);
  const planLink=el("button","button","Planifier cet événement →");planLink.type="button";planLink.dataset.action="open-plan";actions.append(planLink,skip);root.append(actions);
  if(detailError){const failure=el("section","panel-card");failure.append(el("p","warning","Les détails personnels complets n’ont pas été chargés. Les éléments présents dans la liste sont conservés, sans confirmer les données manquantes."),renderDiagnostic(detailError));root.append(failure);}
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
  const selected=state.selectedId&&(getEvent(state.selectedId,"fr")||getEvent(state.selectedId,"en")||activeEvents().find(item=>String(item.id)===String(state.selectedId)));
  $("plan-event-name").textContent=selected?displayName(selected):"Aucun événement sélectionné";
  $("plan-back").hidden=!selected;
  if(!analysis?.supported){target.append(el("p","warning","Les données de scoring nécessaires à cette planification ne sont pas disponibles pour l’événement sélectionné."));return;}
  if(analysis.plan?.status==="unavailable"){
    const message=analysis.event.progressState==="partial"?"Une partie des compteurs manque. Le score total et la faisabilité des paliers ne sont pas déterminés à partir de ce relevé.":"Le score ou les paliers n’ont pas été fournis. Aucune quantité manquante n’est remplacée par zéro.";
    target.append(el("p","warning",message));return;
  }
  const plan=analysis.plan,event=analysis.event,score=event.points,scoreKnown=Number.isFinite(score)&&["available","estimated"].includes(event.progressState);
  const uncertain=event.progressState==="partial"||event.progressState==="unknown"||!Array.isArray(state.roster)||
    analysis.unparsed.length>0||analysis.actions.some(action=>action.status==="unknown");
  const scoreSource=event.progressState==="available"?"Progression personnelle fournie par Scopely":
    event.progressState==="estimated"?"Estimation Maddoxx · somme des compteurs plafonnés":"Progression indisponible";
  const nextTier=scoreKnown?analysis.tiers.filter(tier=>tier.goal>score).sort((a,b)=>a.goal-b.goal)[0]:null;
  const summary=el("section","plan-event-card");
  summary.append(el("h3","","Événement planifié"),el("p","plan-event-name",displayName(selected||getEvent(state.selectedId,"en")||{})));
  const metrics=el("div","plan-score-grid");
  const metric=(label,value)=>{const cell=el("div","plan-score");cell.append(el("span","plan-score-label",label),el("strong","",value));return cell;};
  metrics.append(metric("Score actuel",scoreKnown?`${fmt(score)} pts`:"Données indisponibles"));
  metrics.append(metric("Dernier palier terminé",event.completedTierKnown?fmt(event.currentTier):"Non confirmé"));
  metrics.append(metric("Temps de planification",`${fmt(plan.planDays)} jour${plan.planDays===1?"":"s"}`));
  metrics.append(metric("Score sécurisé projeté",`${fmt(plan.secure.points)} pts`));summary.append(metrics);
  summary.append(el("p","stock-note",`Provenance du score : ${scoreSource}. Le score projeté ajoute ${fmt(plan.secure.fromDoable)} pts d’actions gratuites identifiées et ${fmt(plan.secure.fromEnergy)} pts d’énergie disponible.`));
  if(nextTier){
    const missing=Math.max(0,nextTier.goal-score),progress=Math.max(0,Math.min(100,score/nextTier.goal*100));
    const progressWrap=el("div","plan-progress-wrap");progressWrap.append(el("p","",`Palier ${nextTier.tier} · ${fmt(nextTier.goal)} points`));
    const track=el("div","plan-progress-track");track.setAttribute("role","progressbar");track.setAttribute("aria-label",`Progression vers le palier ${nextTier.tier}`);track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(nextTier.goal));track.setAttribute("aria-valuenow",String(Math.min(score,nextTier.goal)));
    const fill=el("span");fill.style.width=`${progress}%`;track.append(fill);progressWrap.append(track);
    const label=el("div","plan-progress-label");label.append(el("span","",`${fmt(score)} / ${fmt(nextTier.goal)} pts`),el("strong","",`${fmt(missing)} pts manquants`));progressWrap.append(label);
    if(scoreKnown){const pace=Math.ceil(missing/Math.max(1,plan.planDays));progressWrap.append(el("p","row-detail",`Rythme moyen à obtenir : ${fmt(pace)} points par jour avant la fin.`));}
    else progressWrap.append(el("p","row-detail","Le rythme quotidien reste indisponible tant que le score actuel n’est pas confirmé."));
    if(nextTier.rewards?.length){const rewards=el("div","plan-rewards");for(const reward of nextTier.rewards){const item=el("span","plan-reward");addSafeImage(item,reward.icon,"reward-icon");item.append(el("span","",`${fmt(reward.quantity)} ${reward.name}`));rewards.append(item);}progressWrap.append(rewards);}
    summary.append(progressWrap);
  }else if(scoreKnown)summary.append(el("p","ok",event.completedTierKnown?"Le score connu a dépassé les paliers fournis; le dernier palier réclamé reste celui confirmé par Scopely.":"Aucun palier suivant n’est fourni dans les données reçues."));
  if(event.completedTierKnown)summary.append(el("p","stock-note",`Paliers terminés confirmés par Scopely : jusqu’au palier ${fmt(event.currentTier)}.`));
  else summary.append(el("p","warning","Le nombre de paliers réclamés n’est pas fourni. Le score ne sert pas à inventer un palier terminé."));
  target.append(summary);

  const tierPanel=el("section","panel-card");tierPanel.append(el("h3","","Paliers supplémentaires envisageables"));
  if(!plan.steps.length)tierPanel.append(el("p","muted","Aucun palier supérieur n’est présent dans les données reçues."));
  for(const step of plan.steps){
    const stepUnknown=uncertain||Number(step.uncovered||0)>0;
    const ready=!stepUnknown&&(step.coveredByLevers||step.verdict==="feasible");
    const potential=!ready&&!stepUnknown&&(step.verdict==="need"||step.verdict==="short"||step.spends?.length||step.shortfall?.length);
    const stateKey=ready?"ready":potential?"potential":"unknown";
    const status=ready?"Atteignable avec les données connues":potential?"Potentiel · ressources à réunir":"Faisabilité inconnue";
    const box=el("article","plan-tier"),head=el("div","plan-tier-head");head.append(el("strong","",`Palier ${step.tier} · ${fmt(step.goal)} pts`),el("span","plan-tier-state plan-tier-state--"+stateKey,status));box.append(head);
    box.append(el("p","",`${fmt(step.missing)} points manquent après les actions gratuites identifiées.`));
    if(step.leverPoints)box.append(el("p","",`Le roster peut apporter jusqu’à ${fmt(step.leverPoints)} pts par les améliorations listées.`));
    for(const spend of step.spends||[])box.append(el("p","row-detail",`${spend.fromStock?"Pris en compte dans le stock connu : ":"Ressource nécessaire : "}${resourcePlanLabel(spend)}`));
    for(const spend of step.shortfall||[])box.append(el("p","row-detail",`À prévoir : ${resourcePlanLabel(spend)}`));
    for(const alternative of step.alternatives||[])box.append(el("p","row-detail",`Alternative : ${resourcePlanLabel(alternative)}`));
    if(step.uncovered>0)box.append(el("p","warning",`${fmt(step.uncovered)} pts ne sont couverts par aucune action ou ressource actuellement identifiée.`));
    tierPanel.append(box);
  }
  target.append(tierPanel);

  const actions=el("section","panel-card");actions.append(el("h3","","Actions possibles pour gagner des points"));
  const actionable=analysis.actions.filter(action=>action.status!=="done");
  if(!actionable.length)actions.append(el("p","muted","Aucune action restante n’est reconnue dans les données de scoring."));
  else{const list=el("ul","action-list");for(const group of analysis.groups){const representative=analysis.actions.find(action=>group.actions.includes(action.index));if(representative)addActionRow(list,{...representative,status:group.status,fightsLeft:group.fightsLeft});}actions.append(list);}
  if(plan.levers?.length){const list=el("ul","action-list");for(const lever of plan.levers){const row=el("li","action-row");addSafeImage(row,lever.character?.portrait,"character-portrait");row.append(el("span","action-row__copy",`${lever.character?.name||"Personnage"} · ${lever.kind} ${lever.from} → ${lever.to} · +${fmt(lever.points)} pts`));list.append(row);}actions.append(el("h4","","Améliorations de roster à envisager"),list);}
  target.append(actions);
  if(uncertain){const notes=[];if(event.progressState!=="available")notes.push("le score n’est pas un total Scopely confirmé");if(!Array.isArray(state.roster))notes.push("le roster est indisponible");if(analysis.unparsed.length)notes.push(`${analysis.unparsed.length} ligne(s) de scoring ne sont pas interprétées`);if(analysis.actions.some(action=>action.status==="unknown"))notes.push("certaines conditions restent inconnues");
    const warning=el("section","plan-warning-group");warning.append(el("strong","","À vérifier avant de viser un palier"));const list=el("ul");for(const note of notes)list.append(el("li","",note));warning.append(list);target.append(warning);}
  if(analysis.offRoster.length){const outside=el("section","panel-card");outside.append(el("h3","","Objectifs hors roster connu"));for(const item of analysis.offRoster)outside.append(el("p","row-detail",`${item.label} · ${fmt(item.points)} pts`));target.append(outside);}
}
function resourceLabel(key){return RESOURCES[key]?.label?.fr||key;}
function resourceForItemId(id){return Object.values(RESOURCES).find(resource=>resource.itemId===id)||null;}
function inventoryItemName(item,id){
  const resource=resourceForItemId(id);
  if(resource?.names?.fr)return resource.names.fr;
  if(resource?.label?.fr)return resource.label.fr;
  const nested=typeof item?.item==="object"?item.item:{};
  return item?.name||nested.name||id||"Objet sans nom";
}
function renderSyncedInventory(){
  const target=$("synced-inventory");target.replaceChildren();
  if(!state.inventory){target.append(el("p","warning",`Inventaire non disponible${state.inventoryReason?" · "+errorText(state.inventoryReason):""}. Les quantités restent inconnues.`));return;}
  let count=0;
  for(const type of ["CONSUMABLE","ISOITEM"]){
    const snapshot=state.inventoryTypes[type]||{rows:[],error:null},section=el("div","inventory-type"),title=el("h4","",type==="CONSUMABLE"?"Objets consommables":"Objets ISO-8");
    if(snapshot.error)title.textContent+=` · indisponible`;
    else if(snapshot.retrievedAt)title.textContent+=` · vérifié ${syncDate.format(new Date(snapshot.retrievedAt))}${snapshot.unchanged?" · inchangé":""}`;
    section.append(title);
    if(snapshot.error){section.append(el("p","warning",errorText(snapshot.error)));target.append(section);continue;}
    if(snapshot.refreshError)section.append(el("p","warning",`Actualisation échouée; dernier inventaire conservé. ${errorText(snapshot.refreshError)}`));
    const rows=Array.isArray(snapshot.rows)?snapshot.rows:[];count+=rows.length;
    if(!rows.length){section.append(el("p","muted","Scopely a renvoyé 0 objet dans cette famille."));target.append(section);continue;}
    const list=el("div","inventory-list");
    for(const item of rows){
      const id=inventoryItemId(item),quantity=Number(item?.quantity),row=el("article","inventory-row"),icon=item?.icon||item?.item?.icon;
      if(typeof icon==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\//i.test(icon)){const img=el("img","inventory-icon");img.src=icon;img.alt="";img.loading="lazy";row.append(img);}
      else row.append(el("span","inventory-icon inventory-icon--empty","◈"));
      const copy=el("div");copy.append(el("strong","inventory-name",inventoryItemName(item,id)));
      if(id)copy.append(el("span","inventory-id",id));
      const resource=resourceForItemId(id);copy.append(el("span","inventory-source",resource?`Synchronisé · utilisé dans le plan (${resource.label?.fr||resource.names?.fr||resource.key})`:item?.name?"Nom transmis par Scopely · famille lang=none":"Libellé français non disponible dans les données reçues"));
      row.append(copy,el("strong","inventory-quantity",Number.isFinite(quantity)?fmt(quantity):"Quantité indisponible"));list.append(row);
    }
    section.append(list);target.append(section);
  }
  const dates=Object.values(state.inventoryTypes).map(item=>item?.retrievedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  const latest=dates.length?new Date(Math.max(...dates)):null;
  $("inventory-sync-status").textContent=latest?`${fmt(count)} objets reçus · dernière vérification ${syncDate.format(latest)}. Une absence de la réponse ne vaut pas zéro.`:
    "Aucun horodatage de synchronisation n’est disponible dans la réponse Scopely.";
}
function renderStock(){
  renderSyncedInventory();
  const root=$("stock-view");root.replaceChildren();const unknown=$("unavailable-stock");unknown.replaceChildren();
  const used=resourcesInUse(state.observations,[...state.skipped]);
  if(!state.eventsEn.length){root.append(el("p","warning","Les événements personnels n’ont pas été reçus; les ressources utilisées par le moteur ne peuvent pas être établies."));unknown.append(el("p","muted","Les quantités sont inconnues tant que les événements personnels restent indisponibles."));return;}
  if(!used.length)root.append(el("p","muted","Aucune ressource de stock n’est requise par les événements LoSP en cours."));
  for(const key of used){
    const card=el("article","stock-card");card.append(el("h3","",resourceLabel(key)));
    const involved=state.observations.filter(item=>item.uses.includes(key)).map(item=>displayName(getEvent(item.id,"fr")||getEvent(item.id,"en")||activeEvents().find(event=>String(event.id)===String(item.id))||{}));
    card.append(el("p","stock-note",involved.length?"Demandé par : "+[...new Set(involved)].join(", "):"Demandé par les événements en cours."));
    const apiValue=inventoryValue(key),saved=stockEstimate(key);
    if(apiValue!==null)card.append(el("p","ok",`Inventaire Scopely : ${fmt(apiValue)}. La synchronisation est conservée séparément de la saisie manuelle.`));
    if(saved){
      card.append(el("p","row-detail",`${saved.source==="estimated"?"Estimation Maddoxx":"Dernière déclaration manuelle"} : ${fmt(saved.value)}${saved.declaredAt?` · mise à jour ${syncDate.format(new Date(saved.declaredAt))}`:""}${saved.spentSince?` · ${fmt(saved.spentSince)} dépensées estimées`:""}${saved.earnedSince?` · ${fmt(saved.earnedSince)} reçues estimées`:""}`));
      if(saved.dataUnavailable)card.append(el("p","warning","Des compteurs Scopely manquent; les dépenses et le stock estimé ne sont pas confirmés."));
      if(saved.declaredAt&&Date.now()-saved.declaredAt>86400000)card.append(el("p","warning","Cette déclaration date de plus de 24 h; vérifie-la avant de planifier."));
    }
    const row=el("div","stock-row"),label=el("label","","Ta quantité manuelle");
    const input=el("input");input.type="text";input.inputMode="decimal";input.autocomplete="off";input.placeholder="Quantité inconnue";input.value=state.drafts[key]??"";input.dataset.stockKey=key;label.append(input);row.append(label);
    const save=el("button","button button-secondary","Enregistrer la déclaration");save.type="button";save.dataset.action="save-stock";save.dataset.resource=key;row.append(save);
    if(saved&&saved.source==="estimated"){const confirm=el("button","small-button","Confirmer cette estimation");confirm.type="button";confirm.dataset.action="confirm-stock";confirm.dataset.resource=key;row.append(confirm);}
    card.append(row);root.append(card);
    if(apiValue===null){
      const itemId=RESOURCES[key]?.itemId,unavailable=el("article","unknown-resource-row");
      unavailable.append(el("strong","",resourceLabel(key)),el("p","",saved?.source==="estimated"?`Estimation Maddoxx : ${fmt(saved.value)}. L’objet ${itemId||"correspondant"} n’a pas été reçu dans les familles synchronisées; cette estimation n’est pas un inventaire Scopely.`:saved?.source==="declared"?`Scopely n’a pas renvoyé ${itemId||"cet objet"}. La déclaration manuelle (${fmt(saved.value)}) reste une donnée séparée.`:`Scopely n’a pas renvoyé ${itemId||"cet objet"} dans les familles CONSUMABLE / ISOITEM. Quantité inconnue, jamais ramenée à zéro.`));unknown.append(unavailable);
    }
  }
  if(!used.length)unknown.append(el("p","muted","Aucune ressource de planification n’est identifiée pour les événements en cours."));
  if(state.loadingStock)root.prepend(el("p","muted","Lecture des détails d’événements pour actualiser les récompenses Maddoxx…"));
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
async function refreshInventory(){
  const button=$("refresh-inventory");button.disabled=true;$("inventory-sync-status").textContent="Actualisation des deux familles d’inventaire…";
  try{
    const safe=async itemType=>{try{return await api({resource:"inventory",itemType,refresh:"1"});}catch(error){return {error};}};
    const [consumables,isoitems]=await Promise.all([safe("CONSUMABLE"),safe("ISOITEM")]);
    installInventoryResult("CONSUMABLE",consumables);installInventoryResult("ISOITEM",isoitems);
    const hasKnown=Object.values(state.inventoryTypes).some(item=>Array.isArray(item.rows)&&!item.error);
    state.inventory=hasKnown?{}:null;state.inventoryReason=consumables.error||isoitems.error||null;
    if(state.inventory)for(const snapshot of Object.values(state.inventoryTypes))for(const item of snapshot.rows||[]){
      const id=inventoryItemId(item),quantity=typeof item?.quantity==="number"?item.quantity:Number(item?.quantity);
      if(id&&Number.isFinite(quantity))state.inventory[id]=quantity;
    }
    renderStock();if(state.selectedId){state.analysis=currentAnalysis();renderPlan();}
  }finally{button.disabled=false;}
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
    const link=el("a","button","Autoriser LoSP avec Scopely");link.href="/admin/login/captain?returnTo=events-planner";box.append(link);return;
  }
  const required=["m3p.f.pr.act","m3p.f.pr.ros"],missing=required.filter(scope=>!status.scopes.includes(scope));
  const line=el("p","",missing.length?"Événements ou roster : accès manquant.":"Session Scopely active · données lues à la demande.");
  box.append(line);
  if(missing.length){const link=el("a","button","Réautoriser l’accès requis");link.href="/admin/login/captain?returnTo=events-planner&reauthorize=1";box.append(link);}
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
    fetchSafe({resource:"inventory",itemType:"ISOITEM"}),Promise.all([loadCatalog(),loadCalendar()]).then(()=>({ok:true}))
  ]);
  if(english.error){banner("Les événements personnels sont indisponibles · "+errorText(english.error),"error");$("event-count").textContent="Événements indisponibles";$("events-list").replaceChildren(el("p","warning","La session est active, mais Scopely n’a pas fourni la liste."),renderDiagnostic(english.error));state.refreshing=false;$("refresh").disabled=false;return;}
  state.eventsEn=Array.isArray(english.data)?english.data:[];state.eventsFr=Array.isArray(french.data)?french.data:[];
  state.roster=Array.isArray(roster.data)?roster.data:null;
  const invOk=[consumables,isoitems].some(result=>!result.error);
  state.inventory=invOk?{}:null;state.inventoryReason=consumables.error||isoitems.error||null;
  state.inventoryTypes={};
  if(state.inventory){installInventoryResult("CONSUMABLE",consumables);installInventoryResult("ISOITEM",isoitems);}
  buildObservations();renderEvents();
  if(state.selectedId&&state.tab==="events")showSelected(state.selectedId);
  if(state.calendarError)banner("Le catalogue de présentation LoSP est indisponible : les événements personnels non filtrés sont masqués.","warning");
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
  if(button.dataset.action==="skip"){state.skipped.add(id);saveLocal();if(state.selectedId===id){state.selectedId=null;returnToList();}renderEvents();}
});
$("skipped-list").addEventListener("click",event=>{const button=event.target.closest('[data-action="restore"]');if(button){state.skipped.delete(button.dataset.eventId);saveLocal();renderEvents();}});
$("selected-event").addEventListener("click",event=>{
  const button=event.target.closest("[data-action]");if(!button)return;const id=button.dataset.eventId;
  if(button.dataset.action==="back-list"){returnToList();return;}
  if(button.dataset.action==="open-plan"){setTab("plan");return;}
  if(button.dataset.action==="skip"){state.skipped.add(id);state.selectedId=null;saveLocal();returnToList();renderEvents();return;}
  if(button.dataset.action==="restore"){state.skipped.delete(id);saveLocal();renderEvents();}
});
$("refresh-ledger").addEventListener("click",refreshLedger);
$("refresh-inventory").addEventListener("click",refreshInventory);
$("plan-back").addEventListener("click",()=>setTab("events"));
$("stock-view").addEventListener("input",event=>{const input=event.target.closest("[data-stock-key]");if(input)state.drafts[input.dataset.stockKey]=input.value;});
$("stock-view").addEventListener("click",event=>{
  const button=event.target.closest("[data-action]");if(!button)return;
  const key=button.dataset.resource;
  if(button.dataset.action==="save-stock")declareStock(key,state.drafts[key]||"");
  if(button.dataset.action==="confirm-stock")declareStock(key,String(estimateResource(state.stock[key].ledger).value),true);
});
loadLocal();loadOverview();
