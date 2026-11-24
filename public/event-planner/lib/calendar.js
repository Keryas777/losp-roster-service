// Private planner counterpart of the public calendar rules in docs/evenements.js.
// Keep the classification, family collapse and ordering aligned with that file.
const GAME_GROUPS=[
  {key:"phases",label:"Phases",icon:"📋"},
  {key:"command",label:"Poste de commandement",icon:"🛡️"},
  {key:"events",label:"Événements",icon:"⚔️"}
];
const NON_EVENT_TYPES=new Set(["raid","raidSeason","warSeason","strikePass","battlePass","blitz","donation","info"]);
const MAX_TEMPORARY_CAMPAIGN_DAYS=35;
const ONBOARDING_MILESTONES=new Set([
  "first s.t.r.i.k.e.","second s.t.r.i.k.e.","third s.t.r.i.k.e.","s.t.r.i.k.e. back",
  "s.t.r.i.k.e. : premier assaut","deuxieme s.t.r.i.k.e.","s.t.r.i.k.e. : troisieme assaut","coup du s.t.r.i.k.e."
]);
const strip=value=>String(value??"").replace(/<[^>]*>/g,"").replace(/\s+/g," ").trim();
const cleanImage=url=>typeof url==="string"&&/^https:\/\/assets\.marvelstrikeforce\.com\/(?:key_art|imgs)\/[\w.%-]+\.(?:png|jpg|jpeg|webp)$/i.test(url)?url:"";
const eventNameKey=value=>strip(value).normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[’‘]/g,"'").toLocaleLowerCase("fr");
const category=(event,time)=>event.startTime*1000>time?"future":event.endTime*1000<=time?"past":"current";
const secondary=event=>Array.isArray(event.locationHints)&&(event.locationHints.includes("lohub_feeder")||event.locationHints.includes("mercy_orb"));

function isCalendarEvent(event){
  if(NON_EVENT_TYPES.has(event.type))return false;
  if(event.type==="episodic")return event.episodic?.type==="eventCampaign";
  if(event.type==="pickYourPoison")return true;
  if(event.type!=="milestone")return false;
  const name=eventNameKey(event.name);
  if(ONBOARDING_MILESTONES.has(name))return false;
  return !/(?:battle\s*pass|strike\s*pass|s\.t\.r\.i\.k\.e\.\s*pass)/i.test(event.name||"");
}
function calendarTierKey(event){
  const family=eventNameKey(event.name).replace(/\s*:\s*[ivxlcdm]+$/i,"");
  return [event.type,event.startTime,event.endTime,eventNameKey(event.subName),family].join("|");
}
function isTierCollection(event,events){
  if(event.type!=="milestone")return false;
  const key=calendarTierKey(event),family=events.filter(other=>other.type==="milestone"&&calendarTierKey(other)===key);
  return family.length>=3&&family.some(other=>/:\s*[ivxlcdm]+$/i.test(strip(other.name)));
}
function isLegacyTrial(event){
  const brackets=event.pickYourPoison?.brackets;
  if(Array.isArray(brackets)&&brackets.length>1)return true;
  const image=cleanImage(event.cardArt).split("/").pop()||"";
  return /(?:^Scourge_|_Scourge_)/i.test(image)&&!/Breaker/i.test(image);
}
function calendarGroup(event,events){
  if(event.type==="milestone"){
    const hints=Array.isArray(event.locationHints)?event.locationHints:[];
    if(hints.includes("lohub_wrapper"))return "command";
    if(hints.includes("lohub_feeder"))return null;
    if(hints.length||!strip(event.name)||isTierCollection(event,events))return null;
    return cleanImage(event.cardArt)&&cleanImage(event.popupArt)?"phases":null;
  }
  if(event.type==="pickYourPoison")return cleanImage(event.cardArt)&&!isLegacyTrial(event)?"events":null;
  if(event.type==="episodic"&&event.episodic?.type==="eventCampaign"&&
    Array.isArray(event.episodic.ids)&&event.episodic.ids.length&&
    event.endTime-event.startTime<=MAX_TEMPORARY_CAMPAIGN_DAYS*86400&&strip(event.name))return "events";
  return null;
}
function collapseCurrentEvents(items){
  const tierKeys=new Set(items.filter(event=>event.type==="milestone"&&!secondary(event)&&
    /:\s*[ivxlcdm]+$/i.test(strip(event.name))).map(calendarTierKey));
  const groups=new Map();
  for(const event of items){
    let kind="",key="id:"+event.id;
    if(event.type==="milestone"&&!secondary(event)&&tierKeys.has(calendarTierKey(event))){kind="tiers";key="tiers:"+calendarTierKey(event);}
    else if(event.type==="episodic"&&Array.isArray(event.episodic?.ids)&&event.episodic.ids.length){
      kind="editions";key="campaign:"+JSON.stringify([eventNameKey(event.name),eventNameKey(event.subName),event.episodic.type,[...event.episodic.ids].sort()]);
    }
    let group=groups.get(key);
    if(!group){groups.set(key,{event,kind,variants:[event]});continue;}
    group.variants.push(event);
    if((kind==="tiers"&&!/:\s*[ivxlcdm]+$/i.test(strip(event.name)))||
      (kind==="editions"&&event.startTime>group.event.startTime))group.event=event;
  }
  return [...groups.values()].map(group=>group.variants.length>1?
    {...group.event,calendarVariantKind:group.kind,calendarVariants:group.variants}:group.event);
}
function validSnapshot(data){
  return Array.isArray(data?.events)&&data.events.length>0&&data.events.length<=1000&&
    new Set(data.events.map(event=>event?.id)).size===data.events.length&&
    data.events.every(event=>event&&typeof event.id==="string"&&Number.isFinite(event.startTime)&&
      Number.isFinite(event.endTime)&&event.endTime>event.startTime&&typeof event.type==="string");
}
export function installCalendarSnapshot(data){
  if(!validSnapshot(data))throw new Error("Catalogue d’événements LoSP invalide");
  const events=data.events.filter(isCalendarEvent),allIds=new Set(data.events.map(event=>event.id));
  const selection=data.objectiveEligibility,checked=Date.parse(selection?.observedAt||""),published=Date.parse(data.updatedAt||"");
  const eligible=selection?.source==="scopely-player-level110-reference"&&selection.bracket==="85_and_up"&&
    Array.isArray(selection.eligibleEventIds)&&selection.eligibleEventIds.length>0&&
    selection.eligibleEventIds.every(id=>typeof id==="string"&&allIds.has(id))&&
    new Set(selection.eligibleEventIds).size===selection.eligibleEventIds.length&&
    Number.isFinite(checked)&&Number.isFinite(published)&&Math.abs(checked-published)<10*60000;
  return {events,eligibleEventIds:eligible?new Set(selection.eligibleEventIds):null,updatedAt:data.updatedAt||null,
    pages:data.pages??null,localizationStatus:data.localizationStatus||null};
}
export function currentCalendarGroups(events,eligibleEventIds=null,now=Date.now()){
  const active=events.filter(event=>category(event,now)==="current"&&calendarGroup(event,events)&&
    (!eligibleEventIds||!event.locationHints?.includes("lohub_wrapper")||eligibleEventIds.has(event.id)));
  const current=collapseCurrentEvents(active),rank=event=>GAME_GROUPS.findIndex(group=>group.key===calendarGroup(event,events));
  const title=event=>strip(event.name)||"Événement sans titre";
  current.sort((a,b)=>rank(a)-rank(b)||a.endTime-b.endTime||title(a).localeCompare(title(b),"fr"));
  return Object.fromEntries(GAME_GROUPS.map(group=>[group.key,current.filter(event=>calendarGroup(event,events)===group.key)]));
}
export function mergeCalendarEvent(catalogEvent,personalEvent){
  if(!personalEvent)return catalogEvent;
  const merge=(catalog,personal)=>{
    if(!catalog||typeof catalog!=="object"||Array.isArray(catalog)||!personal||typeof personal!=="object"||Array.isArray(personal))return personal??catalog;
    const result={...catalog};
    for(const [key,value] of Object.entries(personal)){
      if(value&&typeof value==="object"&&!Array.isArray(value)&&catalog[key]&&typeof catalog[key]==="object"&&!Array.isArray(catalog[key]))result[key]=merge(catalog[key],value);
      else result[key]=value;
    }
    return result;
  };
  const result=merge(catalogEvent,personalEvent);
  for(const key of ["cardArt","popupArt","hubArt","icon","locationHints","episodic"])
    if(catalogEvent[key]!=null&&(!Array.isArray(catalogEvent[key])||catalogEvent[key].length))result[key]=catalogEvent[key];
  return result;
}
export const calendarGroups=GAME_GROUPS;
export const calendarInternals={isCalendarEvent,calendarGroup,collapseCurrentEvents,secondary,calendarTierKey,validSnapshot};
