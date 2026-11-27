import {parseIsoCrystalId} from "./lib/iso-crystals.js";

const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;};
const date=value=>{const parsed=Date.parse(value||"");return Number.isFinite(parsed)?new Intl.DateTimeFormat("fr-FR",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/Paris"}).format(parsed):"indisponible";};
const quantity=value=>Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat("fr-FR").format(value):"inconnue";

function renderRoster(roster){
  const target=$("roster");target.replaceChildren();
  const rows=[["Résolution",roster.stage||roster.status],
    ["Dernière synchronisation",date(roster.retrievedAt)],
    ["Expiration",date(roster.expiresAt)],
    ["Personnages reçus",roster.characterCount]];
  for(const [label,value] of rows){const row=el("div","diag-row");row.append(el("span","",label),el("strong","",value));target.append(row);}
}
function renderInventories(inventories){
  const target=$("inventory");target.replaceChildren();
  for(const snapshot of inventories||[]){
    const section=el("section","admin-diag-inventory");
    section.append(el("h3","",`${snapshot.itemType} · ${snapshot.status} · ${snapshot.rows.length} entrées`));
    section.append(el("p","muted",`Mise en cache : ${date(snapshot.retrievedAt)} · consultation sans actualisation Scopely.`));
    const ids=new Set(snapshot.rows.map(row=>row.id));
    const counts={recognized:0,unknown:0};
    const list=el("div");
    for(const item of snapshot.rows){
      const parsed=snapshot.itemType==="ISOITEM"?parseIsoCrystalId(item.id):null;
      if(parsed){if(parsed.status==="unknown")counts.unknown++;else counts.recognized++;}
      const row=el("div","diag-row"),label=el("code","",item.id),meta=el("span","",parsed&&parsed.status!=="unknown"?`${parsed.tier} · niveau ${parsed.level} · ${parsed.characterClass} · ${parsed.category} · ${quantity(item.quantity)}`:quantity(item.quantity));
      row.append(label,meta);list.append(row);
    }
    if(snapshot.itemType==="ISOITEM")section.append(el("p","",`${ids.size} identifiants distincts · ${counts.recognized} reconnus · ${counts.unknown} inconnus ou incohérents`));
    if(!snapshot.rows.length)section.append(el("p","muted","Aucune donnée encore disponible dans le cache privé."));
    section.append(list);target.append(section);
  }
}
async function renderCatalog(){
  const target=$("catalog");target.replaceChildren();
  try{
    const response=await fetch("/admin/events-planner/data/msf-resource-catalog.json",{cache:"no-store"});
    if(!response.ok)throw Error("catalog-unavailable");
    const data=await response.json(),items=Array.isArray(data.items)?data.items:[];
    const ids=new Set(items.map(item=>item?.id).filter(Boolean));
    target.append(el("p","",`${ids.size} identifiants dans le catalogue statique. Traductions françaises : LoSP, sauf mention explicite dans la source.`));
  }catch{target.append(el("p","muted","Catalogue statique indisponible."));}
}
async function load(){
  $("status").textContent="Lecture des données privées en cache…";
  try{
    const response=await fetch("/admin/api/event-planner?resource=diagnostics",{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
    const body=await response.json();
    if(!response.ok||body.status!=="ok")throw Error("diagnostics-unavailable");
    renderRoster(body.roster);renderInventories(body.inventories);await renderCatalog();
    $("status").textContent="Données lues. Aucun appel de collecte n’a été déclenché.";
  }catch{$("status").textContent="Les diagnostics ne sont pas disponibles. Vérifie la session administrateur et le compte MSF connecté.";}
}
$("reload").addEventListener("click",load);
load();
