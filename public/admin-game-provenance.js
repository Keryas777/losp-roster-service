// Private, R2-only provenance comparison. The Cron continues when the tab closes.
(()=>{
  const start=document.getElementById("game-provenance-start");
  const refresh=document.getElementById("game-provenance-refresh");
  const copy=document.getElementById("game-provenance-copy");
  const status=document.getElementById("game-provenance-status");
  const result=document.getElementById("game-provenance-summary");
  if(!start||!refresh||!copy||!status||!result)return;
  const endpoint="/admin/api/game-provenance-reconcile";
  let snapshot=null,busy=false;
  const el=(tag,value)=>{const e=document.createElement(tag);e.textContent=String(value);return e;};
  function show(r){
    snapshot=r;
    result.replaceChildren();
    const src=r.sources||{},obj=r.objects||{};
    for(const [k,v] of [
      ["Statut",r.status||"—"],["Phase",r.phase||"—"],
      ["Sources différentielles examinées",src.listed??"—"],
      ["Réponses officielles exactes vérifiées",src.verified??"—"],
      ["Sources rejetées / trop anciennes",(src.rejected??0)+" / "+(src.tooOld??0)],
      ["Objets de l'archive parcourus",obj.listed??"—"],
      ["Orphelins rencontrés",obj.orphaned??"—"],
      ["Correspondances exactes à un endpoint",obj.matched??"—"],
      ["Correspondances ambiguës",obj.ambiguous??"—"],
      ["Sans preuve suffisante",obj.unresolved??"—"],
      ["Trop volumineux / date inconnue ou expirée",
        (obj.tooLarge??0)+" / "+(obj.expiredOrUnknown??0)]
    ]){
      const c=document.createElement("div");c.className="health-card";
      c.append(el("strong",k),el("p",v));result.append(c);
    }
    status.textContent=(r.status==="snapshot-complete"?
      "Photographie terminée. Les liens établis sont des associations de contenu vérifiées, pas des reçus historiques restaurés. ":
      r.status==="running"?
      "Le Cron poursuit l'analyse en R2, même si tu fermes la page. ":
      "Aucune analyse lancée. ")+
      "Aucun appel Scopely. "+(r.updatedAt?"Dernière mise à jour : "+r.updatedAt:"");
    start.disabled=r.status!=="not-started";
    copy.disabled=r.status==="not-started";
  }
  async function load(method){
    if(busy)return;busy=true;start.disabled=true;refresh.disabled=true;
    status.textContent="Consultation du checkpoint R2…";
    try{
      const response=await fetch(endpoint,{method,credentials:"same-origin",
        cache:"no-store",...(method==="POST"?{
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({action:"start"})
        }:{})});
      if(!response.ok){
        let detail;
        try{detail=(await response.json()).error;}catch{}
        throw Error(detail||"HTTP "+response.status);
      }
      show(await response.json());
    }catch(error){
      status.textContent="Erreur : "+(error instanceof Error?error.message:"indisponible");
    }finally{
      busy=false;refresh.disabled=false;
      if(!snapshot||snapshot.status==="not-started")start.disabled=false;
    }
  }
  start.addEventListener("click",()=>void load("POST"));
  refresh.addEventListener("click",()=>void load("GET"));
  copy.addEventListener("click",async()=>{
    if(!snapshot)return;
    const content=JSON.stringify({kind:"LoSP-game-provenance-reconciliation",
      scope:"R2-only",...snapshot},null,2);
    try{await navigator.clipboard.writeText(content);status.textContent="Bilan copié.";}
    catch{result.prepend(el("pre",content));status.textContent="Sélectionne le JSON affiché.";}
  });
  status.textContent="Lancer une comparaison prudente avec les vérifications officielles différentielles existantes (R2 uniquement).";
})();
