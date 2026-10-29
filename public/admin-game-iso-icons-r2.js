// Private /game/v1 ISO-8 image report. All URLs were validated server-side.
(()=>{
  "use strict";
  const button=document.getElementById("game-iso-r2-check");
  const status=document.getElementById("game-iso-r2-status");
  const report=document.getElementById("game-iso-r2-report");
  if(!button||!status||!report)return;
  const labels={striker:"Attaquant",raider:"Fantassin",
    skirmisher:"Tirailleur",healer:"Soigneur",
    fortifier:"Fortificateur"};
  const node=(tag,value)=>{
    const el=document.createElement(tag);
    if(value!==undefined)el.textContent=String(value);
    return el;
  };
  const validUrl=value=>{
    try{
      const url=new URL(value);
      return url.protocol==="https:"&&
        url.hostname==="assets.marvelstrikeforce.com"&&
        !url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&
        /^\/imgs\/[A-Za-z0-9_.-]+\.(png|webp)$/i.test(url.pathname)?
        url.href:null;
    }catch{return null;}
  };
  button.addEventListener("click",async()=>{
    button.disabled=true;
    report.replaceChildren();
    status.textContent="Lecture des six références ISO-8 dans R2…";
    try{
      const res=await fetch("/admin/api/game-iso-icons-r2",{
        credentials:"same-origin",cache:"no-store"});
      if(!res.ok)throw Error("HTTP "+res.status);
      const data=await res.json();
      if(data.status!=="ok"||!Array.isArray(data.classes))
        throw Error("Réponse inattendue");
      const shape=data.rootStructure||{};
      const intro=node("div");intro.className="member-card";
      intro.append(node("strong","Structure du JSON R2 principal"));
      intro.append(node("p","Type : "+(shape.kind||"indéterminé")+
        " · Champs : "+(shape.fields?.join(", ")||"aucun")));
      const detail=node("details");
      detail.append(node("summary","Voir la structure complète (noms de champs uniquement)"));
      detail.append(node("pre",JSON.stringify(shape,null,2)));
      intro.append(detail);report.append(intro);
      for(const entry of data.classes){
        const card=node("div");card.className="member-card";
        card.append(node("h3",labels[entry.id]||entry.id));
        const candidate=entry.tier4||{};
        const image=validUrl(candidate.url);
        card.append(node("p","Structure capacité : "+(entry.status||"inconnue")+
          " · icons : "+(entry.structure?.selected?.iconsKind||"absent")+
          " · éléments : "+(entry.iconCount??"non disponible")));
        const fields=entry.structure?.selected?.fields||[];
        card.append(node("p","Champs : "+(fields.join(", ")||"aucun")));
        const schema=node("details");
        schema.append(node("summary","Comparer les structures de la racine et du détail"));
        schema.append(node("pre",JSON.stringify(entry.structure||{},null,2)));
        card.append(schema);
        card.append(node("p","Indice 4 : "+(image?
          "PNG officiel candidat — à comparer au jeu":
          candidate.status||"absent")));
        if(image){
          const link=node("a");link.href=image;link.target="_blank";
          link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";
          const img=node("img");img.src=image;
          img.alt="Visuel candidat ISO orange — "+(labels[entry.id]||entry.id);
          img.width=76;img.height=76;img.loading="lazy";
          img.decoding="async";img.referrerPolicy="no-referrer";
          link.append(img);card.append(link);
          const details=node("details");
          details.append(node("summary","URL PNG officielle"));
          const code=node("code",image);code.style.overflowWrap="anywhere";
          details.append(code);card.append(details);
        }
        card.append(node("p","Source : "+(entry.sourcePath||"aucune")+
          " · "+(entry.sourceStatus||"indisponible")));
        if(entry.provenance==="legacy-path-not-receipt-certified"){
          card.append(node("p","Archive historique V1 : contenu et date R2 contrôlés, "+
            "mais provenance de la route non certifiée par un reçu V2."));
          if(entry.observedHashMatchesStorage===false)
            card.append(node("p","Attention : l'empreinte observée du vieux "+
              "pointeur diffère du fichier physiquement vérifié."));
        }
        if(entry.storedAt)
          card.append(node("p","Stockage R2 : "+entry.storedAt));
        report.append(card);
      }
      const legacy=(data.sources||[]).filter(x=>x.status==="legacy-byte-verified");
      const missing=(data.sources||[]).filter(x=>
        x.status!=="verified"&&x.status!=="legacy-byte-verified");
      status.textContent="Structure R2 inspectée, sans exposer les valeurs. "+
        "Lecture R2 terminée : "+
        data.classes.filter(x=>x.tier4?.url).length+
        "/5 candidats avec une URL officielle. "+
        (legacy.length?legacy.length+" source(s) historiques V1 à provenance limitée. ":"")+
        (missing.length?missing.length+" route(s) sans contenu contrôlé. ":"")+
        "L'indice 4 doit encore être comparé visuellement au jeu. Aucun appel Scopely.";
    }catch(err){
      status.textContent="Diagnostic R2 indisponible : "+
        (err instanceof Error?err.message:"erreur");
    }finally{button.disabled=false;}
  });
})();
