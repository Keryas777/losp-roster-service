// Private /admin report. All R2 work continues in Cron even after closing this page.
(()=>{
  const start=document.getElementById("game-orphan-start"),
    refresh=document.getElementById("game-orphan-refresh"),
    copy=document.getElementById("game-orphan-copy"),
    status=document.getElementById("game-orphan-status"),
    summary=document.getElementById("game-orphan-summary");
  if(!start||!refresh||!copy||!status||!summary)return;
  const endpoint="/admin/api/game-archive-orphan-audit";
  let snapshot=null,busy=false;
  function text(tag,value){
    const e=document.createElement(tag);e.textContent=String(value);return e;
  }
  const cell=(name,value)=>{
    const c=document.createElement("div");c.className="health-card";
    c.append(text("strong",name),text("p",value));return c;
  };
  function render(report){
    snapshot=report;
    summary.replaceChildren();
    const o=report.objects||{},r=report.receipts||{},e=report.evidence||{};
    for(const [label,value] of [
      ["Statut",report.status||"—"],["Phase",report.phase||"—"],
      ["Reçus analysés",r.listed??"—"],
      ["Reçus valides",r.valid??"—"],
      ["Objets R2 parcourus",o.listed??"—"],
      ["Orphelins détectés",o.orphaned??"—"],
      ["Orphelins vérifiés par SHA-256",o.hashVerified??"—"],
      ["Orphelins structurellement analysés",o.inspected??"—"],
      ["Trop volumineux pour l’analyse",o.tooLarge??"—"],
      ["Inaccessibles / JSON invalides / hash incohérents",
        (o.unreadable??0)+" / "+(o.invalidJSON??0)+" / "+(o.hashMismatch??0)],
      ["Blocs de file historique",e.queueChunks??"—"],
      ["Chemins consignés en phase 2",e.seenPaths??"—"]
    ])summary.append(cell(label,value));
    if(report.variants?.length){
      const details=document.createElement("details");
      const heading=text("summary","Structures hypothétiques ("+
        report.variants.length+" signatures mémorisées)");
      details.append(heading);
      for(const row of report.variants){
        const card=document.createElement("div");card.className="member-card";
        card.append(text("strong",row.likelyFamily+" — "+row.count+" JSON"),
          text("p","Champs : "+row.fields.join(", ")));
        details.append(card);
      }
      summary.append(details);
    }
    copy.disabled=report.status==="not-started";
    if(report.status==="not-started"){
      copy.disabled=true;start.disabled=false;
    }else{
      start.disabled=true;
    }
    status.textContent=(report.status==="snapshot-complete"?
      "Audit terminé. Aucune provenance n'a été attribuée sans reçu.":
      report.status==="not-started"?"Audit non lancé.":
      "Le Cron continue par lots, même si tu fermes cette page. ")+
      " Aucun appel Scopely. "+(report.updatedAt?"Dernier passage : "+report.updatedAt:"");
  }
  async function call(method){
    const response=await fetch(endpoint,{
      method,credentials:"same-origin",cache:"no-store",
      ...(method==="POST"?{
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"start"})
      }:{})
    });
    if(!response.ok)throw Error("HTTP "+response.status);
    return response.json();
  }
  async function load(method){
    if(busy)return;
    busy=true;refresh.disabled=true;start.disabled=true;
    status.textContent=method==="POST"?"Initialisation de l’audit R2…":
      "Lecture du checkpoint privé R2…";
    try{render(await call(method));}
    catch(error){status.textContent="Erreur : "+(error instanceof Error?error.message:
      "indisponible");}
    finally{busy=false;refresh.disabled=false;if(!snapshot||
      snapshot.status==="not-started")start.disabled=false;}
  }
  start.addEventListener("click",()=>void load("POST"));
  refresh.addEventListener("click",()=>void load("GET"));
  copy.addEventListener("click",async()=>{
    if(!snapshot)return;
    const data=JSON.stringify({
      kind:"LoSP-MSF-orphan-recoverability-audit",scope:"R2-only",...snapshot
    },null,2);
    try{
      await navigator.clipboard.writeText(data);
      status.textContent="Rapport agrégé copié.";
    }catch{
      const pre=text("pre",data);
      pre.setAttribute("aria-label","Rapport JSON à copier");
      summary.prepend(pre);
      status.textContent="Copie indisponible : sélectionne le rapport affiché.";
    }
  });
  status.textContent="Rapport R2 non chargé. Clique sur « Actualiser le rapport » pour suivre l’audit en cours.";
})();
