// User-initiated, paginated R2-only inventory. No persistence in the browser.
(()=>{
  const start=document.getElementById("game-r2-inventory-start"),
    copy=document.getElementById("game-r2-inventory-copy"),
    status=document.getElementById("game-r2-inventory-status"),
    output=document.getElementById("game-r2-inventory-summary");
  if(!start||!copy||!status||!output)return;
  const endpoint="/admin/api/game-archive-inventory";
  const PREFIX_LIMIT=100000,MAX_PAGES=1000;
  let busy=false,report=null;
  const text=(tag,v)=>{const e=document.createElement(tag);e.textContent=String(v);return e;};
  function show(data){
    output.replaceChildren();
    const fields=[
      ["Campagne",data.runId],
      ["État",data.status],
      ["Reçus physiques",data.receipts.listed],
      ["Reçus exploitables",data.receipts.valid],
      ["Reçus invalides / illisibles",data.receipts.invalid+" / "+data.receipts.unreadable],
      ["JSON indexés (fichiers physiques)",data.objects.listed],
      ["Grosses réponses raw (fichiers physiques)",data.raw.listed],
      ["Objets indexés avec reçu",data.objects.withReceipt],
      ["Objets indexés sans reçu",data.objects.orphaned],
      ["Raw avec reçu",data.raw.withReceipt],
      ["Raw sans reçu",data.raw.orphaned],
      ["Références vers des fichiers absents",data.missingReferences],
      ["Références distinctes / doublons",data.uniqueReferences+" / "+data.duplicateReferences]
    ];
    const grid=document.createElement("div");
    grid.className="health-cards";
    for(const [name,value] of fields){
      const card=document.createElement("div");card.className="health-card";
      card.append(text("strong",name),text("p",value));
      grid.append(card);
    }
    output.append(grid);
    output.append(text("p","Cet inventaire décrit la présence R2, pas le contenu des JSON, "+
      "leur date d'expiration ni l'exhaustivité de l'API. Les objets sans reçu "+
      "n'ont pas automatiquement une provenance récupérable."));
  }
  async function page(params){
    const response=await fetch(endpoint+"?"+new URLSearchParams(params),{
      credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
    if(!response.ok)throw Error("HTTP "+response.status);
    const data=await response.json();
    if(!["page","ready"].includes(data.status))throw Error("Invalid inventory response");
    return data;
  }
  async function listAll(kind,runId,onPage){
    let cursor=null,pages=0,total=0;
    const seenCursors=new Set();
    do{
      if(pages>=MAX_PAGES||total>=PREFIX_LIMIT)
        throw Error("Limite de sécurité de l'inventaire atteinte ; rapport incomplet.");
      const query={kind,runId};if(cursor)query.cursor=cursor;
      const value=await page(query);
      if(value.kind!==kind||value.runId!==runId||
         !Number.isInteger(value.listed)||value.listed<0||value.listed>200)
        throw Error("Page R2 incohérente");
      pages++;total+=value.listed;
      onPage(value);
      status.textContent="Inventaire "+kind+" : "+total+" fichier(s), "+pages+
        " page(s). Aucun GET Scopely.";
      cursor=value.nextCursor;
      if(cursor!==null){
        if(typeof cursor!=="string"||seenCursors.has(cursor))
          throw Error("Pagination R2 bloquée");
        seenCursors.add(cursor);
      }
    }while(cursor);
  }
  start.addEventListener("click",async()=>{
    if(busy)return;
    busy=true;report=null;copy.disabled=true;start.disabled=true;
    output.replaceChildren();
    const refs=new Set(),foundObjects=new Set(),foundRaw=new Set();
    const counts={receipts:{listed:0,valid:0,invalid:0,unreadable:0},
      objects:{listed:0,invalidNames:0,withReceipt:0,orphaned:0,
        bytesKnown:0,sizesUnknown:0},
      raw:{listed:0,invalidNames:0,withReceipt:0,orphaned:0,
        bytesKnown:0,sizesUnknown:0}};
    let validReferenceCount=0;
    try{
      status.textContent="Ouverture de l'inventaire R2 privé…";
      const init=await page({kind:"overview"});
      const runId=init.runId;
      if(typeof runId!=="string")throw Error("Campagne inconnue");
      await listAll("receipts",runId,p=>{
        counts.receipts.listed+=p.listed;
        counts.receipts.valid+=p.validReceipts;
        counts.receipts.invalid+=p.invalidReceipts;
        counts.receipts.unreadable+=p.unreadableReceipts;
        for(const ref of p.references){
          if(!["objects","raw"].includes(ref.type)||typeof ref.id!=="string")
            throw Error("Référence R2 invalide");
          refs.add(ref.type+"/"+ref.id);validReferenceCount++;
        }
      });
      for(const kind of ["objects","raw"]){
        await listAll(kind,runId,p=>{
          counts[kind].listed+=p.listed;
          counts[kind].invalidNames+=p.invalidNames;
          counts[kind].bytesKnown+=p.bytesKnown;
          counts[kind].sizesUnknown+=p.sizesUnknown;
          for(const id of p.ids){
            if(typeof id!=="string")throw Error("Objet R2 invalide");
            (kind==="objects"?foundObjects:foundRaw).add(kind+"/"+id);
          }
        });
      }
      let missing=0;
      for(const ref of refs){
        if(!(ref.startsWith("objects/")?foundObjects:foundRaw).has(ref))missing++;
      }
      counts.objects.withReceipt=[...foundObjects].filter(k=>refs.has(k)).length;
      counts.objects.orphaned=foundObjects.size-counts.objects.withReceipt;
      counts.raw.withReceipt=[...foundRaw].filter(k=>refs.has(k)).length;
      counts.raw.orphaned=foundRaw.size-counts.raw.withReceipt;
      report={kind:"LoSP-MSF-physical-R2-inventory",version:1,status:"complete",
        runId,checkedAt:new Date().toISOString(),source:"R2-only",
        receipts:counts.receipts,objects:counts.objects,raw:counts.raw,
        uniqueReferences:refs.size,duplicateReferences:validReferenceCount-refs.size,
        missingReferences:missing,
        note:"Comparaison des références des reçus et des objets physiques R2. "+
        "Aucune donnée de jeu lue, aucun appel Scopely, aucune mutation R2."};
      show(report);copy.disabled=false;
      status.textContent="Inventaire terminé. Copie le bilan JSON pour analyse.";
    }catch(e){
      status.textContent="Inventaire interrompu : "+(e instanceof Error?e.message:
        "erreur")+" Aucun bilan complet ne sera présenté.";
    }finally{start.disabled=false;busy=false;}
  });
  copy.addEventListener("click",async()=>{
    if(!report||report.status!=="complete")return;
    const serialized=JSON.stringify(report,null,2);
    try{
      await navigator.clipboard.writeText(serialized);
      status.textContent="Bilan JSON copié.";
    }catch{
      const pre=text("pre",serialized);
      pre.setAttribute("aria-label","Bilan JSON à copier");
      output.prepend(pre);
      status.textContent="Copie automatique indisponible ; sélectionne le JSON.";
    }
  });
})();
