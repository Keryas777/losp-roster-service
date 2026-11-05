// Private R2-only Arena report for every currently approved LoSP or guest
// alliance. All strings rendered using textContent; no Scopely request.
(()=>{
  "use strict";
  const button=document.getElementById("arena-coverage-refresh");
  const status=document.getElementById("arena-coverage-status");
  const output=document.getElementById("arena-coverage-report");
  if(!button||!status||!output)return;
  const words={
    valid:"Reçu valide",missing:"Aucun reçu du jour",
    "not-due":"Collecte prévue à partir de 17h01",invalid:"Reçu non conforme",
    expired:"Reçu expiré",present:"Archivé", "missing-day":"Date absente",
    "partial-or-unmatched":"Écart entre reçu et historique",
    unverifiable:"Non vérifiable", unavailable:"Indisponible"
  };
  const line=(parent,content)=>{
    const p=document.createElement("p");p.textContent=content;parent.append(p);return p;
  };
  const time=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))?
    new Date(value).toLocaleString("fr-FR",{timeZone:"Europe/Paris"}):"—";
  async function load(){
    button.disabled=true;
    status.textContent="Lecture des preuves Arène privées (sans appel Scopely)…";
    try{
      const response=await fetch("/admin/api/arena-coverage",{
        credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
      });
      const data=await response.json();
      if(!response.ok||data.status!=="ok"||!Array.isArray(data.alliances))
        throw Error(data.error||"HTTP "+response.status);
      output.replaceChildren();
      line(output,"Journée : "+data.day+" · Reçus valides : "+
        data.summary.receipts+"/"+data.summary.total+" (LoSP : "+
        data.summary.losp+", invitées : "+data.summary.guests+").");
      line(output,"Historique R2 : LoSP "+(words[data.history.losp]||data.history.losp)+
        " · invitées "+(words[data.history.guests]||data.history.guests)+".");
      if(!data.alliances.length)line(output,"Aucune alliance approuvée pour cette collecte.");
      for(const a of data.alliances){
        const card=document.createElement("article");
        card.className="collection-alliance";
        const name=document.createElement("strong");
        name.textContent=a.name+" · "+(a.scope==="guest"?"Invitée":"LoSP");
        card.append(name);
        line(card,"Reçu : "+(words[a.receipt]||a.receipt)+
          " · "+a.ranks+"/"+a.players+" rang(s) valides.");
        if(a.receipt==="valid"){
          line(card,"Sans rang : "+a.withoutRank+
            " · rangs horodatés : "+a.observedRanks+"/"+a.ranks+".");
          line(card,"Dernière capture : "+time(a.capturedAt)+
            " · dernière mesure horodatée : "+time(a.latestObservedAt)+".");
        }
        line(card,"Historique : "+(words[a.history]||a.history)+
          " · "+a.archivedRanks+" rang(s) archivés.");
        output.append(card);
      }
      status.textContent="Contrôle R2 terminé à "+time(data.checkedAt)+
        " · aucune nouvelle collecte déclenchée.";
    }catch(error){
      status.textContent="Vérification impossible : "+
        (error instanceof Error?error.message:"indisponible");
    }finally{button.disabled=false;}
  }
  button.addEventListener("click",()=>void load());
})();