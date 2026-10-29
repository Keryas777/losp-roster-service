// Background /game/v1 materials audit: UI only starts and reads checkpoints.
// The Worker Cron does the work; closing this tab does not cancel the audit.
(()=>{
  const start=document.getElementById("game-material-start"),
    refresh=document.getElementById("game-material-refresh"),
    copy=document.getElementById("game-material-copy"),
    download=document.getElementById("game-material-download"),
    status=document.getElementById("game-material-status"),
    summary=document.getElementById("game-material-summary");
  if(!start||!refresh||!copy||!download||!status||!summary)return;
  const endpoint="/admin/api/game-material-audit";
  let report=null,busy=false;
  const el=(tag,value)=>{
    const e=document.createElement(tag);
    if(value!==undefined)e.textContent=String(value);
    return e;
  };
  const number=value=>Number(value||0).toLocaleString("fr-FR");
  const exportJSON=()=>JSON.stringify(report,null,2);
  const ready=()=>report&&report.version===2&&report.status==="snapshot-complete";
  function render(data){
    report=data;
    summary.replaceChildren();
    const s=data.stats||{};
    for(const [label,value] of [
      ["État",data.status==="snapshot-complete"?"Terminé":
        data.status==="running"?"En cours":data.status==="expired"?"Expiré":
        data.status==="upgrade-required"?"Ancien rapport sans icônes":"Non démarré"],
      ["Fichiers R2 listés",number(s.listed)],
      ["Fichiers examinés",number(s.examined)],
      ["Fichiers contenant le terme",number(s.matched)],
      ["Matériaux distincts",number(data.distinctIds)],
      ["Matériaux avec icône officielle",number((data.materials||[])
        .filter(m=>m.icon).length)],
      ["Fichiers ignorés",number((s.tooLarge||0)+(s.expired||0)+
        (s.unavailable||0)+(s.invalid||0))]
    ]){
      const card=el("div");card.className="health-card";
      card.append(el("strong",label),el("p",value));
      summary.append(card);
    }
    if(Array.isArray(data.materials)&&data.materials.length){
      const sample=el("details"),heading=el("summary",
        "Aperçu des identifiants ("+number(data.materials.length)+")");
      sample.append(heading);
      for(const item of data.materials.slice(0,12)){
        const row=el("div");row.className="member-card";
        if(typeof item.icon==="string"&&
           /^https:\/\/assets\.marvelstrikeforce\.com\/(?:imgs|key_art)\//.test(item.icon)){
          const img=el("img");img.src=item.icon;img.alt=item.name||item.id;
          img.loading="lazy";img.style.width="48px";img.style.height="48px";
          img.style.objectFit="contain";row.append(img);
        }
        row.append(el("strong",item.name||item.id));
        if(item.name)row.append(el("p",item.id));
        row.append(el("p",number(item.fileCount)+" JSON · "+
          (item.category==="awakened-unique-material"?
            "Éveil "+(item.characterId||"")+" / "+(item.abilityType||""):
            "Matériau générique")+
          (item.icon?" · Icône officielle présente":" · Icône non trouvée")));
        sample.append(row);
      }
      if(data.materials.length>12)
        sample.append(el("p","Liste intégrale dans le rapport JSON exportable."));
      summary.append(sample);
    }
    copy.disabled=!ready();
    download.disabled=!ready();
    start.textContent=ready()?"Relancer un nouvel audit R2":
      data.status==="upgrade-required"?"Relancer avec noms et icônes":
      data.status==="running"?"Audit en cours (Cron automatique)":
      "Lancer l'audit des matériaux R2";
    start.disabled=busy||data.status==="running";
    status.textContent=(data.status==="running"?
      "Le Cron continue même après fermeture de la page. ":
      data.status==="upgrade-required"?
        "Ancienne version : il faut relancer une fois pour extraire les icônes des JSON déjà examinés. ":"")+
      (data.updatedAt?"Dernier passage : "+data.updatedAt+". ":"")+
      (data.finishedAt?"Terminé le : "+data.finishedAt+". ":"")+
      (data.expiresAt?"Expiration du rapport : "+data.expiresAt+". ":"")+
      (data.note||"")+
      " Aucun appel Scopely.";
  }
  async function read(){
    if(busy)return;
    busy=true;start.disabled=true;refresh.disabled=true;
    status.textContent="Lecture du checkpoint privé R2…";
    try{
      const res=await fetch(endpoint,{credentials:"same-origin",cache:"no-store"});
      const data=await res.json();
      if(!res.ok)throw Error(data.error||"HTTP "+res.status);
      render(data);
    }catch(error){
      status.textContent="Rapport indisponible : "+
        (error instanceof Error?error.message:"erreur");
    }finally{
      busy=false;refresh.disabled=false;
      start.disabled=report?.status==="running";
    }
  }
  start.addEventListener("click",async()=>{
    if(busy)return;
    let action="start";
    if(ready()||report?.status==="upgrade-required"){
      if(!confirm("Relancer l'audit enrichi depuis le début ? "+
        "Le rapport précédent sera remplacé."))return;
      action="restart";
    }
    busy=true;start.disabled=true;refresh.disabled=true;
    status.textContent="Enregistrement du démarrage dans R2…";
    try{
      const res=await fetch(endpoint,{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action})
      });
      const data=await res.json();
      if(!res.ok)throw Error(data.error||"HTTP "+res.status);
      render(data);
    }catch(error){
      status.textContent="Démarrage impossible : "+
        (error instanceof Error?error.message:"erreur");
    }finally{
      busy=false;refresh.disabled=false;
      start.disabled=report?.status==="running";
    }
  });
  refresh.addEventListener("click",()=>void read());
  copy.addEventListener("click",async()=>{
    if(!ready())return;
    const payload=exportJSON();
    try{
      await navigator.clipboard.writeText(payload);
      status.textContent="Rapport JSON intégral copié. Colle-le dans ChatGPT.";
    }catch{
      const pre=el("pre",payload);
      pre.setAttribute("aria-label","Rapport JSON à copier manuellement");
      summary.prepend(pre);
      status.textContent="Copie bloquée par le navigateur : sélectionne le rapport affiché.";
    }
  });
  download.addEventListener("click",()=>{
    if(!ready())return;
    const blob=new Blob([exportJSON()],{type:"application/json"});
    const url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download="losp-materials-icons-r2-"+report.runId+".json";
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  status.textContent="Audit R2 non chargé. Clique sur « Actualiser le rapport ».";
})();
