// Admin-only roster synchronization preflight. No roster reads or publication.
// Alliance approval is an explicit action independent of OAuth consent.
const rosterEl=id=>document.getElementById(id);
let rosterSnapshot=null;
function rosterClear(){
  rosterSnapshot=null;
  rosterEl("roster-preflight-list").replaceChildren();
  rosterEl("roster-approve").disabled=true;
}
function rosterLine(parent,text,tag="p"){
  const node=document.createElement(tag);
  node.textContent=text;
  parent.appendChild(node);
  return node;
}
// Deliberately on-demand and bounded to one co-member; results stay in R2.
async function runPrivateRosterPilot(alliance,button,status){
  button.disabled=true;
  status.textContent="Lecture complète du premier roster partagé de "+
    alliance.name+" en cours…";
  try{
    const response=await fetch("/admin/api/roster-pilot",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprint:alliance.fingerprint})
    });
    const result=await response.json();
    if(!response.ok||result.status!=="stored")
      throw Error(typeof result.status==="string"?result.status:"unknown-error");
    status.textContent="Pilote enregistré dans R2 privé : "+
      result.player+" — "+result.characters+" personnages, "+
      result.pages+" page(s), "+result.requests+
      " appels. Expire le "+new Date(result.expiresAt).toLocaleDateString("fr-FR")+
      ". Aucune transmission à la WebApp.";
  }catch(e){
    status.textContent="Pilote non enregistré : "+(e.message||"indisponible")+
      ". Aucune donnée partielle n'a été sauvegardée.";
  }finally{button.disabled=false;}
}
async function rosterBatchStatus(alliance,status){
  try{
    const response=await fetch("/admin/api/roster-batch-status?fingerprint="+
      encodeURIComponent(alliance.fingerprint),{credentials:"same-origin",cache:"no-store"});
    const state=await response.json();
    if(!response.ok)throw Error("status");
    if(state.status==="not-started")status.textContent="Aucun micro-lot enregistré.";
    else status.textContent="Progression des coéquipiers partagés : "+
      state.completed+"/"+state.eligibleCoMembers+" ; état : "+state.status+
      (state.expiresAt?" ; expiration "+new Date(state.expiresAt).toLocaleDateString("fr-FR"):"");
    return state;
  }catch{
    status.textContent="État de progression indisponible.";
    return null;
  }
}
async function rosterBatchStart(alliance,button,status,restart=false,refresh=false){
  button.disabled=true;
  status.textContent="Collecte de deux coéquipiers maximum en cours…";
  try{
    const response=await fetch("/admin/api/roster-batch",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprint:alliance.fingerprint,
        ...(restart?{restart:true}:{}),...(refresh?{refresh:true}:{})})
    });
    const result=await response.json();
    if(!response.ok){
      if(["membership-changed-restart-required","expired-restart-required"].includes(result.status)){
        status.textContent="Effectif modifié ou collecte expirée : redémarrage nécessaire.";
        const reset=document.createElement("button");
        reset.type="button";
        reset.textContent="Recommencer cette alliance depuis zéro";
        reset.addEventListener("click",async()=>{
          reset.disabled=true;
          await rosterBatchStart(alliance,button,status,true);
          reset.remove();
        },{once:true});
        status.parentNode.appendChild(reset);
        return;
      }
      throw Error(result.status||"batch-error");
    }
    const state=await rosterBatchStatus(alliance,status);
    const refreshButton=status.parentNode.querySelector(".roster-refresh");
    if(refreshButton)refreshButton.disabled=state?.status!=="complete-co-members";
    if(result.savedThisBatch)
      status.textContent+=" — dernier lot : "+result.savedThisBatch+
        " roster(s), "+result.charactersThisBatch+" personnages, "+
        result.pagesThisBatch+" page(s), "+result.requestsThisBatch+
        " appels Scopely (dont "+result.unchangedThisBatch+
        " roster(s) inchangé(s)) ; aucune transmission à la WebApp.";
  }catch(e){
    status.textContent="Lot non validé : "+(e.message||"indisponible")+
      ". Progression précédente conservée.";
  }finally{button.disabled=false;}
}
async function loadRosterPreflight(){
  const btn=rosterEl("roster-preflight"),status=rosterEl("roster-preflight-status"),
    parent=rosterEl("roster-preflight-list");
  rosterClear();status.textContent="Lecture de la couverture Scopely actuelle…";
  rosterEl("roster-approve-status").textContent="";
  btn.disabled=true;
  try{
    const response=await fetch("/admin/api/roster-preflight",{
      credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
    });
    const report=await response.json();
    if(!response.ok||report.mode!=="approval-preflight-only"||
       !Array.isArray(report.alliances))throw Error("preflight-failed");
    rosterSnapshot=report;
    rosterLine(parent,report.alliances.length+" alliance(s) détectée(s), "+
      report.scannedSessions+" connexion(s). Registre : "+
      (report.registryStatus==="configured"?"déjà configuré":"à initialiser")+".");
    for(const a of report.alliances){
      const label=document.createElement("label");
      const input=document.createElement("input");
      input.type="checkbox";
      input.className="roster-approval-choice";
      input.value=a.fingerprint;
      input.checked=a.approved===true;
      input.disabled=a.status!=="available"||!report.complete;
      label.appendChild(input);
      label.appendChild(document.createTextNode(" "+a.name+" — "+
        (a.memberCount??"?")+" membres ; "+(a.sharedCount??"?")+
        " partages ; "+(a.captainConnections??0)+" connexion(s) ; "+
        (a.status==="available"?"API accessible":"indisponible")));
      parent.appendChild(label);
      if(a.approved&&a.status==="available"){
        const pilot=document.createElement("button");
        pilot.type="button";
        pilot.textContent="Tester 1 roster — "+a.name;
        pilot.disabled=!report.complete;
        const progress=document.createElement("p");
        progress.setAttribute("role","status");
        pilot.addEventListener("click",()=>runPrivateRosterPilot(a,pilot,progress));
        parent.appendChild(pilot);
        parent.appendChild(progress);
        const advance=document.createElement("button");
        advance.type="button";
        advance.textContent="Collecter le prochain lot (2) — "+a.name;
        const batchProgress=document.createElement("p");
        batchProgress.setAttribute("role","status");
        advance.disabled=!report.complete;
        advance.addEventListener("click",()=>rosterBatchStart(a,advance,batchProgress));
        parent.appendChild(advance);
        const refresh=document.createElement("button");
        refresh.type="button";
        refresh.className="roster-refresh";
        refresh.textContent="Vérifier les changements (since / 344) — "+a.name;
        refresh.disabled=true;
        refresh.addEventListener("click",()=>rosterBatchStart(a,refresh,batchProgress,false,true));
        parent.appendChild(refresh);
        parent.appendChild(batchProgress);
        void rosterBatchStatus(a,batchProgress).then(state=>{
          refresh.disabled=state?.status!=="complete-co-members"||!report.complete;
        });
      }else parent.appendChild(document.createElement("p"));
    }
    for(const absent of report.unobservedApproved||[])
      rosterLine(parent,"Alliance approuvée mais non retrouvée aujourd'hui : "+
        absent.name+" (non disponible pour collecte).");
    rosterLine(parent,"Le nombre de partages ne garantit pas encore la lecture "+
      "complète des rosters. Le roster personnel du compte OAuth nécessitera "+
      "aussi un contrôle distinct.");
    status.textContent=report.complete?
      "Couverture complète : tu peux enregistrer ta sélection. "+
      "Cela N'ACTIVE PAS encore de collecte automatique.":
      "Couverture incomplète : aucune approbation possible. Vérifie les sessions OAuth.";
    rosterEl("roster-approve").disabled=!report.complete;
  }catch{
    status.textContent="Prévalidation indisponible ; aucune modification effectuée.";
  }finally{btn.disabled=false;}
}
async function submitRosterApprovals(){
  const button=rosterEl("roster-approve"),status=rosterEl("roster-approve-status");
  if(!rosterSnapshot?.complete)return;
  const choices=[...document.querySelectorAll(".roster-approval-choice")]
    .filter(c=>c.checked&&!c.disabled).map(c=>c.value);
  if(!choices.length){status.textContent="Choisis au moins une alliance.";return;}
  button.disabled=true;
  status.textContent="Enregistrement privé en cours…";
  try{
    const response=await fetch("/admin/api/roster-approvals",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprints:choices})
    });
    const body=await response.json();
    if(!response.ok||body.status!=="approved")throw Error("approval-failed");
    status.textContent=body.count+" alliance(s) approuvée(s) dans R2 privé. "+
      "Aucun roster téléchargé, aucun cron de collecte activé.";
    rosterClear(); // Require a fresh Scopely census before any new mutation.
  }catch{
    status.textContent="Enregistrement refusé ou indisponible. "+
      "Aucune activation de collecte n'a eu lieu.";
    button.disabled=false;
  }
}
rosterEl("roster-preflight").addEventListener("click",loadRosterPreflight);
rosterEl("roster-approve").addEventListener("click",submitRosterApprovals);
