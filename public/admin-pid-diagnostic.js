// Administrator-only, on-demand PID investigation.
// No persistence, analytics or logging; the expected in-game PID stays local.
// Uses read-only, admin-authenticated APIs. Member IDs are transient and
// server-revalidated on each targeted PlayerCard request.
const PID_SCHEMA_FIELDS=new Set([
  "name","icon","frame","level","tcp","stp","warMvp",
  "charactersCollected","charactersAtMaxStarRank","bestArena",
  "latestArena","latestBlitz","blitzWins","rosterShare",
  "application","aid","ad","qualifications","wwPoints"
]);
function looksLikeIdentityKey(key){
  const compact=String(key).replace(/[_-]/g,"").toLowerCase();
  return /^(?:id|pid|uid|playerid|playerpid|playeruid|commanderid|commanderpid|userid|userpid|accountid|accountpid|profileid|scopelyid|msfid)$/.test(compact);
}
function analyzePidCard(card,expectedPid=""){
  if(!card || typeof card!=="object" || Array.isArray(card))
    return {error:"invalid-card"};
  const name=typeof card.name==="string"?card.name:null;
  const unknownFields=Object.keys(card).filter(k=>!PID_SCHEMA_FIELDS.has(k)).slice(0,30);
  const candidates=[],matches=[];
  let examined=0;
  function walk(value,path,depth){
    if(depth>5 || examined>=400 || matches.length>=20)return;
    if(value===null || typeof value!=="object")return;
    if(Array.isArray(value)){
      for(let i=0;i<Math.min(value.length,20);i++){
        walk(value[i],path+"["+i+"]",depth+1);
      }
      return;
    }
    for(const [key,child] of Object.entries(value)){
      if(++examined>400)break;
      const field=path+"."+key;
      if(child!==null && (typeof child==="number" || typeof child==="string")){
        const scalar=typeof child==="number" && !Number.isSafeInteger(child)?
          null:String(child);
        if(scalar!==null){
          if(expectedPid && scalar===expectedPid && matches.length<20)
            matches.push(field);
          if(looksLikeIdentityKey(key) && /^\d{5,12}$/.test(scalar) &&
             candidates.length<20){
            candidates.push({field,value:scalar});
          }
        }
      }else if(child && typeof child==="object"){
        walk(child,field,depth+1);
      }
    }
  }
  walk(card,"data",0);
  return {name,unknownFields,candidates,matches,examined};
}
let pidMemberSession=null;
let pidMemberOptions=new Map();
function cleanPidName(name){
  return typeof name==="string"?name.replace(/<#[a-f0-9]{6}>/gi,"").trim():"";
}
function resetPidMembers(){
  pidMemberSession=null;
  pidMemberOptions=new Map();
  const select=document.getElementById("pid-target");
  select.replaceChildren();
  const option=document.createElement("option");
  option.value="";
  option.textContent="Compte connecté";
  select.appendChild(option);
  select.value="";
  document.getElementById("pid-members-status").textContent=
    "Pour comparer un coéquipier, charge les membres de l'alliance du compte sélectionné.";
}
async function loadPidMembers(){
  const button=document.getElementById("pid-load-members");
  const status=document.getElementById("pid-members-status");
  const session=document.getElementById("session")?.value;
  resetPidMembers();
  if(!session || !/^[a-f0-9]{64}$/.test(session)){
    status.textContent="Sélectionne un compte dans Explorer avant de charger ses membres.";
    return;
  }
  button.disabled=true;
  status.textContent="Chargement des joueurs de l'alliance actuelle…";
  try{
    const response=await fetch("/admin/api/data?resource=alliance-members&session="+
      encodeURIComponent(session),{credentials:"same-origin",cache:"no-store",
        headers:{Accept:"application/json"}});
    const result=await response.json();
    if(!response.ok || result.resource!=="alliance-members" ||
      !Array.isArray(result.payload?.data))throw Error("members-unavailable");
    if(document.getElementById("session")?.value!==session)return;
    const members=result.payload.data;
    if(members.filter(m=>m?.isSelf===true).length!==1)throw Error("invalid-members");
    const list=members.filter(m=>m?.isSelf!==true &&
        typeof m?.id==="string" && /^[A-Za-z0-9:_-]{1,256}$/.test(m.id) &&
        cleanPidName(m.card?.name))
      .map(m=>({id:m.id,name:cleanPidName(m.card.name)}))
      .sort((a,b)=>a.name.localeCompare(b.name,"fr"));
    const choices=new Map();
    const select=document.getElementById("pid-target");
    for(const m of list){
      if(choices.has(m.id))continue;
      const option=document.createElement("option");
      option.value=m.id;
      option.textContent=m.name;
      select.appendChild(option);
      choices.set(m.id,m.name);
    }
    pidMemberOptions=choices;
    pidMemberSession=session;
    status.textContent=list.length+" membre(s) proposé(s), selon l'effectif actuel. "+
      "Un joueur qui a quitté l'alliance ne peut pas être interrogé ici.";
  }catch{
    resetPidMembers();
    status.textContent="Impossible de charger les membres actuels ; réessaie.";
  }finally{button.disabled=false;}
}
function pidText(tag,text,parent){
  const elem=document.createElement(tag);
  elem.textContent=text;
  parent.appendChild(elem);
  return elem;
}
async function runPidDiagnostic(){
  const button=document.getElementById("pid-check");
  const status=document.getElementById("pid-status");
  const result=document.getElementById("pid-result");
  const selected=document.getElementById("session")?.value;
  const raw=document.getElementById("pid-expected").value.trim();
  const memberId=document.getElementById("pid-target").value;
  const memberName=memberId?pidMemberOptions.get(memberId):null;
  result.replaceChildren();
  if(!selected || !/^[a-f0-9]{64}$/.test(selected)){
    status.textContent="Sélectionne d'abord un compte dans la rubrique Explorer.";
    return;
  }
  if(memberId && (!memberName || pidMemberSession!==selected)){
    status.textContent="Liste des membres périmée. Recharge les membres du compte sélectionné.";
    return;
  }
  if(raw && !/^\d{5,12}$/.test(raw)){
    status.textContent="Le PID connu doit contenir de 5 à 12 chiffres, sans espace.";
    return;
  }
  button.disabled=true;
  status.textContent="Lecture du profil officiel Scopely…";
  try{
    // Only the opaque session selector reaches our authenticated server.
    // The manually entered PID is NEVER sent in a URL, request body or header.
    const url=memberId?
      "/admin/api/pid-member-card?session="+encodeURIComponent(selected)+
        "&member="+encodeURIComponent(memberId):
      "/admin/api/data?resource=player-card&session="+encodeURIComponent(selected);
    const response=await fetch(url,{credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}});
    const data=await response.json();
    if(!response.ok || data?.resource!==(memberId?"member-card":"player-card") ||
       typeof data?.payload?.data!=="object"){
      throw Error("Profil indisponible (HTTP "+response.status+").");
    }
    if(selected!==document.getElementById("session")?.value ||
      memberId!==document.getElementById("pid-target").value){
      status.textContent="Le compte sélectionné a changé : relance le diagnostic.";
      return;
    }
    const scan=analyzePidCard(data.payload.data,raw);
    if(scan.error)throw Error("Format de profil inattendu.");
    if(memberId && cleanPidName(scan.name)!==memberName){
      status.textContent="Le pseudo du membre a changé depuis la liste. "+
        "Recharge les membres avant toute comparaison de PID.";
      return;
    }
    pidText("p","Profil réellement lu : "+(scan.name||"pseudo indisponible"),result);
    pidText("p",memberId?
      "Comparaison avec le membre sélectionné : "+memberName:
      "Attention : la fiche est celle du COMPTE CONNECTÉ, pas celle d'un coéquipier.",result);
    pidText("p","Champs non documentés de premier niveau : "+
      (scan.unknownFields.length?scan.unknownFields.join(", "):"aucun"),result);
    pidText("p","Champs susceptibles de contenir un identifiant : "+
      (scan.candidates.length?
        scan.candidates.map(c=>c.field+" = "+c.value).join(" ; "):
        "aucun candidat numérique explicite"),result);
    if(raw){
      pidText("p",scan.matches.length?
        "Le PID saisi correspond exactement à la valeur du/des champ(s) : "+
          scan.matches.join(", ")+". La stabilité reste à vérifier après changement d'alliance.":
        "Le PID saisi n'apparaît dans aucune valeur examinée de cette fiche. "+
          "Cela ne prouve pas qu'il soit absent de toute l'API.",result);
    }else{
      pidText("p","Pour comparer à l'identifiant affiché dans le jeu, "+
        "saisis le PID de ce même compte et relance l'analyse.",result);
    }
    status.textContent="Diagnostic terminé. Aucun résultat ni PID saisi n'a été enregistré.";
  }catch{
    status.textContent="Diagnostic indisponible. Vérifie la session et réessaie.";
  }finally{button.disabled=false;}
}
document.getElementById("pid-check").addEventListener("click",runPidDiagnostic);
document.getElementById("pid-load-members").addEventListener("click",loadPidMembers);
document.getElementById("session").addEventListener("change",resetPidMembers);
resetPidMembers();
