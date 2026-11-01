// Private admin control for the independent post-reward Infos capture.
// Page load and refresh read R2 only; POST queues a one-day collection.
(()=>{
  "use strict";
  const start=document.getElementById("reward-info-manual-start");
  const refresh=document.getElementById("reward-info-manual-refresh");
  const status=document.getElementById("reward-info-manual-status");
  const report=document.getElementById("reward-info-manual-report");
  if(!start||!refresh||!status||!report)return;
  const labels={
    "not-started":"Aucun relevé manuel lancé aujourd'hui",
    running:"Relevé en cours — poursuite automatique même après fermeture de cette page",
    complete:"Relevé terminé pour toutes les alliances approuvées",
    partial:"Relevé partiel disponible",
    expired:"Fenêtre de collecte manuelle expirée — une reprise peut être demandée",
    disabled:"Collecte récompenses désactivée",
    "retention-not-confirmed":"Conservation R2 non confirmée",
    "storage-unavailable":"Stockage privé indisponible",
    "no-approved-alliances":"Aucune alliance approuvée",
    "before-reward-cutoff":"Disponible uniquement après 17 h 00, heure de Paris"
  };
  function render(data){
    report.replaceChildren();
    const details=[
      ["Date française",data.day],
      ["Alliances terminées",Number.isSafeInteger(data.alliancesComplete)&&
        Number.isSafeInteger(data.alliancesTotal)?
        data.alliancesComplete+" / "+data.alliancesTotal:"—"],
      ["Début du relevé manuel",data.startedAt?
        new Date(data.startedAt).toLocaleString("fr-FR",{timeZone:"Europe/Paris"}):"—"],
      ["Fenêtre de reprise jusqu'à",data.expiresAt?
        new Date(data.expiresAt).toLocaleString("fr-FR",{timeZone:"Europe/Paris"}):"—"]
    ];
    for(const [label,value] of details){
      const p=document.createElement("p");
      p.textContent=label+" : "+(value??"—");
      report.append(p);
    }
    status.textContent=labels[data.status]||"État : "+(data.status||"indisponible");
    start.disabled=!data.eligible||
      ["running","complete","disabled","retention-not-confirmed",
        "storage-unavailable","no-approved-alliances"].includes(data.status);
  }
  async function run(method){
    start.disabled=refresh.disabled=true;
    status.textContent=method==="POST"?
      "Enregistrement du lancement manuel dans R2…":
      "Lecture de la progression privée…";
    try{
      const response=await fetch("/admin/api/reward-infos-manual",{
        method,credentials:"same-origin",cache:"no-store",
        headers:method==="POST"?
          {"Content-Type":"application/json",Accept:"application/json"}:
          {Accept:"application/json"},
        ...(method==="POST"?{body:"{}"}:{})
      });
      const body=await response.json();
      if(!response.ok)throw Error(labels[body.status]||body.status||"HTTP "+response.status);
      render(body);
    }catch(error){
      status.textContent="Action impossible : "+(error instanceof Error?error.message:"indisponible");
      start.disabled=false;
    }finally{refresh.disabled=false;}
  }
  start.addEventListener("click",()=>run("POST"));
  refresh.addEventListener("click",()=>run("GET"));
  // No Scopely request or collection when the administration page is opened.
  void run("GET");
})();
