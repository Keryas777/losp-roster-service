import { analyzeMilestoneEvent } from "./lib/event-analysis.js";
import { RESOURCES, classifyObjective, observeEvent, resourcesInUse, declareResource, refreshResource, estimateResource, parseQuantity, buildIsoCrystalMatrix, evaluateIsoClassEligibility, parseIsoCrystalId } from "./lib/index.js";
import { installCalendarSnapshot, currentCalendarGroups, mergeCalendarEvent, calendarGroups } from "./lib/calendar.js";
import { commandCenterFeeders, commandCenterPeriodLabel, isCommandCenterFeeder, isCommandCenterWrapper, summarizeFeederProgress } from "./lib/command-center.js";

const $=id=>document.getElementById(id);
const API="/admin/api/event-planner";
const CATALOG_BASE="https://keryas777.github.io/msf/data/";
const RESOURCE_CATALOG_URL="/admin/events-planner/data/msf-resource-catalog.json";
const STORAGE_KEY="losp-event-planner-v1";
const DETAIL_BUDGET_KEY="losp-event-planner-phase1-detail-attempted";
const SESSION_NAMESPACE_RX=/^[a-f0-9]{64}$/;
const number=new Intl.NumberFormat("fr-FR");
const date=new Intl.DateTimeFormat("fr-FR",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Paris"});
const syncDate=new Intl.DateTimeFormat("fr-FR",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Paris"});
const state={eventsEn:[],eventsFr:[],calendarEvents:[],eligibleEventIds:null,calendarError:null,roster:null,rosterRetrievedAt:null,rosterResolved:false,characters:[],resourceCatalog:[],storageNamespace:null,inventory:null,inventoryReason:null,inventoryTypes:{},skipped:new Set(),stock:{},history:[],details:new Map(),rewardDetails:new Map(),personalRequests:new Map(),detailRequestEventId:(()=>{try{return sessionStorage.getItem(DETAIL_BUDGET_KEY)==="1"?"__budget-used__":null;}catch{return null;}})(),selectedId:null,analysis:null,observations:[],drafts:{},tab:"events",loadingStock:false,refreshing:false,detailLoading:false,listScrollY:0,initialEventId:(()=>{const id=new URLSearchParams(location.search).get("eventId");return id&&/^[A-Za-z0-9_.:-]{1,160}$/.test(id)?id:null;})()};

function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined&&text!==null)node.textContent=String(text);return node;}
function fmt(value){return value==null?"Données indisponibles":number.format(value);}
function eventDate(seconds){return Number.isFinite(Number(seconds))?date.format(new Date(Number(seconds)*1000)):"Date inconnue";}
function getEvent(id,language="en"){return (language==="en"?state.eventsEn:state.eventsFr).find(item=>String(item.id)===String(id))||null;}
function milestoneObjective(event){return event?.milestone?.brackets?.find(row=>row?.objective)?.objective||null;}
function stripTags(value){return String(value??"").replace(/<[^>]*>/g,"").replace(/\s+/g," ").trim();}
function displayName(event){return stripTags(event?.name)||"Événement sans titre";}
function eventTypeLabel(event){
  if(isCommandCenterWrapper(event))return "Poste de commandement";
  if(isCommandCenterFeeder(event))return "Série du poste de commandement";
  const labels={info:"Information",bonus:"Bonus",blitz:"Blitz",episodic:"Épisodique",milestone:"Jalons",raid:"Raid",raidSeason:"Saison de raid",warSeason:"Saison de guerre",donation:"Don",battlePass:"Battle Pass",strikePass:"Strike Pass",tower:"Tour",pickYourPoison:"À vous de choisir"};
  const type=labels[event?.type]||stripTags(event?.type)||"Événement";
  if(event?.type==="milestone"&&event?.milestone?.type)return `${type} · ${event.milestone.type}`;
  return type;
}
function errorText(error){
  if(error?.body?.error==="scope-insufficient")return "Cette autorisation ne donne pas accès à cette donnée.";
  if(error?.body?.reason==="not-connected"||error?.body?.reason==="consent-revoked")return "Compte MSF non connecté ou autorisation révoquée.";
  if(error?.body?.error==="rate-limited")return "Le service limite temporairement les demandes. Réessaie dans un instant.";
  if(error?.body?.error==="scope-or-access-denied")return "Cette demande a été refusée. Les détails sont réservés à l’administration.";
  if(error?.body?.error==="provider-error")return "Les données ne sont pas disponibles pour le moment.";
  return "Donnée indisponible pour le moment.";
}
async function api(params){
  const query=new URLSearchParams(params);
  const response=await fetch(API+"?"+query.toString(),{method:"GET",credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
  let body;try{body=await response.json();}catch{body={error:"invalid-response"};}
  if(!response.ok){const error=new Error(body.error||"request-failed");error.status=response.status;error.body=body;throw error;}
  return body;
}
function personalApi(params){
  const key=new URLSearchParams(params).toString();
  if(!state.personalRequests.has(key))state.personalRequests.set(key,api(params).catch(error=>({error})));
  return state.personalRequests.get(key);
}
function loadLocal(namespace){
  if(!SESSION_NAMESPACE_RX.test(String(namespace||"")))return;
  state.storageNamespace=namespace;
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY+":"+namespace)||"{}");
    if(Array.isArray(saved.skipped))state.skipped=new Set(saved.skipped.filter(id=>typeof id==="string"));
    if(saved.stock&&typeof saved.stock==="object"&&!Array.isArray(saved.stock))state.stock=saved.stock;
    if(Array.isArray(saved.history))state.history=saved.history.slice(-500);
  }catch{state.skipped=new Set();state.stock={};state.history=[];}
}
function saveLocal(){
  if(!state.storageNamespace||!SESSION_NAMESPACE_RX.test(state.storageNamespace))return;
  try{localStorage.setItem(STORAGE_KEY+":"+state.storageNamespace,JSON.stringify({skipped:[...state.skipped],stock:state.stock,history:state.history.slice(-500)}));}
  catch{banner("Les réglages locaux ne peuvent pas être enregistrés dans ce navigateur.","warning");}
}
function clearPersonalState(){
  state.storageNamespace=null;state.eventsEn=[];state.eventsFr=[];state.roster=null;state.rosterRetrievedAt=null;state.rosterResolved=false;state.inventory=null;state.inventoryReason=null;state.inventoryTypes={};
  state.skipped=new Set();state.stock={};state.history=[];state.details.clear();state.rewardDetails.clear();state.personalRequests.clear();
  state.selectedId=null;state.analysis=null;state.observations=[];state.drafts={};state.initialEventId=null;
  $("selected-event").hidden=true;$("event-list-view").hidden=false;
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
  const loadResourceCatalog=async()=>{
    const response=await fetch(RESOURCE_CATALOG_URL,{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
    if(!response.ok)throw new Error("catalog-unavailable");
    return response.json();
  };
  try{
    const [catalog,traits,eventTraits,resourceData]=await Promise.all([
      load("msf-characters.json"),load("dd-character-traits.json"),load("dd-event-character-traits.json"),
      loadResourceCatalog().catch(()=>({items:[]}))
    ]);
    state.resourceCatalog=Array.isArray(resourceData?.items)?resourceData.items:[];
    const regular=traits?.characters||{},special=eventTraits?.characters||{};
    state.characters=(Array.isArray(catalog)?catalog:[]).filter(item=>item?.id&&item.player_Character===true).map(item=>({
      id:item.id,nameEn:item.nameEn||item.nameKey||item.id,nameFr:item.nameFr||null,
      portrait:item.portraitUrl||null,traits:[...new Set([...(regular[item.id]||[]),...(special[item.id]||[])])]
    }));
  }catch{state.characters=[];state.resourceCatalog=[];}
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
  return Object.fromEntries(Object.entries(groups).map(([key,events])=>[key,events.map(event=>mergeCalendarEvent(event,getEvent(event.id,"fr")))]));
}
function activeEvents(){return Object.values(calendarView()).flat();}
function localizedCalendarEvent(id,language="fr"){
  const catalog=state.calendarEvents.find(item=>String(item.id)===String(id))||null;
  const personal=getEvent(id,language);
  return mergeCalendarEvent(catalog,personal)||catalog||personal;
}
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
  const eventData=detail.fr||getEvent(state.selectedId,"fr");
  if(!eventData)return null;
  // A French-only response may contain text the English classifier cannot verify.
  // Such rows remain unknown; numeric progress is still read from the same source.
  return analyzeMilestoneEvent({eventEn:eventData,eventFr:eventData,roster:state.roster||[],rosterKnown:Array.isArray(state.roster),characters:state.characters,stock:effectiveStock()});
}
function renderEvents(){
  const groups=calendarView(),events=Object.values(groups).flat();
  const groupedFeederIds=new Set(events.filter(isCommandCenterWrapper)
    .flatMap(wrapper=>commandCenterFeeders(wrapper,state.eventsFr).map(feeder=>String(feeder.id))));
  const visible=events.filter(event=>!state.skipped.has(String(event.id))&&!groupedFeederIds.has(String(event.id)));
  const ignored=events.filter(event=>state.skipped.has(String(event.id))).length;
  $("event-count").textContent=state.calendarError?"Calendrier indisponible · liste masquée":
    `${visible.length} événement${visible.length===1?"":"s"} affiché${visible.length===1?"":"s"} · ${ignored} ignoré${ignored===1?"":"s"}`;
  const list=$("events-list");list.replaceChildren();
  if(state.calendarError){list.append(el("div","empty-card","Le calendrier LoSP n’a pas pu être chargé. La liste des événements reste masquée."));}
  else if(!visible.length){list.append(el("div","empty-card",events.length?"Tous les événements LoSP en cours sont ignorés.":"Aucun événement LoSP n’est actuellement en cours."));}
  for(const group of calendarGroups){
    const entries=(groups[group.key]||[]).filter(event=>!state.skipped.has(String(event.id))&&!groupedFeederIds.has(String(event.id)));
    if(!entries.length)continue;
    const section=el("section","ev-calendar-group"),head=el("div","ev-calendar-group-head");
    head.append(el("h3","ev-calendar-group-title",group.icon+" "+group.label),el("span","ev-calendar-group-count",entries.length));
    const grid=el("div","ev-grid");
    for(const event of entries){
      const id=String(event.id),localized=localizedCalendarEvent(id,"fr")||event,card=el("article","ev-card planner-event-card");
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
function statusTag(status){const labels={done:"Terminé confirmé",doable:"Faisable gratuitement",resource:"Ressource à prévoir",blocked:"Personnages à améliorer",unknown:"Progression ou faisabilité inconnue"};return labels[status]||"Données indisponibles";}
function modeLabelFr(mode){
  const labels={raid:"Raid",war:"Guerre",arena:"Arène",blitz:"Blitz",crucible:"Épreuve cosmique",rta:"Arène en temps réel",campaign:"Campagne",battleworld:"Battleworld",any:"combat"};
  return labels[mode]||null;
}
function characterNameFr(character){
  const entry=state.characters.find(item=>String(item.id)===String(character?.id));
  return entry?.nameFr||"Personnage dont le nom français est indisponible";
}
function objectiveLabelFr(action){
  const french=String(action.label||"").trim(),english=String(action.labelEn||"").trim();
  if(french&&french!==english)return french;
  if(action.kind==="login")return "Connexion quotidienne";
  if(action.kind==="free")return "Récupérer l’offre gratuite";
  if(action.kind==="fight"){
    const modes=(action.modes||[]).map(modeLabelFr).filter(Boolean);
    if(!modes.length&&modeLabelFr(action.mode))modes.push(modeLabelFr(action.mode));
    const modeText=modes.length?" en "+modes.join(" et "):" dans un mode de jeu admissible";
    const subject=action.character?.id?" avec "+characterNameFr(action.character):
      (action.subject?.type==="trait"||action.subject?.type==="team")?" avec une équipe remplissant les critères":" avec un personnage admissible";
    const req=action.requirements||{},conditions=[];
    if(Number.isFinite(req.yellowStars))conditions.push(req.yellowStars+" étoiles jaunes");
    if(Number.isFinite(req.redStars))conditions.push(req.redStars+" étoiles rouges");
    if(Number.isFinite(req.gearTier))conditions.push("équipement "+req.gearTier);
    if(Number.isFinite(req.level))conditions.push("niveau "+req.level);
    return "Effectuer des combats"+modeText+subject+(conditions.length?" ("+conditions.join(", ")+")":"");
  }
  if(action.kind==="mode"){
    const modes=(action.modes||[]).map(modeLabelFr).filter(Boolean);
    if(!modes.length&&modeLabelFr(action.mode))modes.push(modeLabelFr(action.mode));
    return modes.length?"Effectuer des combats de "+modes.join(" et "):"Effectuer un combat dans le mode indiqué par l’événement";
  }
  if(action.kind==="spend"||action.kind==="spendEnergy"){
    const resource=action.resourceLabel||"la ressource indiquée";
    return action.kind==="spendEnergy"?"Utiliser l’énergie requise ("+resource+")":"Dépenser "+resource;
  }
  if(action.kind==="external")return "Action liée à une offre ou à un achat; progression non estimée";
  if(action.kind==="upgrade")return "Améliorer un personnage éligible selon les conditions de l’événement";
  return "Objectif à vérifier · libellé français indisponible";
}
function rosterRequirementText(code,reason){
  const have=Number.isFinite(reason?.have)?reason.have:null,need=Number.isFinite(reason?.need)?reason.need:null;
  if(code==="yellowStars"||code==="redStars"){
    const label=code==="yellowStars"?"étoiles jaunes":"étoiles rouges";
    return have===null||need===null?"Prérequis de "+label+" non rempli.":have+"/"+need+" "+label+" · "+Math.max(0,need-have)+" supplémentaire(s) nécessaire(s)";
  }
  if(code==="gearTier")return have===null||need===null?"Palier d’équipement requis indisponible.":"Équipement : palier "+have+"/"+need;
  if(code==="level")return have===null||need===null?"Niveau requis indisponible.":"Niveau : "+have+"/"+need;
  return null;
}
function reasonLabel(code){const labels={unknownName:"Personnage non identifié",ambiguousName:"Nom de personnage ambigu",unknownResource:"Ressource non reconnue",unknownIon:"Ion ISO-8 non reconnu",unknownMode:"Mode de jeu non reconnu",unknownForm:"Condition non interprétée",multiMethod:"Plusieurs actions combinées",meta:"Points portés par un sous-événement",earn:"Gain non calculable"};return labels[code]||"Données nécessaires indisponibles";}
function unparsedObjectiveLabel(item){
  if(item?.label&&item?.label!==item?.labelEn)return item.label;
  return "Objectif à vérifier · "+reasonLabel(item?.reason);
}
function objectiveGroup(action){
  if(action.character?.id)return {key:"character:"+action.character.id,label:characterNameFr(action.character),portrait:action.character.portrait||null};
  if(action.subject?.type==="trait"||action.subject?.type==="team")return {key:"team:"+String(action.mode||"general"),label:"Équipe · "+(modeLabelFr(action.mode)||"actions associées"),portrait:null};
  if(action.mode&&action.mode!=="any")return {key:"mode:"+action.mode,label:"Actions · "+(modeLabelFr(action.mode)||"mode de jeu"),portrait:null};
  return {key:"general",label:"Actions générales",portrait:null};
}
function renderObjectiveGroups(rows,target){
  const groups=new Map();
  for(const action of rows){const meta=objectiveGroup(action);if(!groups.has(meta.key))groups.set(meta.key,{...meta,actions:[]});groups.get(meta.key).actions.push(action);}
  for(const group of groups.values()){
    const completed=group.actions.filter(action=>action.status==="done"),remaining=group.actions.filter(action=>action.status!=="done");
    const card=el("details","objective-group");card.open=remaining.length>0&&group.actions.length<=4;
    const summary=el("summary","objective-group-summary");
    if(group.portrait)addSafeImage(summary,group.portrait,"objective-group-portrait",group.label);
    summary.append(el("strong","",group.label),el("span","objective-group-count",remaining.length+" à faire ou vérifier · "+completed.length+" terminé"+(completed.length===1?"":"s")));card.append(summary);
    const content=el("div","objective-group-content");
    if(remaining.length){const list=el("ul","action-list");for(const action of remaining)addActionRow(list,action,{portrait:false});content.append(list);}
    if(completed.length){const done=el("details","objective-completed");done.append(el("summary","objective-completed-summary","Terminés confirmés · "+completed.length));const list=el("ul","action-list");for(const action of completed)addActionRow(list,action,{portrait:false});done.append(list);content.append(done);}
    card.append(content);target.append(card);
  }
}
function loadSelectedDetail(id){
  const key=String(id),listed=getEvent(key,"fr");
  if(!listed||!isCommandCenterFeeder(listed))return Promise.resolve({fr:listed});
  if(state.details.has(key))return Promise.resolve(state.details.get(key));
  const existing=state.details.get("loading:"+key);if(existing)return existing;
  if(state.detailRequestEventId&&state.detailRequestEventId!==key)return Promise.resolve({fr:listed,detailLimitReached:true});
  state.detailRequestEventId=key;
  try{sessionStorage.setItem(DETAIL_BUDGET_KEY,"1");}catch{}
  const task=personalApi({resource:"detail",eventId:key,lang:"fr"}).then(result=>{
    const pair=result.error?{fr:listed,error:result.error}:{fr:result.data};
    state.details.set(key,pair);
    if(pair.fr)state.rewardDetails.set(key,rewardsFrom(pair.fr));
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
  const pair=await loadSelectedDetail(id);state.detailLoading=false;
  if(state.selectedId!==String(id))return;
  const curated=state.calendarEvents.find(item=>String(item.id)===String(id))||null;
  const event=mergeCalendarEvent(curated,pair.fr||getEvent(id,"fr"));
  const fr=event||mergeCalendarEvent(curated,getEvent(id,"fr"));
  if(!event){root.replaceChildren(bar,el("p","error","Les détails de cet événement n’ont pas été reçus."));return;}
  const analysis=currentAnalysis();state.analysis=analysis;
  renderSelected(event,fr,analysis,pair.error);
  if(pair.detailLimitReached)root.append(el("p","warning","La seule fiche détaillée autorisée pour cette validation a déjà été demandée. Les autres compteurs restent ceux de la liste française."));
  if(state.tab==="objectives")renderObjectives();if(state.tab==="plan")renderPlan();if(state.tab==="stock")renderStock();
}
function returnToList(){
  $("selected-event").hidden=true;$("event-list-view").hidden=false;
  requestAnimationFrame(()=>scrollImmediately(state.listScrollY));
}
function addActionRow(list,action,{portrait=true}={}){
  const row=el("li","action-row"),name=objectiveLabelFr(action);
  if(portrait)addSafeImage(row,action.character?.portrait,"character-portrait");
  const copy=el("div","action-row__copy");copy.append(el("strong","",name),el("span","status status--"+action.status,statusTag(action.status)));
  const details=[];
  if(action.premium)details.push("Objectif associé au Passe Premium · indication fournie par le jeu");
  if(action.progressState==="unknown")details.push("Progression : données indisponibles");
  else if(Number.isFinite(action.progress)&&Number.isFinite(action.cap))details.push(fmt(action.progress)+" / "+fmt(action.cap)+" pts");
  if(action.remainingUnits!=null)details.push(fmt(action.soFarUnits)+" / "+fmt(action.capUnits)+" unités");
  if(action.fightsLeft!=null)details.push(fmt(action.fightsLeft)+" action(s) restante(s)");
  if(action.reason?.code){
    const rosterText=rosterRequirementText(action.reason.code,action.reason);
    if(rosterText)details.push(rosterText);
    else if(action.reason.code==="traitShort")details.push("Équipe : "+action.reason.have+"/"+action.reason.need+" personnages admissibles");
    else if(action.reason.code==="external")details.push("Objectif associé à une offre ou un achat; faisabilité hors jeu non vérifiée");
    else if(action.reason.code==="rosterUnavailable")details.push("Ton équipe n’est pas disponible; faisabilité inconnue");
    else if(action.reason.code==="noCharacter")details.push("Aucun de tes personnages ne remplit les prérequis");
    else details.push(reasonText(action));
  }
  if(action.resourceLabel)details.push(action.resourceLabel);
  if(action.assumptions?.length)details.push("Hypothèse : "+action.assumptions.map(value=>value==="trait-fight-full-squad"?"Équipe complète correspondant au critère supposée":"Estimation du planificateur").join(", "));
  if(details.length)copy.append(el("p","row-detail",details.join(" · ")));
  if(action.progressState==="available"&&Number.isFinite(action.progress)&&Number.isFinite(action.cap)&&action.cap>0){
    const percent=Math.max(0,Math.min(100,action.progress/action.cap*100)),track=el("div","objective-progress");
    track.setAttribute("role","progressbar");track.setAttribute("aria-label","Progression de "+name);
    track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(action.cap));track.setAttribute("aria-valuenow",String(Math.max(0,Math.min(action.progress,action.cap))));
    const fill=el("span");fill.style.width=percent+"%";track.append(fill);copy.append(track);
  }
  row.append(copy);list.append(row);
}
function reasonText(action){
  const reason=action.reason||{};
  if(reason.code==="notOwned")return "Personnage non présent dans ton équipe";
  if(reason.code==="noCharacter")return "Aucun de tes personnages ne remplit les prérequis";
  if(reason.code==="rosterUnavailable")return "Ton équipe n’est pas disponible; faisabilité inconnue";
  if(reason.code==="external")return "Objectif associé à une offre ou un achat";
  if(reason.code==="traitShort")return Number.isFinite(reason.have)&&Number.isFinite(reason.need)?"Équipe : "+reason.have+"/"+reason.need+" personnages admissibles":"Prérequis d’équipe non remplis";
  return rosterRequirementText(reason.code,reason)||"Condition de personnage non remplie";
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
function renderCommandCenterMissions(wrapper){
  if(!isCommandCenterWrapper(wrapper))return null;
  const all=commandCenterFeeders(wrapper,state.eventsFr),visible=all.filter(feeder=>!state.skipped.has(String(feeder.id)));
  const section=el("section","panel-card command-center-missions");
  section.append(el("h3","","Séries d’objectifs en cours"));
  if(!all.length){
    section.append(el("p","muted","Aucune série d’objectifs en cours n’a été identifiée dans la liste personnelle. Cela ne confirme pas que le poste de commandement est terminé."));
    return section;
  }
  if(!visible.length){
    section.append(el("p","muted","Toutes les séries identifiées sont ignorées dans cette session."));
    return section;
  }
  section.append(el("p","row-detail","Les points de phase du poste ne sont pas estimés à partir de lignes ou récompenses manquantes. Ouvre une série pour l’analyse détaillée."));
  const list=el("ul","action-list");
  for(const feeder of visible){
    const summary=summarizeFeederProgress(feeder),localized=getEvent(feeder.id,"fr")||feeder;
    const stateLabel=summary.status==="complete-lines"?"Toutes les lignes plafonnées terminées":
      summary.status==="open-lines"?"Lignes plafonnées en cours":
      summary.status==="partial"?"Progression partiellement connue":"Progression indisponible";
    const progress=summary.status==="complete-lines"||summary.status==="open-lines"
      ?`Lignes terminées : ${summary.completed}/${summary.total}`
      :summary.status==="partial"
        ?`Compteurs connus : ${summary.known}/${summary.total} · ${summary.completed} ligne(s) terminée(s) confirmée(s)`
        :"Les compteurs manquants restent inconnus";
    const row=el("li","action-row"),copy=el("div","action-row__copy");
    copy.append(el("strong","",displayName(localized)),el("span","status status--"+(summary.status==="complete-lines"?"done":summary.status==="open-lines"?"doable":"unknown"),stateLabel));
    copy.append(el("span","row-detail",commandCenterPeriodLabel(feeder)+" · "+progress));
    const button=el("button","button button-secondary","Analyser cette série");
    button.type="button";button.dataset.action="select-feeder";button.dataset.eventId=String(feeder.id);
    row.append(copy,button);list.append(row);
  }
  section.append(list);return section;
}
function renderSelected(event,fr,analysis,detailError=null){
  const host=$("selected-event");host.replaceChildren();
  const bar=el("div","planner-detail-bar"),back=el("button","planner-back","‹  Liste des événements");
  back.type="button";back.dataset.action="back-list";bar.append(back,el("span","planner-detail-state","Fiche d’événement"));
  const root=el("div","planner-detail-content");host.append(bar,root);
  const hero=el("header","planner-detail-hero"),imageUrl=event.cardArt||event.popupArt||event.icon;
  if(typeof imageUrl==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\/(?:key_art|imgs)\/[\w.%-]+\.(?:png|jpg|jpeg|webp)$/i.test(imageUrl)){const img=el("img");img.alt="";img.src=imageUrl;img.loading="lazy";img.decoding="async";hero.append(img);}
  const copy=el("div","planner-detail-hero-copy");copy.append(el("span","ev-category",eventTypeLabel(event)),el("h2","",displayName(fr||event)),el("p","",`Fin ${eventDate(event.endTime)}`));hero.append(copy);root.append(hero);
  const commandCenter=renderCommandCenterMissions(event);if(commandCenter)root.append(commandCenter);
  const actions=el("div","detail-action-bar"),skip=el("button","button button-secondary",state.skipped.has(String(event.id))?"Réintégrer":"Ignorer cet événement");
  skip.type="button";skip.dataset.action=state.skipped.has(String(event.id))?"restore":"skip";skip.dataset.eventId=String(event.id);
  const planLink=el("button","button","Planifier cet événement →");planLink.type="button";planLink.dataset.action="open-plan";actions.append(planLink,skip);root.append(actions);
  if(detailError)root.append(el("p","warning","Les détails de cet événement ne sont pas disponibles pour le moment. Les informations déjà reçues restent visibles."));
  if(!state.roster){root.append(el("p","warning","Ton équipe n’est pas disponible. Les objectifs qui en dépendent ne peuvent pas encore être évalués."));}
  if(!analysis){root.append(el("p","warning","Données de calcul des points indisponibles. Aucun objectif n’est déclaré terminé."));renderObjectives();renderPlan();return;}
  if(!analysis.supported){
    const message=event.type!=="milestone"?"Événement classé et consultable. La planification est disponible pour les événements à jalons disposant des données de calcul des points; le calendrier garde les détails des autres événements.":"Données de calcul des points insuffisantes. Les lignes reconnues seront analysées lorsque leurs valeurs seront disponibles.";
    root.append(el("p","warning",message));
    const details=stripTags(fr?.description||fr?.details||fr?.subName||event?.description||event?.details||"");
    if(details)root.append(el("section","panel-card",details));
    renderObjectives();renderPlan();return;
  }
  const metrics=el("div","metric-row");
  const progressLabel=analysis.event.progressState==="available"?`${fmt(analysis.event.points)} pts · progression confirmée`:
    analysis.event.progressState==="estimated"?`${fmt(analysis.event.points)} pts · estimation calculée`:
    analysis.event.progressState==="partial"?`${fmt(analysis.event.reportedActionPoints)} pts recensés · total incomplet`:
    "Données indisponibles";
  metrics.append(el("span","metric",`Progression : ${progressLabel}`));
  metrics.append(el("span","metric",`Actions gratuites connues : ${fmt(analysis.event.doablePoints)} pts`));
  metrics.append(el("span","metric",`Personnages : ${Array.isArray(state.roster)?state.roster.length:"indisponible"}`));root.append(metrics);
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
  const grouped=el("section","panel-card");grouped.append(el("h3","","Actions et améliorations de personnages"));
  if(analysis.groups.length){const list=el("ul","action-list");for(const group of analysis.groups){const representative=analysis.actions.find(action=>group.actions.includes(action.index));if(representative)addActionRow(list,{...representative,status:group.status,doablePoints:group.doablePoints,remaining:representative.remaining,fightsLeft:group.fightsLeft});}grouped.append(list);}
  else grouped.append(el("p","muted","Aucune action n’a pu être identifiée à partir des données de calcul des points."));
  if(analysis.levers.length){grouped.append(el("h4","","Améliorations possibles"));const list=el("ul","action-list");for(const lever of analysis.levers){const li=el("li","action-row");addSafeImage(li,lever.character.portrait,"character-portrait");const copy=el("div");copy.append(el("strong","",`${characterNameFr(lever.character)} · ${lever.kind} ${lever.from} → ${lever.to}`),el("p","row-detail",`+${fmt(lever.gain)} pts · ${lever.steps} niveau(x)`));li.append(copy);list.append(li);}grouped.append(list);}
  rows.append(grouped);root.append(rows);
  if(analysis.unparsed.length){const unknown=el("details","panel-card");unknown.append(el("summary","","Lignes non analysées · "+analysis.unparsed.length));const list=el("ul","action-list");for(const item of analysis.unparsed){const li=el("li","action-row");li.append(el("strong","",unparsedObjectiveLabel(item)),el("p","row-detail",reasonLabel(item.reason)+(item.premium?" · Objectif associé au Passe Premium":"")));list.append(li);}unknown.append(list);root.append(unknown);}
  renderObjectives();renderPlan();
}
function renderObjectives(){
  const target=$("objectives-view");target.replaceChildren();
  const analysis=state.analysis;
  if(!analysis?.supported){target.append(el("p","warning",!state.roster?"Ton équipe n’est pas disponible; progression et faisabilité restent inconnues.":"Choisis un événement dont les données de calcul des points sont disponibles."));return;}
  renderObjectiveGroups(analysis.actions,target);
  if(!analysis.actions.length)target.append(el("p","muted","Aucun objectif individuel exploitable n’a été reçu."));
  if(analysis.event.progressState==="unknown")target.append(el("p","warning","Le score global et les compteurs utiles ne sont pas fournis. Le plan ne leur substitue pas zéro."));
  if(analysis.event.progressState==="partial")target.append(el("p","warning",fmt(analysis.event.reportedActionPoints)+" points de compteurs sont lisibles, mais au moins un compteur manque : le total et les paliers restent inconnus."));
}
function resourcePlanLabel(item){
  const names=(item.resources||[item.resource]).filter(Boolean).map(key=>RESOURCES[key]?.label?.fr||"ressource non identifiée").join(" / ");
  return `${fmt(item.units)} ${names}${item.perDay?` · ${fmt(item.perDay)} par jour`:""}${item.points?` · ${fmt(item.points)} pts`:""}`;
}
function upgradeKindLabel(kind){return ({yellowStars:"étoiles jaunes",redStars:"étoiles rouges",gearTier:"palier d’équipement",level:"niveau",iso8:"ISO-8"})[kind]||"amélioration du personnage";}
function renderPlan(){
  const target=$("plan-view");target.replaceChildren();const analysis=state.analysis;
  const selected=state.selectedId&&(localizedCalendarEvent(state.selectedId,"fr")||localizedCalendarEvent(state.selectedId,"en")||activeEvents().find(item=>String(item.id)===String(state.selectedId)));
  $("plan-event-name").textContent=selected?displayName(selected):"Aucun événement sélectionné";
  $("plan-back").hidden=!selected;
  if(!selected){target.append(el("p","muted","Sélectionne un événement pour afficher ton plan."));return;}
  if(!analysis?.supported){target.append(el("p","warning","Les données de calcul des points nécessaires à cette planification ne sont pas disponibles pour l’événement sélectionné."));return;}
  if(analysis.plan?.status==="unavailable"){
    const message=analysis.event.progressState==="partial"?"Une partie des compteurs manque. Le score total et la faisabilité des paliers ne sont pas déterminés à partir de ce relevé.":"Le score ou les paliers n’ont pas été fournis. Aucune quantité manquante n’est remplacée par zéro.";
    target.append(el("p","warning",message));return;
  }
  const plan=analysis.plan,event=analysis.event,score=event.points,scoreKnown=Number.isFinite(score)&&["available","estimated"].includes(event.progressState);
  const uncertain=event.progressState==="partial"||event.progressState==="unknown"||!Array.isArray(state.roster)||
    analysis.unparsed.length>0||analysis.actions.some(action=>action.status==="unknown");
  const scoreSource=event.progressState==="available"?"Progression personnelle du compte MSF":
    event.progressState==="estimated"?"Estimation à partir des compteurs plafonnés":"Progression indisponible";
  const nextTier=scoreKnown?analysis.tiers.filter(tier=>tier.goal>score).sort((a,b)=>a.goal-b.goal)[0]:null;
  const summary=el("section","plan-event-card");
  summary.append(el("h3","","Événement planifié"),el("p","plan-event-name",displayName(selected||getEvent(state.selectedId,"en")||{})));
  const metrics=el("div","plan-score-grid");
  const metric=(label,value)=>{const cell=el("div","plan-score");cell.append(el("span","plan-score-label",label),el("strong","",value));return cell;};
  metrics.append(metric("Score actuel",scoreKnown?`${fmt(score)} pts`:"Données indisponibles"));
  metrics.append(metric("Dernier palier terminé",event.completedTierKnown?fmt(event.currentTier):"Non confirmé"));
  metrics.append(metric("Temps de planification",`${fmt(plan.planDays)} jour${plan.planDays===1?"":"s"}`));
  const projectionLabel=plan.secure.fromEnergy>0?"Projection conditionnelle · actions + énergie":"Projection gratuite conditionnelle";
  metrics.append(metric(projectionLabel,`${fmt(plan.secure.points)} pts`));summary.append(metrics);
  summary.append(el("p","stock-note",`Points acquis : ${scoreKnown?fmt(score):"données indisponibles"} pts · ${scoreSource}. La projection ajoute ${fmt(plan.secure.fromDoable)} pts d’actions gratuites identifiées et ${fmt(plan.secure.fromEnergy)} pts d’énergie disponible; ces gains restent conditionnels aux actions réalisables avant la fin.`));
  if(nextTier){
    const missing=Math.max(0,nextTier.goal-score),progress=Math.max(0,Math.min(100,score/nextTier.goal*100));
    const progressWrap=el("div","plan-progress-wrap");progressWrap.append(el("p","",`Palier ${nextTier.tier} · ${fmt(nextTier.goal)} points`));
    const track=el("div","plan-progress-track");track.setAttribute("role","progressbar");track.setAttribute("aria-label",`Progression vers le palier ${nextTier.tier}`);track.setAttribute("aria-valuemin","0");track.setAttribute("aria-valuemax",String(nextTier.goal));track.setAttribute("aria-valuenow",String(Math.min(score,nextTier.goal)));
    const fill=el("span");fill.style.width=`${progress}%`;track.append(fill);progressWrap.append(track);
    const label=el("div","plan-progress-label");label.append(el("span","",`${fmt(score)} / ${fmt(nextTier.goal)} pts`),el("strong","",`${fmt(missing)} pts manquants`));progressWrap.append(label);
    if(scoreKnown){const projectedMissing=Math.max(0,nextTier.goal-plan.secure.points);const pace=Math.ceil(projectedMissing/Math.max(1,plan.planDays));
      progressWrap.append(el("p","row-detail",projectedMissing?`Après la projection gratuite, il resterait ${fmt(projectedMissing)} points à obtenir (environ ${fmt(pace)} par jour).`:"La projection gratuite couvre le seuil; elle reste conditionnelle à la réalisation des actions identifiées."));}
    else progressWrap.append(el("p","row-detail","Le rythme quotidien reste indisponible tant que le score actuel n’est pas confirmé."));
    if(nextTier.rewards?.length){const rewards=el("div","plan-rewards");for(const reward of nextTier.rewards){const item=el("span","plan-reward");addSafeImage(item,reward.icon,"reward-icon");item.append(el("span","",`${fmt(reward.quantity)} ${reward.name}`));rewards.append(item);}progressWrap.append(rewards);}
    summary.append(progressWrap);
  }else if(scoreKnown)summary.append(el("p","ok",event.completedTierKnown?"Le score connu dépasse les paliers fournis; le dernier palier réclamé reste celui confirmé dans le compte MSF.":"Aucun palier suivant n’est fourni dans les données reçues."));
  if(event.completedTierKnown)summary.append(el("p","stock-note",`Paliers terminés confirmés dans le compte MSF : jusqu’au palier ${fmt(event.currentTier)}.`));
  else summary.append(el("p","warning","Le nombre de paliers réclamés n’est pas fourni. Le score ne sert pas à inventer un palier terminé."));
  target.append(summary);

  const tierPanel=el("section","panel-card");tierPanel.append(el("h3","","Paliers supplémentaires envisageables"));
  if(!plan.steps.length)tierPanel.append(el("p","muted","Aucun palier supérieur n’est présent dans les données reçues."));
  for(const step of plan.steps){
    const stepUnknown=uncertain||Number(step.uncovered||0)>0;
    const ready=!stepUnknown&&(step.coveredByLevers||step.verdict==="feasible");
    const potential=!ready&&!stepUnknown&&(step.verdict==="need"||step.verdict==="short"||step.spends?.length||step.shortfall?.length);
    const uncovered=Number(step.uncovered||0)>0;
    const stateKey=ready?"ready":uncovered?"unknown":potential?"potential":"unknown";
    const status=ready?"Atteignable avec les données connues":uncovered?"Points non couverts · action non identifiée":potential?"Potentiel · ressources à réunir":"Faisabilité inconnue";
    const box=el("article","plan-tier"),head=el("div","plan-tier-head");head.append(el("strong","",`Palier ${step.tier} · ${fmt(step.goal)} pts`),el("span","plan-tier-state plan-tier-state--"+stateKey,status));box.append(head);
    box.append(el("p","",`${fmt(step.missing)} points manquent après les actions gratuites identifiées.`));
    if(step.leverPoints)box.append(el("p","",`Tes personnages peuvent apporter jusqu’à ${fmt(step.leverPoints)} pts par les améliorations listées.`));
    for(const spend of step.spends||[])box.append(el("p","row-detail",`${spend.fromStock?"Pris en compte dans le stock connu : ":"Ressource nécessaire : "}${resourcePlanLabel(spend)}`));
    for(const spend of step.shortfall||[])box.append(el("p","row-detail",`À prévoir : ${resourcePlanLabel(spend)}`));
    for(const alternative of step.alternatives||[])box.append(el("p","row-detail",`Alternative : ${resourcePlanLabel(alternative)}`));
    if(step.uncovered>0)box.append(el("p","warning",`${fmt(step.uncovered)} pts ne sont couverts par aucune action ou ressource actuellement identifiée.`));
    tierPanel.append(box);
  }
  target.append(tierPanel);

  const actions=el("section","panel-card");actions.append(el("h3","","Actions possibles pour gagner des points"));
  const actionable=analysis.actions.filter(action=>action.status!=="done");
  if(!actionable.length)actions.append(el("p","muted","Aucune action restante n’est reconnue dans les données de calcul des points."));
  else{const list=el("ul","action-list");for(const group of analysis.groups){const representative=analysis.actions.find(action=>group.actions.includes(action.index));if(representative)addActionRow(list,{...representative,status:group.status,fightsLeft:group.fightsLeft});}actions.append(list);}
  if(plan.levers?.length){const list=el("ul","action-list");for(const lever of plan.levers){const row=el("li","action-row");addSafeImage(row,lever.character?.portrait,"character-portrait");row.append(el("span","action-row__copy",`${characterNameFr(lever.character)} · ${upgradeKindLabel(lever.kind)} ${lever.from} → ${lever.to} · +${fmt(lever.points)} pts`));list.append(row);}actions.append(el("h4","","Améliorations de personnages à envisager"),list);}
  target.append(actions);
  if(uncertain){const notes=[];if(event.progressState!=="available")notes.push("le score n’est pas un total confirmé");if(!Array.isArray(state.roster))notes.push("ton équipe n’est pas disponible");if(analysis.unparsed.length)notes.push(`${analysis.unparsed.length} objectif(s) dont les points restent à vérifier`);if(analysis.actions.some(action=>action.status==="unknown"))notes.push("certaines conditions restent inconnues");
    const warning=el("section","plan-warning-group");warning.append(el("strong","","À vérifier avant de viser un palier"));const list=el("ul");for(const note of notes)list.append(el("li","",note));warning.append(list);target.append(warning);}
  if(analysis.offRoster.length){const outside=el("section","panel-card");outside.append(el("h3","","Objectifs hors équipe connue"));for(const item of analysis.offRoster)outside.append(el("p","row-detail",`${item.label&&item.label!==item.labelEn?item.label:"Action supplémentaire · détail français indisponible"} · ${fmt(item.points)} pts`));target.append(outside);}
}
function resourceLabel(key){return RESOURCES[key]?.label?.fr||"Ressource non identifiée";}
function resourceForItemId(id){return Object.values(RESOURCES).find(resource=>resource.itemId===id)||null;}
function isoCrystalCatalogItem(id){
  const parsed=parseIsoCrystalId(id);
  if(parsed.status==="unknown")return null;
  return {
    id,names:{fr:`Cristal ISO-8 · ${parsed.characterClass} · ${parsed.tier} niveau ${parsed.level} · ${parsed.category}`},
    categoryLabelFr:`Cristal ISO-8 · ${parsed.tier} · niveau ${parsed.level}`,
    iso8Crystal:parsed,identificationStatus:parsed.status
  };
}
function inventoryItemName(item,id){
  const record=state.resourceCatalog.find(entry=>entry.id===id)||isoCrystalCatalogItem(id);
  if(record?.names?.fr)return record.names.fr;
  const resource=resourceForItemId(id);
  if(resource?.names?.fr)return resource.names.fr;
  if(resource?.label?.fr)return resource.label.fr;
  return "Ressource à identifier";
}
function inventoryCatalogItem(id){return state.resourceCatalog.find(entry=>entry.id===id)||isoCrystalCatalogItem(id);}
function safeInventoryIcon(item,id){
  const url=item?.icon||item?.item?.icon||inventoryCatalogItem(id)?.icon;
  return typeof url==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\//i.test(url)?url:null;
}
function inventoryQuantityText(item){
  if(!item||!Object.hasOwn(item,"quantity")||item.quantity===null||item.quantity===undefined)return "Inconnue";
  const quantity=Number(item.quantity);
  return Number.isFinite(quantity)?fmt(quantity):"Inconnue";
}
function inventoryAllRows(){
  const rows=[];
  for(const [type,snapshot] of Object.entries(state.inventoryTypes)){
    for(const item of snapshot?.rows||[]){const id=inventoryItemId(item);if(id)rows.push({type,item,id});}
  }
  return rows;
}
function renderInventoryItemRow(row){
  const {item,id}=row,line=el("div","inventory-row inventory-row--priority");
  const icon=safeInventoryIcon(item,id);
  if(icon){const image=el("img","inventory-icon");image.src=icon;image.alt="";image.loading="lazy";line.append(image);}
  else line.append(el("span","inventory-icon inventory-icon--empty","◈"));
  const copy=el("div");copy.append(el("strong","inventory-name",inventoryItemName(item,id)));
  line.append(copy,el("strong","inventory-quantity",inventoryQuantityText(item)));return line;
}
function renderSyncedInventory(){
  const priority=$("inventory-priority"),matrix=$("inventory-iso-matrix");
  priority.replaceChildren();matrix.replaceChildren();
  if(!state.inventory){
    priority.append(el("p","muted","L’inventaire n’est pas disponible pour le moment."));
    matrix.append(el("p","muted","Les quantités de cristaux ISO-8 ne sont pas disponibles."));
    $("inventory-sync-status").textContent="Date de mise à jour indisponible.";return;
  }
  const rows=inventoryAllRows(),byId=new Map(rows.map(row=>[row.id,row]));
  const groups={gold:"Or",cores:"Noyaux d’énergie",training:"Modules d’entraînement",iso8Ions:"Ions ISO-8"};
  const priorities=state.resourceCatalog.filter(item=>item.priority===true).sort((a,b)=>(a.sortOrder||99)-(b.sortOrder||99));
  if(!priorities.length)priority.append(el("p","muted","Les ressources principales ne sont pas encore disponibles."));
  for(const groupKey of Object.keys(groups)){
    const items=priorities.filter(item=>item.group===groupKey);if(!items.length)continue;
    const section=el("section","inventory-summary-group"),heading=el("h4","",groups[groupKey]),list=el("div","inventory-priority-list");
    section.append(heading);let unavailable=0;
    for(const record of items){
      const row=byId.get(record.id);
      if(row)list.append(renderInventoryItemRow(row));
      else unavailable++;
    }
    if(list.childElementCount)section.append(list);
    if(unavailable)section.append(el("p","muted","Certaines quantités ne sont pas disponibles."));
    priority.append(section);
  }
  const isoRows=rows.filter(row=>row.type==="ISOITEM");
  matrix.append(el("h4","","Cristaux ISO-8"));
  matrix.append(el("p","muted","— indique une quantité inconnue. Le niveau accessible ne confirme ni l’amélioration ni son coût."));
  const controls=el("div","iso-matrix-controls");
  const tierSelect=el("select","iso-matrix-select"),levelSelect=el("select","iso-matrix-select");
  tierSelect.id="iso-tier-select";levelSelect.id="iso-level-select";
  tierSelect.setAttribute("aria-label","Palier ISO-8 des cristaux");
  levelSelect.setAttribute("aria-label","Niveau des cristaux ISO-8");
  for(const [value,label] of [["P1","P1 · vert"],["P2","P2 · bleu"],["P3","P3 · violet"],["P4","P4 · orange"]]){
    const option=el("option","",label);option.value=value;tierSelect.append(option);
  }
  for(let level=1;level<=5;level++){const option=el("option","",`Niveau ${level}`);option.value=String(level);levelSelect.append(option);}
  const tierField=el("div","iso-matrix-field"),tierLabel=el("label","","Palier");tierLabel.htmlFor=tierSelect.id;tierField.append(tierLabel,tierSelect);
  const levelField=el("div","iso-matrix-field"),levelLabel=el("label","","Niveau");levelLabel.htmlFor=levelSelect.id;levelField.append(levelLabel,levelSelect);
  controls.append(tierField,levelField);matrix.append(controls);
  const tableHost=el("div","iso-matrix-scroll");matrix.append(tableHost);
  const renderTable=()=>{
    const normalized=isoRows.map(({item,id})=>{
      const raw=item?.quantity;
      const quantity=typeof raw==="number"&&Number.isSafeInteger(raw)&&raw>=0?raw:
        typeof raw==="string"&&/^\d+$/.test(raw.trim())&&Number.isSafeInteger(Number(raw))?Number(raw):null;
      return {id,quantity};
    });
    const model=buildIsoCrystalMatrix(normalized,tierSelect.value,Number(levelSelect.value));
    const table=el("table","iso-matrix");table.dataset.tier=tierSelect.value;
    const head=el("tr");head.append(el("th","","Classe"));
    for(const category of model.categories)head.append(el("th","",category));
    head.append(el("th","","Niveau accessible"));
    const thead=el("thead");thead.append(head);const tbody=el("tbody");
    for(const className of model.classes){
      const line=el("tr");line.append(el("th","",className));
      for(const category of model.categories){
        const cell=model.cells[className][category],td=el("td","iso-matrix-cell iso-matrix-cell--"+cell.state);
        td.textContent=cell.state==="known"?fmt(cell.quantity):"—";
        td.setAttribute("aria-label",cell.state==="known"?`${category} : ${fmt(cell.quantity)}`:`${category} : quantité inconnue`);
        line.append(td);
      }
      const classCodes={Cogneur:"BRAWLER",Tireur:"BLASTER",Contrôleur:"CONTROLLER",Protecteur:"PROTECTOR",Soutien:"SUPPORT"};
      const eligibility=evaluateIsoClassEligibility(normalized,classCodes[className],tierSelect.value,Number(levelSelect.value));
      const eligibilityCell=el("td","iso-matrix-cell iso-matrix-cell--"+eligibility.status);
      eligibilityCell.textContent=eligibility.status==="eligible"?`Niv. ${eligibility.eligibleCombatIsoLevel}`:eligibility.status==="ineligible"?"Cristaux insuffisants":"À vérifier";
      eligibilityCell.setAttribute("aria-label",eligibility.status==="eligible"?"Niveau accessible; amélioration non effectuée et coût non établi":eligibility.status==="ineligible"?"Cristaux insuffisants":"Disponibilité inconnue");
      line.append(eligibilityCell);
      tbody.append(line);
    }
    table.append(thead,tbody);tableHost.replaceChildren(table);
  };
  tierSelect.addEventListener("change",renderTable);levelSelect.addEventListener("change",renderTable);renderTable();
  const dates=Object.values(state.inventoryTypes).map(item=>item?.retrievedAt).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  const latest=dates.length?new Date(Math.max(...dates)):null;
  $("inventory-sync-status").textContent=latest?`Dernière synchronisation : ${syncDate.format(latest)}.`:"Date de mise à jour indisponible.";
}
function renderStock(){
  renderSyncedInventory();
  const root=$("stock-view");root.replaceChildren();const unknown=$("unavailable-stock");unknown.replaceChildren();
  const used=resourcesInUse(state.observations,[...state.skipped]);
  if(!state.eventsEn.length){root.append(el("p","warning","Les événements du compte ne sont pas disponibles; les ressources utiles à la planification restent inconnues."));unknown.append(el("p","muted","Les quantités restent inconnues tant que les événements du compte ne sont pas disponibles."));return;}
  if(!used.length)root.append(el("p","muted","Aucun besoin de ressources n’est confirmé à partir des événements disponibles."));
  for(const key of used){
    const card=el("article","stock-card");card.append(el("h3","",resourceLabel(key)));
    const involved=state.observations.filter(item=>item.uses.includes(key)).map(item=>displayName(getEvent(item.id,"fr")||getEvent(item.id,"en")||activeEvents().find(event=>String(event.id)===String(item.id))||{}));
    card.append(el("p","stock-note",involved.length?"Demandé par : "+[...new Set(involved)].join(", "):"Demandé par les événements en cours."));
    const apiValue=inventoryValue(key),saved=stockEstimate(key);
    if(apiValue!==null)card.append(el("p","ok",`Inventaire synchronisé : ${fmt(apiValue)}. Il reste séparé des quantités ajoutées manuellement.`));
    if(saved){
      card.append(el("p","row-detail",`${saved.source==="estimated"?"Estimation calculée":"Dernière déclaration manuelle"} : ${fmt(saved.value)}${saved.declaredAt?` · mise à jour ${syncDate.format(new Date(saved.declaredAt))}`:""}${saved.spentSince?` · ${fmt(saved.spentSince)} dépensées estimées`:""}${saved.earnedSince?` · ${fmt(saved.earnedSince)} reçues estimées`:""}`));
      if(saved.dataUnavailable)card.append(el("p","warning","Des compteurs manquent; les dépenses et l’estimation ne sont pas confirmées."));
      if(saved.declaredAt&&Date.now()-saved.declaredAt>86400000)card.append(el("p","warning","Cette déclaration date de plus de 24 h; vérifie-la avant de planifier."));
    }
    const row=el("div","stock-row"),label=el("label","","Quantité ajoutée");
    const input=el("input");input.type="text";input.inputMode="decimal";input.autocomplete="off";input.placeholder="Quantité inconnue";input.value=state.drafts[key]??"";input.dataset.stockKey=key;label.append(input);row.append(label);
    const save=el("button","button button-secondary","Enregistrer la déclaration");save.type="button";save.dataset.action="save-stock";save.dataset.resource=key;row.append(save);
    if(saved&&saved.source==="estimated"){const confirm=el("button","small-button","Confirmer cette estimation");confirm.type="button";confirm.dataset.action="confirm-stock";confirm.dataset.resource=key;row.append(confirm);}
    card.append(row);root.append(card);
    if(apiValue===null){
      const unavailable=el("article","unknown-resource-row");
      const message=saved?.source==="estimated"?`Estimation calculée : ${fmt(saved.value)}. Cette estimation reste séparée de ton inventaire.`:saved?.source==="declared"?`Quantité ajoutée : ${fmt(saved.value)}. Elle reste séparée de ton inventaire synchronisé.`:"Quantité inconnue dans les données synchronisées.";
      unavailable.append(el("strong","",resourceLabel(key)),el("p","",message));
      unknown.append(unavailable);
    }
  }
  if(state.loadingStock)root.prepend(el("p","muted","Lecture des détails d’événements pour actualiser les récompenses des événements…"));
  if(state.history.length){const details=el("details","stock-card");details.append(el("summary","","Historique des déclarations · "+state.history.length));for(const entry of state.history.slice(-20).reverse())details.append(el("p","row-detail",`${resourceLabel(entry.resource)} · ${eventDate(entry.at/1000)} · ${fmt(entry.estimated)} → ${fmt(entry.declared)}`));root.append(details);}
}
async function refreshLedger(){
  buildObservations();renderStock();
}
async function refreshInventory(){
  if(!state.storageNamespace)return;
  const button=$("refresh-inventory");button.disabled=true;$("inventory-sync-status").textContent="Réutilisation des données déjà chargées…";
  try{
    const safe=itemType=>personalApi({resource:"inventory",itemType,lang:"fr"});
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
    const link=el("a","button","Connecter mon compte MSF");link.href="/admin/login/captain?returnTo=events-planner";box.append(link);return;
  }
  const required=["m3p.f.pr.act"],missing=required.filter(scope=>!status.scopes.includes(scope));
  const line=el("p","",missing.length?"Ton compte MSF ne donne pas accès aux événements.":"Compte MSF connecté.");
  box.append(line);
  if(missing.length){const link=el("a","button","Réautoriser l’accès requis");link.href="/admin/login/captain?returnTo=events-planner&reauthorize=1";box.append(link);}
  if(state.rosterResolved){
    if(Array.isArray(state.roster))box.append(el("p","row-detail",`Équipe synchronisée ${state.rosterRetrievedAt?`le ${syncDate.format(new Date(state.rosterRetrievedAt))}`:""} · ${state.roster.length} personnages.`));
    else box.append(el("p","row-detail","Aucune équipe récente n’est disponible dans les données LoSP. Aucune collecte supplémentaire n’a été lancée."));
  }
  if(!status.scopes.includes("m3p.f.pr.inv"))box.append(el("p","row-detail","Ton compte MSF n’autorise pas l’inventaire; seules les quantités ajoutées sont disponibles."));
  if(state.characters.length===0)box.append(el("p","row-detail","Le catalogue de personnages est indisponible; certains objectifs ne peuvent pas encore être évalués."));
}
async function loadOverview(){
  state.refreshing=false;
  state.rosterResolved=false;
  $("refresh").disabled=true;$("event-count").textContent="Chargement des événements personnels…";
  const session=await api({resource:"status"}).catch(error=>({status:"disconnected",reason:error?.body?.reason||error?.body?.error||"session-unavailable"}));
  const namespace=typeof session.storageNamespace==="string"&&SESSION_NAMESPACE_RX.test(session.storageNamespace)?session.storageNamespace:null;
  if(session.status!=="connected"||!namespace){
    clearPersonalState();renderConnection(session);renderEvents();
    if(state.tab==="objectives")renderObjectives();if(state.tab==="plan")renderPlan();if(state.tab==="stock")renderStock();
    state.refreshing=false;$("refresh").disabled=false;return;
  }
  if(state.storageNamespace!==namespace){const requestedEventId=state.initialEventId;clearPersonalState();state.initialEventId=requestedEventId;loadLocal(namespace);}
  renderConnection(session);
  const [french,roster,consumables,isoitems]=await Promise.all([
    personalApi({resource:"events",lang:"fr"}),personalApi({resource:"roster",lang:"fr"}),
    personalApi({resource:"inventory",itemType:"CONSUMABLE",lang:"fr"}),
    personalApi({resource:"inventory",itemType:"ISOITEM",lang:"fr"}),
    Promise.all([loadCatalog(),loadCalendar()])
  ]);
  if(french.error){banner("Les événements ne sont pas disponibles pour le moment.","error");$("event-count").textContent="Événements indisponibles";$("events-list").replaceChildren(el("p","warning","Le compte est connecté, mais la liste des événements n’est pas disponible."));state.refreshing=false;$("refresh").disabled=false;return;}
  state.eventsFr=Array.isArray(french.data)?french.data:[];
  // The Maddoxx adapter expects an English-named source and French display copy.
  // Here both point to the sole authorized French response; unrecognized text stays unknown.
  state.eventsEn=state.eventsFr;
  state.roster=Array.isArray(roster.data)?roster.data:null;state.rosterRetrievedAt=roster.retrievedAt||null;state.rosterResolved=true;
  const invOk=[consumables,isoitems].some(result=>!result.error);
  state.inventory=invOk?{}:null;state.inventoryReason=consumables.error||isoitems.error||null;
  state.inventoryTypes={};
  if(state.inventory){installInventoryResult("CONSUMABLE",consumables);installInventoryResult("ISOITEM",isoitems);}
  buildObservations();renderEvents();
  if(state.initialEventId){
    const requestedId=state.initialEventId;state.initialEventId=null;
    const requested=activeEvents().find(event=>String(event.id)===requestedId&&!state.skipped.has(requestedId));
    if(requested)showSelected(requested.id);
    else{const notice=el("p","warning","Cet événement ne figure pas dans le calendrier LoSP actif ou est ignoré. Aucune fiche personnelle supplémentaire n’a été demandée.");notice.setAttribute("role","status");$("events-list").prepend(notice);}
  }else if(state.selectedId&&state.tab==="events")showSelected(state.selectedId);
  if(state.calendarError)banner("Le catalogue de présentation LoSP est indisponible : les événements personnels non filtrés sont masqués.","warning");
  renderConnection(session);
  state.refreshing=false;$("refresh").disabled=false;
}

$("refresh").addEventListener("click",()=>loadOverview());
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
  if(button.dataset.action==="select-feeder"){showSelected(id);return;}
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
