// One-click launcher for the background /player campaign.
// No OAuth session selection, no individual families, and no polling.
(()=>{
  "use strict";
  const start=document.getElementById("player-campaign-start");
  const refresh=document.getElementById("player-campaign-refresh");
  const status=document.getElementById("player-campaign-status");
  const report=document.getElementById("player-campaign-report");
  const labels={
    "not-started":"Aucune campagne encore enregistrée",
    running:"Collecte en cours, poursuivie automatiquement",
    complete:"Collecte terminée",
    partial:"Collecte terminée avec certaines données indisponibles"
  };
  function render(data){
    report.replaceChildren();
    const title=document.createElement("strong");
    title.textContent=labels[data.status]||"État : "+(data.status||"indisponible");
    report.append(title);
    if(data.autoEnabled){
      const p=document.createElement("p");
      p.textContent="Synchronisation automatique active · cadence : "+ 
        (data.intervalHours||24)+" h après la fin du cycle. "+
        (data.status==="not-started"?"Première exécution au prochain Cron. ":"")+
        (data.nextRunAt?"Prochaine vérification prévue : "+
        new Date(data.nextRunAt).toLocaleString("fr-FR")+".":"");
      report.append(p);
    }else{
      const p=document.createElement("p");
      p.textContent="Synchronisation automatique désactivée.";
      report.append(p);
    }
    if(data.status==="not-started")return;
    const rows=[
      ["Type de collecte",data.mode==="automatic-daily"?"Automatique":
        data.mode==="admin-manual"?"Manuelle":"Ancienne campagne"],
      ["Comptes OAuth trouvés",data.connectedAccounts],
      ["Comptes entièrement parcourus",data.accountsProcessed],
      ["Nouvelles archives",data.saved],
      ["Archives récentes réutilisées",data.alreadyPresent],
      ["Équipes partagées archivées",data.sharedSquads],
      ["Accès absents ou non autorisés",data.skipped],
      ["Échecs",data.failed],
      ["Dernière actualisation",data.updatedAt],
      ["Prochain essai après",data.nextAttemptAt||"aucune attente"]
    ];
    for(const [label,value] of rows){
      const p=document.createElement("p");
      p.textContent=label+" : "+String(value??"—");
      report.append(p);
    }
    if(data.status==="running"){
      const p=document.createElement("p");
      p.textContent="La collecte continue même si tu quittes cette page. "+
        "Les rosters et fiches d’alliance restent gérés par leur collecteur existant.";
      report.append(p);
    }
  }
  async function call(method){
    const r=await fetch("/admin/api/player-campaign",{
      method,credentials:"same-origin",cache:"no-store",
      headers:method==="POST"?{"Content-Type":"application/json",Accept:"application/json"}:
        {Accept:"application/json"},
      ...(method==="POST"?{body:JSON.stringify({action:"start"})}:{})
    });
    let body;try{body=await r.json();}catch{throw Error("HTTP "+r.status);}
    if(!r.ok)throw Error(body.error||"HTTP "+r.status);
    return body;
  }
  async function work(method){
    start.disabled=refresh.disabled=true;
    status.textContent=method==="POST"?
      "Lancement de la collecte des comptes connectés…" :
      "Lecture de l’avancement enregistré dans R2…";
    try{
      const result=await call(method);
      render(result);
      status.textContent=result.status==="running"?
        "Collecte lancée : le Worker poursuit par petits lots.":
        labels[result.status]||"Statut actualisé.";
    }catch(error){status.textContent="Opération impossible : "+error.message;}
    finally{start.disabled=refresh.disabled=false;}
  }
  start.addEventListener("click",()=>work("POST"));
  refresh.addEventListener("click",()=>work("GET"));
})();