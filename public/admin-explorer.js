// Read-only admin UI. All values rendered through textContent, never HTML.
const el=id=>document.getElementById(id);
let sessions=[],nextCursor=null,catalog=[],lastPayload=null;
let memberChoiceSession=null; // Transient current membership only; IDs are never persisted.
const output=el("output"),info=el("status"),sessionSelect=el("session"),resourceSelect=el("resource");
const status=message=>{info.textContent=message;};
async function request(path){
  const res=await fetch(path,{credentials:"same-origin",cache:"no-store",
    headers:{Accept:"application/json"}});
  let data;
  try{data=await res.json();}catch{throw Error("Réponse non JSON (HTTP "+res.status+")");}
  if(!res.ok)throw Error(String(data.error||"HTTP "+res.status));
  return data;
}
function clear(node){node.replaceChildren();}
function node(tag,contents,parent,cls){
  const n=document.createElement(tag);
  if(contents!==undefined&&contents!==null)n.textContent=String(contents);
  if(cls)n.className=cls;
  if(parent)parent.appendChild(n);return n;
}
function button(label,fn,parent){const b=node("button",label,parent);b.type="button";b.onclick=fn;return b;}
// Display-only cleanup: MSF alliance labels contain markup-like color tags.
// Never modify the original API name, identifiers or official payloads.
function displayAllianceName(value){
  const name=String(value??"").replace(/<#[a-f0-9]{6}>/gi,"").replace(/\s+/g," ").trim();
  return name.replace(/^(LoSP\s+){2,}/i,"LoSP ");
}
// The last official color marker belongs to the alliance name, not the LoSP prefix.
function allianceColor(value){
  const tags=String(value??"").match(/<#[a-f0-9]{6}>/gi);
  return tags?.length?"#"+tags[tags.length-1].slice(2,-1):null;
}
function allianceDisplay(value){
  return {__adminAlliance:true,
    label:displayAllianceName(value),
    color:allianceColor(value)};
}
// Shared display tokens for future alliance cards, borders and tinted backgrounds.
// Color is strictly parsed from Scopely's #RRGGBB marker, never arbitrary CSS.
function applyAllianceTheme(element,color){
  element.classList.toggle("alliance-themed",Boolean(color));
  for(const property of ["--alliance-color","--alliance-surface","--alliance-outline"]){
    element.style.removeProperty(property);
  }
  if(color){
    element.style.setProperty("--alliance-color",color);
    element.style.setProperty("--alliance-surface",color+"18");
    element.style.setProperty("--alliance-outline",color+"80");
  }
}
// Alliance member IDs contain a changing membership version. Display the
// current Scopely player name instead and never use these IDs as stable keys.
function displayPlayerName(value){
  const name=typeof value==="string"?
    value.replace(/<#[a-f0-9]{6}>/gi,"").trim():"";
  return name||"Pseudo indisponible";
}
function sharedMemberChoices(members){
  return members.filter(m=>m?.card?.rosterShare===true &&
    m?.isSelf!==true && typeof m?.id==="string" && m.id.length>0)
    .map(m=>({id:m.id,name:displayPlayerName(m.card?.name)}));
}
function fillMemberOptions(members){
  const select=el("member");clear(select);
  memberChoiceSession=sessionSelect.value;
  const choices=sharedMemberChoices(members);
  const placeholder=node("option",choices.length?"Choisir un joueur…":"Aucun roster partagé",select);
  placeholder.value="";
  for(const member of choices){
    const option=node("option",member.name,select);
    option.value=member.id;
  }
  select.value="";
}
function resetMemberOptions(){
  memberChoiceSession=null;
  const select=el("member");clear(select);
  const option=node("option","Charger d'abord les membres de l'alliance",select);
  option.value="";
  select.value="";
}
function renderAllianceMembers(members,parent){
  const missing=members.filter(m=>m?.card?.rosterShare===false);
  node("p",members.length+" membres — "+missing.length+
    " partage(s) désactivé(s).",parent);
  if(missing.length){
    node("p","Partage désactivé : "+
      missing.map(m=>displayPlayerName(m.card?.name)).join(", "),parent,"share-warning");
  }
  const grid=node("div",null,parent,"members-grid");
  // Unshared members first; original API order and data remain untouched.
  const sorted=[...members].sort((a,b)=>
    Number(b?.card?.rosterShare===false)-Number(a?.card?.rosterShare===false));
  for(const member of sorted){
    const shared=member?.card?.rosterShare;
    const card=node("article",null,grid,"member-card"+(shared===false?" member-unshared":""));
    node("strong",displayPlayerName(member?.card?.name),card,"member-name");
    const role=member?.rank==="leader"?"Chef d'alliance":
      member?.rank==="captain"?"Capitaine":"Membre";
    node("span",role+(member?.isSelf===true?" (compte connecté)":""),card,"member-role");
    node("span",shared===true?"Roster partagé":shared===false?
      "Partage désactivé":"Partage indéterminé",card,
      "member-sharing"+(shared===false?" member-sharing-off":""));
    if(shared===true && member?.isSelf!==true && typeof member?.id==="string" &&
       memberChoiceSession===sessionSelect.value){
      button("Voir son roster",()=>{
        resourceSelect.value="alliance-roster";
        toggleMember();
        el("member").value=member.id;
        loadResource();
      },card);
    }
    jsonDetails(member,card,"Détails techniques");
  }
}
function jsonDetails(value,parent,label="Tous les champs"){
  const details=node("details",null,parent),summary=node("summary",label,details);
  const pre=node("pre",JSON.stringify(value,null,2),details);
  return details;
}
function tableFor(rows,parent){
  if(!rows.length){node("p","Aucun enregistrement sur cette page.",parent);return;}
  const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))].slice(0,60);
  const scroll=node("div",null,parent,"scroll"),table=node("table",null,scroll);
  const head=node("thead",null,table),tr=node("tr",null,head);
  columns.forEach(c=>node("th",c,tr));
  node("th","Détails",tr);
  const body=node("tbody",null,table);
  for(const [idx,row] of rows.entries()){
    const r=node("tr",null,body);
    for(const c of columns){
      const value=row[c];
      const cell=node("td",null,r);
      if(c==="Alliance" && value?.__adminAlliance===true){
        const name=node("span",value.label,cell,"alliance-name");
        if(value.color){
          name.style.color=value.color;
          applyAllianceTheme(r,value.color);
        }
      }else{
        node("span",value===null?"null":value===undefined?"—":
          typeof value==="object"?"[…]" : String(value),cell);
      }
    }
    const cell=node("td",null,r);
    jsonDetails(row,cell,"Ligne "+(idx+1));
    if(resourceSelect.value==="alliance-members" && row?.card?.rosterShare===true &&
       row.isSelf!==true && typeof row.id==="string"){
      button("Voir son roster partagé",()=>{
        resourceSelect.value="alliance-roster";
        toggleMember();
        el("member").value=row.id;
        loadResource();
      },cell);
    }
    if(resourceSelect.value==="personal-roster" && typeof row.id==="string"){
      button("Fiche officielle du personnage",()=>{
        resourceSelect.value="game-character";toggleMember();
        el("entity").value=row.id;loadResource();
      },cell);
    }
  }
}
function renderPayload(response){
  clear(output);
  lastPayload=response;
  node("h2","Réponse intégrale : "+response.resource,output);
  node("p","Reçue le "+response.receivedAt+" — données en direct, non enregistrées dans LoSP.",output);
  const payload=response.payload;
  const data=payload.data;
  const controls=node("div",null,output,"actions");
  button("Copier le JSON complet",async()=>{
    try{await navigator.clipboard.writeText(JSON.stringify(payload,null,2));status("JSON copié.");}
    catch{status("Copie non autorisée dans ce navigateur.");}
  },controls);
  button("Afficher tous les champs JSON",()=>{const d=el("raw");d.open=!d.open;},controls);
  button("Exporter le JSON (local)",()=>{
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");
    a.href=url;a.download="msf-"+response.resource+".json";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  },controls);
  if(Array.isArray(data)){
    if(response.resource==="alliance-members"){
      fillMemberOptions(data);
      renderAllianceMembers(data,output);
    }else{
      node("p",data.length+" entrées renvoyées dans cette page.",output);
      tableFor(data.map(v=>v&&typeof v==="object"?v:{valeur:v}),output);
    }
  }else if(data&&typeof data==="object"){
    const rows=Object.entries(data).map(([champ,valeur])=>({champ,
      valeur:typeof valeur==="object"?JSON.stringify(valeur):valeur}));
    tableFor(rows,output);
  }else node("p","Donnée : "+String(data),output);
  // Includes every provider field, even fields not represented in summary tables.
  const raw=node("details",null,output),label=node("summary","Réponse API brute (data, meta et tout champ supplémentaire)",raw);
  raw.id="raw";node("pre",JSON.stringify(payload,null,2),raw);
}
function renderAllianceOverview(){
  const target=el("alliances");clear(target);
  const groups=new Map();
  for(const account of sessions){
    const id=account.allianceId||"inconnue:"+account.id;
    const prev=groups.get(id)||{
      name:account.allianceName||"Alliance indisponible",
      card:account.allianceDetails||{},accounts:[]
    };
    prev.accounts.push(account);
    groups.set(id,prev);
  }
  const rows=[...groups.values()].map(group=>({
    Alliance:allianceDisplay(group.name),
    Comptes:group.accounts.length,
    "Comptes MSF":group.accounts.map(a=>a.playerName||"(inconnu)").join(", "),
    warRank:group.card.warRank??"—",
    warLeague:typeof group.card.warLeague==="object"?
      JSON.stringify(group.card.warLeague):group.card.warLeague??"—",
    warTrophies:group.card.warTrophies??"—",
    Statut:group.accounts.some(a=>a.status==="active")?"active":"à vérifier"
  }));
  tableFor(rows,target);
}
async function loadCoverage(){
  const button=el("check-coverage"),message=el("coverage-status"),target=el("coverage");
  button.disabled=true;
  message.textContent="Vérification des sessions et des membres en cours…";
  clear(target);
  try{
    const scan=await request("/admin/api/coverage");
    const confirmed=scan.alliances.filter(a=>a.status==="available").length;
    const count=scan.alliances.length;
    const complete=scan.complete===true;
    message.textContent=scan.scannedSessions+" session(s) vérifiée(s), "+
      count+" alliance(s) distincte(s), "+confirmed+" disponible(s). "+
      (complete?"Bilan complet des sessions enregistrées.":"Bilan partiel : sessions indisponibles ou limite atteinte.");
    const rows=scan.alliances.map(a=>({
      Alliance:allianceDisplay(a.name),
      "Connexions autorisées":a.captainConnections,
      Membres:a.memberCount??"—",
      "Rosters partagés":a.sharedCount??"—",
      "Partages désactivés":a.notSharedCount??"—",
      Statut:a.status==="available"?"Disponible":a.status
    }));
    tableFor(rows,target);
    node("p","Relevé du "+scan.observedAt+" (UTC). Aucun roster de personnage n'a été téléchargé ni sauvegardé.",target);
    if(scan.unavailableSessions){
      node("p",scan.unavailableSessions+" session(s) indisponible(s). La couverture ne peut pas être considérée comme exhaustive.",target);
    }
  }catch(error){message.textContent="Couverture indisponible : "+error.message;}
  finally{button.disabled=false;}
}
function makeOptions(){
  clear(resourceSelect);
  for(const item of catalog){
    const opt=node("option",item.label,resourceSelect);
    opt.value=item.id;
  }
  resourceSelect.value="alliance-members";
  toggleMember();
}
function toggleMember(){
  el("member-wrap").hidden=resourceSelect.value!=="alliance-roster";
  el("entity-wrap").hidden=!catalog.some(v=>v.id===resourceSelect.value &&
    v.path.endsWith("/") && v.id!=="alliance-roster");
  el("pages-wrap").hidden=!["personal-roster","personal-inventory",
    "personal-wishlist","personal-events","alliance-roster",
    "game-characters","game-events"].includes(resourceSelect.value);
}
resourceSelect.addEventListener("change",toggleMember);
sessionSelect.addEventListener("change",resetMemberOptions);
resetMemberOptions();
function updateSelectedAllianceColor(){
  const selected=sessions.find(s=>s.id===sessionSelect.value);
  const color=allianceColor(selected?.allianceName);
  sessionSelect.style.color=color||"";
  applyAllianceTheme(sessionSelect,color);
}
sessionSelect.addEventListener("change",updateSelectedAllianceColor);
async function loadSessions(reset=true){
  try{
    if(reset){sessions=[];nextCursor=null;}
    const query=nextCursor?"?cursor="+encodeURIComponent(nextCursor):"";
    status("Lecture des sessions chiffrées…");
    const data=await request("/admin/api/sessions"+query);
    sessions.push(...data.sessions);nextCursor=data.nextCursor;
    const selected=sessionSelect.value;
    clear(sessionSelect);
    for(const session of sessions){
      const option=node("option",null,sessionSelect);
      option.value=session.id;
      option.textContent=(session.allianceName?displayAllianceName(session.allianceName):"Alliance non identifiée")+" / "+
        (session.playerName||"Compte non identifié")+" — "+session.status;
      option.style.color=allianceColor(session.allianceName)||"";
    }
    if(selected&&sessions.some(s=>s.id===selected))sessionSelect.value=selected;
    if(memberChoiceSession!==sessionSelect.value)resetMemberOptions();
    updateSelectedAllianceColor();
    el("more").hidden=!nextCursor;
    const count=new Set(sessions.filter(s=>s.allianceId).map(s=>s.allianceId)).size;
    el("summary").textContent=sessions.length+" connexion(s) analysée(s), "+count+
      " alliance(s) distincte(s) identifiée(s). Les changements d’alliance sont relus en direct.";
    renderAllianceOverview();
    status("Sessions prêtes.");
  }catch(err){status("Accès impossible : "+err.message);}
}
async function loadResource(){
  if(!sessionSelect.value){status("Aucune session disponible.");return;}
  const currentSession=sessionSelect.value;
  const resource=resourceSelect.value,query=new URLSearchParams({
    session:sessionSelect.value,resource
  });
  if(!el("pages-wrap").hidden){
    query.set("page",el("page").value);
    query.set("perPage",el("perPage").value);
  }
  const definition=catalog.find(v=>v.id===resource);
  if(definition?.path.endsWith("/")&&resource!=="alliance-roster"){
    const entity=el("entity").value.trim();
    if(!entity){status("Indique l’identifiant du détail souhaité.");return;}
    query.set("entity",entity);
  }
  if(resource==="alliance-roster"){
    const member=el("member").value.trim();
    if(memberChoiceSession!==currentSession || !member){
      status("Charge d'abord les membres de cette alliance et choisis un pseudo.");
      return;
    }
    query.set("member",member);
  }
  el("load").disabled=true;
  try{status("Lecture de l’API officielle…");const res=await request("/admin/api/data?"+query);
    if(currentSession!==sessionSelect.value){
      status("Compte changé pendant la requête : recharge les membres de la nouvelle alliance.");
      return;
    }
    renderPayload(res);status("Réponse complète reçue. Pagination manuelle si nécessaire.");}
  catch(err){status("Requête impossible : "+err.message);}
  finally{el("load").disabled=false;}
}
el("load").onclick=loadResource;
el("refresh").onclick=()=>loadSessions(true);
el("check-coverage").onclick=loadCoverage;
el("more").onclick=()=>loadSessions(false);
async function init(){
  try{
    const c=await request("/admin/api/catalog");catalog=c.resources;
    makeOptions();await loadSessions();
  }catch(err){status("Panneau désactivé ou accès administrateur non autorisé : "+err.message);}
}
init();
