// Read-only administrator view: only private R2 aggregates and HEAD checks.
(()=>{
  const button=document.getElementById("roster-r2-refresh");
  const copy=document.getElementById("roster-r2-copy");
  const status=document.getElementById("roster-r2-status");
  const container=document.getElementById("roster-r2-report");
  if(!button||!copy||!status||!container)return;
  const endpoint="/admin/api/roster-r2-coverage";
  let latest=null,busy=false;
  const label={
    "not-started":"Non commencée","in-progress":"En cours",
    "complete-co-members":"Coéquipiers terminés, roster personnel en attente",
    "complete":"Complète","partial-consent":"Partages incomplets",
    "expired":"Expiré","invalid":"Données invalides",
    "missing":"Absent","valid":"Valide"
  };
  const line=(card,value)=>{
    const p=document.createElement("p");
    p.textContent=value;card.append(p);
  };
  const title=(card,value)=>{
    // Official MSF tags are inline colors, not part of the displayed name.
    const raw=String(value??"");
    const markers=raw.match(/<#[0-9a-f]{6}>/gi);
    const color=markers?.length?"#"+markers[markers.length-1].slice(2,-1):null;
    const clean=raw.replace(/<#[0-9a-f]{6}>/gi,"")
      .replace(/\s+/g," ").trim().replace(/^(LoSP\s+){2,}/i,"LoSP ");
    const match=/^(LoSP\s+)(.+)$/i.exec(clean);
    const strong=document.createElement("strong");
    if(match)strong.append(document.createTextNode(match[1]));
    const alliance=document.createElement("span");
    alliance.textContent=match?.[2]||clean;
    if(color)alliance.style.color=color;
    strong.append(alliance);card.append(strong);
  };
  function render(report){
    container.replaceChildren();
    if(!report.alliances.length){
      line(container,"Aucune alliance approuvée dans le registre privé R2.");
      return;
    }
    const cards=document.createElement("div");
    cards.className="health-cards";
    for(const alliance of report.alliances){
      const card=document.createElement("article");
      card.className="health-card";
      const p=alliance.progress,m=alliance.manifest;
      title(card,alliance.name);
      line(card,"Collecte : "+(label[p.status]||p.status)+
        (p.campaign?" ("+p.campaign+")":""));
      if(p.completed!==undefined){
        line(card,"Coéquipiers : "+p.completed+"/"+p.eligibleCoMembers+
          " ; restants : "+p.remaining+".");
        line(card,"Sans partage : "+(p.noShareCount??"inconnu")+
          " ; roster personnel : "+(p.personalRosterCollected?
            p.personalFilePresent?"présent":"fichier manquant":
            "non confirmé")+".");
      }
      line(card,"Manifeste complet : "+(label[m.status]||m.status)+
        (m.members!==undefined?" ("+m.members+" membres)":"")+".");
      if(p.status==="partial-consent"&&m.status==="missing"&&
         Number.isSafeInteger(p.noShareCount)&&p.noShareCount>0)
        line(card,"Le manifeste complet n’est pas créé car "+
          p.noShareCount+" membre(s) ne partagent pas leur roster ; "+
          "les rosters autorisés peuvent néanmoins être terminés.");
      if(m.files){
        line(card,"Fichiers du manifeste : "+m.files.checked+
          " contrôlés, "+m.files.missing+" manquant(s).");
      }else if(m.status==="valid"){
        line(card,"Fichiers du manifeste non vérifiés intégralement.");
      }
      if(m.matchesCurrentProgress===false)
        line(card,"Manifeste d'une autre campagne encore conservée.");
      if(p.files&&(!m.files||m.matchesCurrentProgress===false))
        line(card,"Fichiers de la campagne en cours : "+p.files.checked+
          " contrôlés, "+p.files.missing+" manquant(s).");
      cards.append(card);
    }
    container.append(cards);
  }
  async function fetchJSON(url){
    const result=await fetch(url,{credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}});
    const payload=await result.json();
    if(!result.ok||payload.status!=="ok")
      throw Error(payload.error||"HTTP "+result.status);
    return payload;
  }
  async function readAll(){
    if(busy)return;
    busy=true;button.disabled=true;copy.disabled=true;latest=null;
    status.textContent="Lecture du registre et des états R2 (zéro appel Scopely)…";
    try{
      const report=await fetchJSON(endpoint);
      const detailed=[];
      for(const [i,item] of report.alliances.entries()){
        status.textContent="Vérification des fichiers R2 : "+(i+1)+
          "/"+report.alliances.length+" alliance(s)…";
        const one=await fetchJSON(endpoint+"?fingerprint="+encodeURIComponent(item.fingerprint));
        detailed.push(one.alliances[0]);
      }
      latest={...report,scope:"full",alliances:detailed};
      render(latest);
      copy.disabled=false;
      status.textContent="Contrôle R2 terminé : "+detailed.length+
        " alliance(s) approuvée(s). Aucun appel Scopely, aucun fichier modifié.";
    }catch(error){
      status.textContent="Diagnostic interrompu : "+(error instanceof Error?
        error.message:"indisponible")+". Aucune collecte déclenchée.";
    }finally{busy=false;button.disabled=false;}
  }
  button.addEventListener("click",()=>void readAll());
  copy.addEventListener("click",async()=>{
    if(!latest)return;
    const data=JSON.stringify(latest,null,2);
    try{
      await navigator.clipboard.writeText(data);
      status.textContent="Diagnostic R2 copié. Tu peux le transmettre pour analyse.";
    }catch{
      const pre=document.createElement("pre");
      pre.textContent=data;
      pre.setAttribute("aria-label","Rapport R2 à copier manuellement");
      container.prepend(pre);
      status.textContent="Copie indisponible : sélectionne le JSON affiché.";
    }
  });
})();
