// Private admin control for post-reward Infos.
// GET is R2-only. Manual start queues a resumable campaign AND immediately
// processes two independently bounded alliance requests in parallel.
(()=>{
  "use strict";
  const start=document.getElementById("reward-info-manual-start");
  const refresh=document.getElementById("reward-info-manual-refresh");
  const status=document.getElementById("reward-info-manual-status");
  const report=document.getElementById("reward-info-manual-report");
  if(!start||!refresh||!status||!report)return;
  let busy=false;
  const labels={
    "not-started":"Aucun relevé manuel lancé aujourd'hui",
    running:"Relevé en cours — le cron poursuit si tu fermes cette page",
    complete:"Relevé terminé pour toutes les alliances approuvées",
    partial:"Relevé partiel disponible",
    expired:"Fenêtre manuelle expirée — une reprise peut être demandée",
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
      ["Reprise autorisée jusqu'à",data.expiresAt?
        new Date(data.expiresAt).toLocaleString("fr-FR",{timeZone:"Europe/Paris"}):"—"]
    ];
    for(const [label,value] of details){
      const p=document.createElement("p");
      p.textContent=label+" : "+(value??"—");
      report.append(p);
    }
    if(!busy)status.textContent=labels[data.status]||"État : "+(data.status||"indisponible");
    start.textContent=data.status==="running"?
      "Accélérer / reprendre la collecte maintenant":
      "Collecter les Infos maintenant";
    start.disabled=busy||!data.eligible||
      ["complete","disabled","retention-not-confirmed",
        "storage-unavailable","no-approved-alliances"].includes(data.status);
  }
  async function request(method,body){
    const response=await fetch("/admin/api/reward-infos-manual",{
      method,credentials:"same-origin",cache:"no-store",
      headers:method==="POST"?
        {"Content-Type":"application/json",Accept:"application/json"}:
        {Accept:"application/json"},
      ...(method==="POST"?{body:JSON.stringify(body)}:{})
    });
    let data;
    try{data=await response.json();}catch{throw Error("HTTP "+response.status);}
    if(!response.ok)throw Error(labels[data.status]||data.status||"HTTP "+response.status);
    return data;
  }
  async function refreshStatus(){
    const state=await request("GET");
    render(state);
    return state;
  }
  async function burst(total){
    // One HTTP call per alliance; TWO in flight. Every request has its own
    // Free Worker external subrequest allowance and its own R2 lock.
    // Partial alliances can resume without inventing a new campaign.
    let done=0,issues=0;
    for(let index=0;index<total;index+=2){
      const pair=[index,index+1].filter(i=>i<total);
      const results=await Promise.all(pair.map(async i=>{
        let result;
        for(let attempt=0;attempt<3;attempt++){
          result=await request("POST",{action:"collect",index:i});
          if(result.status!=="partial")break;
        }
        return result;
      }).map(p=>p.catch(error=>({status:"failed",error}))));
      done+=pair.length;
      issues+=results.filter(x=>x.status!=="complete").length;
      status.textContent="Collecte accélérée : "+done+" / "+total+
        " alliances traitées"+(issues?" ; certaines restent à reprendre.":".");
    }
    const latest=await refreshStatus();
    status.textContent=latest.status==="complete"?
      labels.complete:
      "Relevé partiel : "+latest.alliancesComplete+" / "+
      latest.alliancesTotal+" alliances terminées. "+
      "La reprise automatique reste active ; tu peux relancer l'accélération.";
  }
  async function work(manual){
    if(busy)return;
    busy=true;
    start.disabled=refresh.disabled=true;
    status.textContent=manual?
      "Déclenchement du relevé puis collecte accélérée…":
      "Lecture de la progression R2…";
    try{
      if(manual){
        const current=await request("POST",{});
        if(current.status!=="complete"){
          const total=current.alliancesTotal;
          if(!Number.isSafeInteger(total)||total<1||total>100)
            throw Error("Nombre d'alliances invalide");
          await burst(total);
        }else render(current);
      }else await refreshStatus();
    }catch(error){
      status.textContent="Opération impossible : "+
        (error instanceof Error?error.message:"indisponible")+
        ". Le cron conserve les progrès enregistrés.";
    }finally{
      busy=false;
      refresh.disabled=false;
      try{render(await request("GET"));}
      catch{start.disabled=false;}
    }
  }
  start.addEventListener("click",()=>work(true));
  refresh.addEventListener("click",()=>work(false));
  // Initial view reads private R2 only. No accidental provider calls.
  void work(false);
})();
