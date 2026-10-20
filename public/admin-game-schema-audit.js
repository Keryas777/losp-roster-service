// Mobile-first, private report for the resumable R2 schema audit.
(()=>{
  const start=document.getElementById("game-schema-start"),
    refresh=document.getElementById("game-schema-refresh"),
    copy=document.getElementById("game-schema-copy"),
    status=document.getElementById("game-schema-status"),
    summary=document.getElementById("game-schema-summary"),
    select=document.getElementById("game-schema-family"),
    detail=document.getElementById("game-schema-detail");
  if(!start||!refresh||!copy||!status||!summary||!select||!detail)return;
  const endpoint="/admin/api/game-archive-schema-audit";
  const elt=(tag,text)=>{
    const node=document.createElement(tag);
    if(text!==undefined)node.textContent=String(text);
    return node;
  };
  let report=null,busy=false;
  function line(box,text){box.append(elt("p",text));}
  function renderFamily(){
    detail.replaceChildren();
    const f=report?.families?.find(x=>x.family===select.value);
    if(!f)return;
    const intro=elt("div");intro.className="health-card";
    intro.append(elt("strong",f.family));
    line(intro,f.receipts+" reçus · "+f.inspected+" JSON inspectés · "+
      f.tooLarge+" trop volumineux · "+f.unindexed+" non indexés · "+
      f.unreadable+" inaccessibles ou invalides");
    intro.append(elt("p","Les fréquences des champs portent seulement sur les "+
      f.inspected+" JSON inspectés, pas sur toute la famille."));
    detail.append(intro);
    const variants=elt("details");
    variants.open=true;
    variants.append(elt("summary","Structures distinctes observées : "+
      f.variants.length+(f.otherVariants?" (autres non conservées : "+
        f.otherVariants+")":"")));
    for(const v of f.variants){
      const card=elt("div");card.className="member-card";
      card.append(elt("strong",v.kind+" · "+v.count+" document(s)"));
      line(card,"Champs principaux : "+(v.fields?.join(", ")||"aucun"));
      line(card,"Exemple : "+v.examplePath);
      variants.append(card);
    }
    detail.append(variants);
    const fields=elt("details");fields.open=false;
    fields.append(elt("summary","Chemins imbriqués observés (jusqu'à 7 niveaux) : "+
      Object.keys(f.fields||{}).length));
    for(const [path,stats] of Object.entries(f.fields||{})
      .sort(([a],[b])=>a.localeCompare(b))){
      line(fields,path+" — "+stats.types.join(" / ")+" · "+
        stats.count+"/"+f.inspected+" JSON");
    }
    detail.append(fields);
  }
  function render(data){
    report=data;
    summary.replaceChildren();
    const sampleCount=(data.families||[]).reduce((n,f)=>n+f.inspected,0);
    for(const [label,value] of [
      ["État",data.status],
      ["Reçus R2 parcourus",data.receiptsListed],
      ["Familles rencontrées",(data.families||[]).length],
      ["JSON inspectés",sampleCount]
    ]){
      const box=elt("div");box.className="health-card";
      box.append(elt("strong",label));line(box,value);summary.append(box);
    }
    const previous=select.value;
    select.replaceChildren(elt("option","Choisir une famille"));
    select.firstChild.value="";
    for(const family of data.families||[]){
      const option=elt("option",family.family+" ("+family.receipts+" reçus)");
      option.value=family.family;select.append(option);
    }
    select.value=[...select.options].some(x=>x.value===previous)?previous:"";
    renderFamily();
    copy.disabled=!(data.families?.length);
    status.textContent=(data.note||"")+
      (data.updatedAt?" Dernier passage : "+data.updatedAt+".":"")+
      " Aucun appel Scopely.";
  }
  async function load(){
    if(busy)return;
    busy=true;start.disabled=true;refresh.disabled=true;
    status.textContent="Lecture du rapport R2…";
    try{
      const response=await fetch(endpoint,{credentials:"same-origin",cache:"no-store"});
      if(!response.ok)throw Error("HTTP "+response.status);
      render(await response.json());
    }catch(error){
      status.textContent="Rapport indisponible : "+
        (error instanceof Error?error.message:"erreur");
    }finally{
      busy=false;start.disabled=false;refresh.disabled=false;
    }
  }
  start.addEventListener("click",async()=>{
    if(busy)return;
    if(report?.status==="snapshot-complete"&&!confirm(
      "Relancer l'audit depuis le début ? Le précédent rapport sera remplacé."))return;
    busy=true;start.disabled=true;refresh.disabled=true;
    status.textContent="Initialisation de l'audit R2…";
    try{
      const response=await fetch(endpoint,{
        method:"POST",cache:"no-store",credentials:"same-origin",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"start"})
      });
      if(!response.ok)throw Error("HTTP "+response.status);
      render(await response.json());
    }catch(error){
      status.textContent="Lancement impossible : "+
        (error instanceof Error?error.message:"erreur");
    }finally{
      busy=false;start.disabled=false;refresh.disabled=false;
    }
  });
  refresh.addEventListener("click",()=>void load());
  select.addEventListener("change",renderFamily);
  copy.addEventListener("click",async()=>{
    if(!report)return;
    const payload=JSON.stringify({
      kind:"LoSP-MSF-R2-deep-schema-audit",
      scope:"bounded-shape-samples",...report},null,2);
    try{
      await navigator.clipboard.writeText(payload);
      status.textContent="Rapport JSON copié. Tu peux le coller dans ChatGPT.";
    }catch{
      const block=elt("pre",payload);
      block.setAttribute("aria-label","Rapport JSON à copier manuellement");
      detail.prepend(block);
      status.textContent="Copie automatique indisponible : sélectionne le JSON affiché.";
    }
  });
  void load();
})();
