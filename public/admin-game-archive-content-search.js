// Search original /game/v1 R2 JSON CONTENTS, including orphaned hash-addressed blobs.
// Separate from the existing exact-path /items/{id} lookup.
(()=>{
  const query=document.getElementById("game-content-query"),
    start=document.getElementById("game-content-start"),
    more=document.getElementById("game-content-more"),
    status=document.getElementById("game-content-status"),
    results=document.getElementById("game-content-results");
  if(!query||!start||!more||!status||!results)return;
  const VALID=/^[A-Za-z0-9_:-]{3,100}$/;
  const PAGES=12;
  let term="",cursor=null,working=false,totals=null,matchCount=0;
  const node=(tag,value)=>{
    const el=document.createElement(tag);
    if(value!==undefined)el.textContent=String(value);
    return el;
  };
  const fmt=n=>Number(n||0).toLocaleString("fr-FR");
  function reset(){
    totals={listed:0,searched:0,tooLarge:0,expired:0,missing:0,unverified:0};
    cursor=null;matchCount=0;results.replaceChildren();more.hidden=true;
  }
  function progress(){
    return fmt(totals.searched)+" JSON parcourus / "+fmt(totals.listed)+
      " objets listés · "+fmt(totals.tooLarge)+" trop volumineux · "+
      fmt(totals.expired)+" expirés · "+fmt(totals.unverified)+" non vérifiables"+
      " · "+fmt(matchCount)+" résultat(s).";
  }
  function addMatch(item){
    matchCount++;
    const card=node("article");card.className="member-card";
    const short=item.sha256.slice(0,12);
    card.append(node("strong","Correspondance dans le JSON "+short+"…"));
    card.append(node("p","Stocké le "+item.uploadedAt+
      " · Empreinte SHA-256 vérifiée. URL historique non prouvée."));
    for(const example of item.excerpts||[]){
      const snippet=node("pre",example);
      snippet.className="scroll";
      card.append(snippet);
    }
    const btn=node("button","Afficher le JSON complet");
    btn.type="button";
    btn.addEventListener("click",async()=>{
      btn.disabled=true;
      try{
        const res=await fetch("/admin/api/game-archive-content-search?"+
          new URLSearchParams({sha:item.sha256}),{
            credentials:"same-origin",cache:"no-store"});
        const data=await res.json();
        if(!res.ok||data.status!=="found")throw Error(data.reason||data.error||"HTTP "+res.status);
        const full=JSON.stringify(data.payload,null,2);
        const details=node("details"),title=node("summary","JSON original (provenance de l'URL inconnue)");
        details.append(title,node("pre",full));details.open=true;
        const copy=node("button","Copier ce JSON");copy.type="button";
        copy.addEventListener("click",async()=>{
          try{await navigator.clipboard.writeText(full);
            status.textContent="JSON copié. "+progress();}
          catch{status.textContent="Copie automatique indisponible. "+progress();}
        });
        card.append(details,copy);btn.remove();
      }catch(err){
        status.textContent="Lecture du JSON impossible : "+
          (err instanceof Error?err.message:"erreur");btn.disabled=false;
      }
    });
    card.append(btn);results.append(card);
  }
  async function run(restart){
    if(working)return;
    if(restart){
      reset();
      term=query.value.trim();
      if(!VALID.test(term)){
        status.textContent="Saisis un terme de 3 à 100 caractères (lettres, chiffres, _ : -).";
        return;
      }
    }
    working=true;start.disabled=true;more.hidden=true;
    try{
      for(let page=0;page<PAGES;page++){
        if(query.value.trim()!==term){
          reset();status.textContent="Terme modifié. Relance une nouvelle recherche.";return;
        }
        status.textContent="Recherche du contenu R2… "+progress();
        const params=new URLSearchParams({q:term});
        if(cursor)params.set("cursor",cursor);
        const response=await fetch("/admin/api/game-archive-content-search?"+params,{
          credentials:"same-origin",cache:"no-store"});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||"HTTP "+response.status);
        if(data.query!==term||!data.stats||!Array.isArray(data.matches))
          throw Error("Réponse inattendue");
        for(const key of Object.keys(totals))totals[key]+=data.stats[key]||0;
        for(const item of data.matches)addMatch(item);
        if(data.status==="complete"){
          status.textContent="Recherche terminée dans les objets originaux accessibles. "+
            progress()+" Les objets ignorés et le différentiel ne sont pas couverts.";
          return;
        }
        if(data.status!=="searching"||!data.nextCursor)
          throw Error("Pagination incohérente");
        cursor=data.nextCursor;
        if(data.matches.length){
          more.hidden=false;
          status.textContent="Correspondance(s) trouvée(s). "+progress()+
            " La recherche peut être poursuivie.";
          return;
        }
      }
      more.hidden=false;
      status.textContent="Recherche partielle. "+progress()+
        " Clique sur « Poursuivre » pour examiner la suite.";
    }catch(err){
      more.hidden=!cursor;
      status.textContent="Recherche indisponible : "+
        (err instanceof Error?err.message:"erreur")+". "+progress();
    }finally{working=false;start.disabled=false;}
  }
  start.addEventListener("click",()=>void run(true));
  more.addEventListener("click",()=>void run(false));
  query.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();void run(true);}
  });
})();
