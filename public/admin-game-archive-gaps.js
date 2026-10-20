// Admin-only display of R2 game archive gaps. No direct Scopely request.
// Safe on iOS Safari: all external values inserted with textContent.
(()=>{
  const refresh=document.getElementById("game-gap-refresh"),
    status=document.getElementById("game-gap-status"),
    summary=document.getElementById("game-gap-summary"),
    results=document.getElementById("game-gap-results"),
    family=document.getElementById("game-gap-family"),
    cause=document.getElementById("game-gap-cause"),
    prev=document.getElementById("game-gap-prev"),
    next=document.getElementById("game-gap-next");
  if(!refresh||!status||!summary||!results||!family||!cause||!prev||!next)return;
  const labels={
    "indexation-requise":"Archivée, indexation à terminer",
    "alternative-partielle":"Racine refusée, détails alternatifs à vérifier",
    "reprise-a-etudier":"Tentatives épuisées, à recontrôler",
    "identifiant-manquant":"Identifiants non découverts",
    "schema-a-etudier":"Structure inconnue",
    "pagination-a-etudier":"Pagination incohérente",
    "volume-ou-pagination":"Réponse volumineuse ou non paginable",
    "acces-a-verifier":"Autorisation à vérifier",
    "introuvable-a-verifier":"Ressource introuvable (à vérifier)",
    "association-objet-personnage-indisponible":"Association objet/personnages refusée (objet non remis en cause)",
    "all-split-parts-archived":"Toutes les variantes demandées archivées (fiche complète non certifiée)",
    "some-split-parts-archived":"Variantes partiellement archivées",
    "split-parts-failed":"Au moins une variante refusée",
    "split-parts-queued":"Variantes programmées, collecte en cours",
    "temporisation-fournisseur":"Limitation temporaire",
    "a-investiguer":"Cause à investiguer"
  };
  const element=(tag,value,className)=>{
    const node=document.createElement(tag);
    if(value!==undefined)node.textContent=String(value);
    if(className)node.className=className;
    return node;
  };
  let offset=0,busy=false,loaded=false;
  function fillSelect(select,items,word){
    const selected=select.value;
    select.replaceChildren(element("option",word));
    select.firstChild.value="";
    for(const item of items){
      const option=element("option",item.value+" ("+item.count+")");
      option.value=item.value;
      select.append(option);
    }
    select.value=[...select.options].some(o=>o.value===selected)?selected:"";
  }
  function group(parent,title,items,translate){
    const block=element("div",undefined,"health-card");
    block.append(element("strong",title));
    if(!items.length)block.append(element("p","Aucun"));
    for(const item of items.slice(0,20))
      block.append(element("p",(translate?labels[item.value]||item.value:item.value)+
        " : "+item.count));
    if(items.length>20)
      block.append(element("p","… "+(items.length-20)+" catégories supplémentaires"));
    parent.append(block);
  }
  function draw(report){
    const total=report.total||0;
    summary.replaceChildren();
    const headline=element("div",undefined,"health-cards");
    group(headline,"Signalements cumulés",[{value:"Entrées",count:total},
      {value:"Chemins distincts",count:report.distinctPaths||0}],false);
    group(headline,"Par catégorie",report.byCategory||[],true);
    group(headline,"Par code HTTP",report.byHttpStatus||[],false);
    group(headline,"Par famille",report.byFamily||[],false);
    group(headline,"Par motif technique",report.byCause||[],false);
    if(report.byRecovery?.length)
      group(headline,"Récupération ciblée des personnages",
        report.byRecovery,true);
    summary.append(headline);
    summary.append(element("p",
      "Les lacunes enregistrées ne signifient pas toutes une perte définitive. "+
      "Les cas déjà résolus ne sont pas automatiquement effacés.","muted"));
    fillSelect(family,report.byFamily||[],"Toutes les familles");
    fillSelect(cause,report.byCause||[],"Toutes les causes");
    results.replaceChildren();
    for(const row of report.entries||[]){
      const card=element("div",undefined,"member-card");
      card.append(element("strong",row.path||"Chemin non identifié"));
      card.append(element("p","Famille : "+row.family));
      card.append(element("p","Cause : "+(labels[row.category]||row.category)+
        " ("+row.reason+")"));
      if(row.status!==null)card.append(element("p","HTTP : "+row.status));
      if(row.recoveryStatus)card.append(element("p","Récupération : "+
        (labels[row.recoveryStatus]||row.recoveryStatus)+
        " ("+row.archivedParts+"/"+row.expectedParts+" variantes archivées)"));
      if(row.attempts)card.append(element("p","Tentatives : "+row.attempts));
      if(row.affectedCount)card.append(element("p","IDs non découverts : "+row.affectedCount));
      results.append(card);
    }
    if(!report.entries?.length)results.append(element("p","Aucune lacune pour ce filtre."));
    prev.disabled=offset<=0;
    next.disabled=report.nextOffset===null;
    status.textContent="Campagne : "+report.status+". "+
      total+" signalements, "+report.matching+" dans le filtre. "+
      (report.matching?("Affichage "+(offset+1)+" à "+
        (offset+(report.entries?.length||0))+"."):"")+
      " Consultation R2 uniquement, aucune requête MSF.";
  }
  async function load(){
    if(busy)return;
    busy=true;refresh.disabled=true;prev.disabled=true;next.disabled=true;
    status.textContent="Lecture des lacunes enregistrées dans R2…";
    const query=new URLSearchParams({offset:String(offset),limit:"20"});
    if(family.value)query.set("family",family.value);
    if(cause.value)query.set("cause",cause.value);
    try{
      const response=await fetch("/admin/api/game-archive-gaps?"+query,{
        cache:"no-store",credentials:"same-origin"
      });
      if(!response.ok)throw Error("HTTP "+response.status);
      const data=await response.json();
      if(!Number.isSafeInteger(data.total))throw Error("réponse invalide");
      loaded=true;draw(data);
    }catch(error){
      status.textContent="Audit indisponible : "+
        (error instanceof Error?error.message:"erreur");
      if(!loaded)summary.replaceChildren();
    }finally{busy=false;refresh.disabled=false;}
  }
  refresh.addEventListener("click",()=>{offset=0;void load();});
  family.addEventListener("change",()=>{offset=0;void load();});
  cause.addEventListener("change",()=>{offset=0;void load();});
  prev.addEventListener("click",()=>{
    offset=Math.max(0,offset-20);void load();
  });
  next.addEventListener("click",()=>{
    offset+=20;void load();
  });
})();
