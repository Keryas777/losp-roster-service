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
    "not-due":"Collecte non commencée (prévue à 17h01)",invalid:"Reçu non conforme",
    expired:"Reçu expiré",present:"Archivé", "missing-day":"Date absente",
    "partial-or-unmatched":"Écart entre reçu et historique",
    unverifiable:"Non vérifiable", unavailable:"Indisponible"
  };
  const line=(parent,content)=>{
    const p=document.createElement("p");p.textContent=content;parent.append(p);return p;
  };
  const displayName=value=>String(value||"")
    .replace(/<#[a-f0-9]{6}>/gi,"")
    .replace(/<\/?color(?:=[^<>]{1,32})?>/gi,"")
    .replace(/\s+/g," ").trim();
  const time=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))?
    new Date(value).toLocaleString("fr-FR",{timeZone:"Europe/Paris"}):"—";
  // Always use the server's checkedAt and the Paris timezone: the admin
  // can be opened abroad and the local DST offset changes through the year.
  const beforeArchive=checkedAt=>{
    const at=Date.parse(checkedAt||"");
    if(!Number.isFinite(at))return false;
    const clock=new Intl.DateTimeFormat("en-GB",{
      timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
    }).format(new Date(at)).split(":").map(Number);
    return clock.length===2&&clock.every(Number.isFinite)&&
      clock[0]*60+clock[1]<20*60+17;
  };
  const missingHistory=state=>state==="missing"||state==="missing-day";
  const historyLabel=(state,checkedAt)=>
    missingHistory(state)&&beforeArchive(checkedAt)?
      "Archivage prévu à 20h17":words[state]||state;
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
      const notStarted=data.due===false&&data.summary.receipts===0;
      line(output,"Journée : "+data.day+" · "+
        (notStarted?"Collecte non commencée (prévue à 17h01)":
          "Reçus valides : "+data.summary.receipts+"/"+data.summary.total)+
        " (LoSP : "+data.summary.losp+", invitées : "+
        data.summary.guests+").");
      line(output,"Historique R2 : LoSP "+
        historyLabel(data.history.losp,data.checkedAt)+" · invitées "+
        historyLabel(data.history.guests,data.checkedAt)+".");
      if(!data.alliances.length)line(output,"Aucune alliance approuvée pour cette collecte.");
      for(const a of data.alliances){
        const card=document.createElement("article");
        card.className="collection-alliance";
        const name=document.createElement("strong");
        name.textContent=displayName(a.name)+" · "+(a.scope==="guest"?"Invitée":"LoSP");
        card.append(name);
        line(card,"Reçu : "+(words[a.receipt]||a.receipt)+
          (a.receipt==="not-due"?".":" · "+
            a.ranks+"/"+a.players+" rang(s) valides."));
        if(a.receipt==="valid"){
          line(card,"Sans rang : "+a.withoutRank+
            " · rangs horodatés : "+a.observedRanks+"/"+a.ranks+".");
          line(card,"Dernière capture : "+time(a.capturedAt)+
            " · dernière mesure horodatée : "+time(a.latestObservedAt)+".");
        }
        line(card,"Historique : "+
          historyLabel(a.history,data.checkedAt)+
          (missingHistory(a.history)&&beforeArchive(data.checkedAt)?
            ".":" · "+a.archivedRanks+" rang(s) archivés."));
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