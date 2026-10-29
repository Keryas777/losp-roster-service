// Targeted private R2 item lookup. Never calls Scopely.
(()=>{
  const input=document.getElementById("game-item-id"),
    start=document.getElementById("game-item-search"),
    more=document.getElementById("game-item-more"),
    copy=document.getElementById("game-item-copy"),
    state=document.getElementById("game-item-status"),
    output=document.getElementById("game-item-result");
  if(!input||!start||!more||!copy||!state||!output)return;
  const VALID=/^[A-Za-z0-9:_-]{1,180}$/;
  const MAX_PAGES=20; // 20 receipts/page; explicit continuation for longer archives.
  let cursor=null,queryId="",scanned=0,payload=null,busy=false,issue=null;
  const node=(tag,value)=>{
    const el=document.createElement(tag);
    if(value!==undefined)el.textContent=String(value);
    return el;
  };
  function reset(){
    cursor=null;scanned=0;payload=null;issue=null;copy.disabled=true;
    more.hidden=true;output.replaceChildren();
  }
  function render(found){
    payload=found.payload;
    const card=node("div");
    card.className="member-card";
    card.append(node("strong","Fiche archivée vérifiée : "+found.path));
    card.append(node("p","Source : "+(found.source==="differential"?
      "index différentiel":"reçu de l'archive d'origine")));
    card.append(node("p","Données stockées le : "+found.storedAt));
    card.append(node("p","Le JSON provient de R2, pas d'un nouvel appel Scopely."));
    const details=node("details"),summary=node("summary","Voir le JSON complet");
    details.open=true;
    details.append(summary,node("pre",JSON.stringify(payload,null,2)));
    card.append(details);output.replaceChildren(card);
    copy.disabled=false;
  }
  async function run(restart){
    if(busy)return;
    if(restart){
      reset();queryId=input.value.trim();
      if(!VALID.test(queryId)){
        state.textContent="Saisis un ID d'objet valide (lettres, chiffres, _ : -).";
        return;
      }
    }
    busy=true;start.disabled=true;more.hidden=true;
    try{
      for(let page=0;page<MAX_PAGES;page++){
        if(input.value.trim()!==queryId){
          state.textContent="Identifiant modifié : relance une nouvelle recherche.";
          reset();return;
        }
        const q=new URLSearchParams({id:queryId});
        if(cursor)q.set("cursor",cursor);
        state.textContent="Recherche dans R2 : "+scanned+
          " reçu(s) de l'archive d'origine examinés…";
        const response=await fetch("/admin/api/game-archive-item-search?"+q,{
          credentials:"same-origin",cache:"no-store"});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||"HTTP "+response.status);
        if(data.id!==queryId)throw Error("Réponse inattendue");
        if(data.status==="found"){
          render(data);
          state.textContent="Fiche trouvée et vérifiée dans R2. Aucun appel Scopely.";
          return;
        }
        scanned+=data.examined||0;
        issue=issue||data.issue||null;
        if(data.status==="not-indexed"){
          state.textContent="Aucune fiche vérifiée pour cet ID après "+scanned+
            " reçu(s). Cela ne prouve pas son absence du jeu ni des objets R2 orphelins."+
            (issue?" Avertissement : "+issue+".":"");
          return;
        }
        if(data.status!=="searching"||!data.nextCursor)
          throw Error("Pagination R2 incohérente");
        cursor=data.nextCursor;
      }
      more.hidden=false;
      state.textContent=scanned+" reçu(s) vérifiés. Recherche incomplète : "+
        "appuie sur « Continuer la recherche » pour poursuivre.";
    }catch(e){
      more.hidden=!cursor;
      state.textContent="Recherche R2 indisponible : "+
        (e instanceof Error?e.message:"erreur");
    }finally{busy=false;start.disabled=false;}
  }
  start.addEventListener("click",()=>void run(true));
  more.addEventListener("click",()=>void run(false));
  input.addEventListener("keydown",event=>{
    if(event.key==="Enter"){event.preventDefault();void run(true);}
  });
  copy.addEventListener("click",async()=>{
    if(!payload)return;
    try{
      await navigator.clipboard.writeText(JSON.stringify(payload,null,2));
      state.textContent="JSON archivé copié.";
    }catch{
      state.textContent="Copie automatique impossible : sélectionne le JSON affiché.";
    }
  });
})();
