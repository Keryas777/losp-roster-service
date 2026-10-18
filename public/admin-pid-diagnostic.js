// Administrator-only, on-demand PID investigation.
// No persistence, analytics or logging; the expected in-game PID stays local.
// Uses an already-authorized, read-only API route for the selected OAuth account.
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
  result.replaceChildren();
  if(!selected || !/^[a-f0-9]{64}$/.test(selected)){
    status.textContent="Sélectionne d'abord un compte dans la rubrique Explorer.";
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
    const url="/admin/api/data?resource=player-card&session="+encodeURIComponent(selected);
    const response=await fetch(url,{credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}});
    const data=await response.json();
    if(!response.ok || data?.resource!=="player-card" ||
       typeof data?.payload?.data!=="object"){
      throw Error("Profil indisponible (HTTP "+response.status+").");
    }
    if(selected!==document.getElementById("session")?.value){
      status.textContent="Le compte sélectionné a changé : relance le diagnostic.";
      return;
    }
    const scan=analyzePidCard(data.payload.data,raw);
    if(scan.error)throw Error("Format de profil inattendu.");
    pidText("p","Profil lu : "+(scan.name||"pseudo indisponible"),result);
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
