// Private game R2 inspector. DOM text only: no raw HTML or private object keys.
(()=>{
  const start=document.getElementById("game-inspect-start"),
    next=document.getElementById("game-inspect-next"),
    copy=document.getElementById("game-inspect-copy"),
    status=document.getElementById("game-inspect-status"),
    summary=document.getElementById("game-inspect-summary"),
    results=document.getElementById("game-inspect-results");
  if(!start||!next||!copy||!status||!summary||!results)return;
  let cursor=null,busy=false,seen=0;
  const totals=new Map(),shapes=new Map();
  const node=(tag,text)=>{
    const e=document.createElement(tag);
    if(text!==undefined)e.textContent=String(text);
    return e;
  };
  const describe=arr=>arr?.length?arr.join(", "):"Aucun dans cet échantillon";
  function show(data){
    seen+=data.validReceipts||0;
    for(const r of data.receipts||[])
      totals.set(r.family,(totals.get(r.family)||0)+1);
    for(const s of data.samples||[]){
      const k=s.family;
      if(!shapes.has(k))shapes.set(k,[]);
      const examples=shapes.get(k);
      if(examples.length<2&&s.shape&&!examples.some(x=>x.path===s.path))
        examples.push({path:s.path,shape:s.shape});
    }
    copy.disabled=false;
    summary.replaceChildren();
    const card=node("div");card.className="health-card";
    card.append(node("strong","Reçus examinés dans ce lot : "+data.validReceipts+
      " / "+data.listed));
    card.append(node("p","Reçus analysés au total dans cette session : "+seen));
    card.append(node("p","Familles du lot : "+(data.byFamily||[])
      .map(x=>x.family+" ("+x.count+")").join(", ")));
    card.append(node("p","Échantillonnage uniquement : n'interprète pas ces nombres comme les totaux de R2."));
    summary.append(card);
    results.replaceChildren();
    for(const item of data.samples||[]){
      const block=node("div");block.className="member-card";
      block.append(node("strong",item.family+" · "+item.state));
      block.append(node("p",item.path));
      if(item.shape){
        const shape=item.shape;
        block.append(node("p","Forme : "+shape.dataType+
          (shape.entryCount!==null?" · "+shape.entryCount+" entrées dans cette réponse":"")));
        block.append(node("p","Clés racine : "+describe(shape.rootKeys)));
        block.append(node("p","Champs data : "+describe(shape.dataKeys)));
        if(shape.entryKeys?.length)
          block.append(node("p","Champs d'une entrée : "+describe(shape.entryKeys)));
        if(shape.metaKeys?.length)
          block.append(node("p","Métadonnées : "+describe(shape.metaKeys)));
        if(shape.exampleIds?.length)
          block.append(node("p","Exemples d'identifiants : "+describe(shape.exampleIds)));
      }else block.append(node("p","JSON non inspecté : trop volumineux ou indisponible."));
      results.append(block);
    }
    const details=node("details");
    details.append(node("summary","Afficher les chemins archivés de ce lot"));
    for(const receipt of data.receipts||[]){
      details.append(node("p",receipt.family+" · "+receipt.storage+" · "+
        receipt.path));
    }
    results.append(details);
    cursor=data.nextCursor;
    next.disabled=!cursor;
    status.textContent="Lecture R2 terminée. "+
      (data.samples?.length||0)+" structures examinées. "+
      (cursor?"Un autre lot est disponible.":"Fin des reçus parcourus.")+
      " Aucun appel Scopely.";
  }
  async function load(restart=false){
    if(busy)return;
    busy=true;start.disabled=true;next.disabled=true;
    if(restart){cursor=null;seen=0;totals.clear();shapes.clear();copy.disabled=true;}
    status.textContent="Inspection privée des reçus R2…";
    try{
      const q=new URLSearchParams();
      if(cursor)q.set("cursor",cursor);
      const res=await fetch("/admin/api/game-archive-inspect?"+q,{
        credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error("HTTP "+res.status);
      const data=await res.json();
      if(data.status!=="sample-only"||!Array.isArray(data.receipts))
        throw Error("Réponse inattendue");
      show(data);
    }catch(e){
      status.textContent="Inspection indisponible : "+
        (e instanceof Error?e.message:"erreur");
      next.disabled=!cursor;
    }finally{
      busy=false;start.disabled=false;
    }
  }
  copy.addEventListener("click",async()=>{
    const report={kind:"LoSP-MSF-R2-shape-sample",scope:"sample-only",
      receiptsInspected:seen,byFamily:[...totals].map(([family,count])=>({family,count})),
      examples:[...shapes].flatMap(([family,list])=>
        list.map(entry=>({family,...entry})))};
    const payload=JSON.stringify(report,null,2);
    try{
      await navigator.clipboard.writeText(payload);
      status.textContent="Résumé JSON copié. Tu peux le coller dans ChatGPT.";
    }catch{
      const block=node("pre",payload);
      block.setAttribute("aria-label","Résumé JSON à copier manuellement");
      results.prepend(block);
      status.textContent="Copie automatique indisponible : sélectionne le résumé affiché.";
    }
  });
  start.addEventListener("click",()=>void load(true));
  next.addEventListener("click",()=>void load(false));
})();
