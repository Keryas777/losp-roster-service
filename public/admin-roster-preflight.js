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
      parent.appendChild(document.createElement("p"));
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
