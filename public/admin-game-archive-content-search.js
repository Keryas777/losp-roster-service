// Foreground-only, resumable private R2 JSON content search.
// The existing API scans at most 30 blobs per request; this UI automatically
// advances with one request at a time. No background worker or Scopely call.
(()=>{
  const query=document.getElementById("game-content-query"),
    start=document.getElementById("game-content-start"),
    more=document.getElementById("game-content-more"),
    pause=document.getElementById("game-content-pause"),
    status=document.getElementById("game-content-status"),
    results=document.getElementById("game-content-results");
  if(!query||!start||!more||!pause||!status||!results)return;
  const VALID=/^[A-Za-z0-9_:-]{3,100}$/;
  const CURSOR=/^[A-Za-z0-9+/=_-]{1,800}$/;
  const STORAGE="losp-r2-game-content-foreground-v2";
  const MAX_CARDS=20;
  const ZERO=()=>({listed:0,searched:0,tooLarge:0,expired:0,missing:0,unverified:0});
  let term="",cursor=null,totals=ZERO(),matches=0,done=false;
  let findings=[],otherSamples=[],running=false,stopping=false,controller=null;
  const node=(tag,value)=>{
    const el=document.createElement(tag);
    if(value!==undefined)el.textContent=String(value);
    return el;
  };
  const fmt=n=>Number(n||0).toLocaleString("fr-FR");
  function save(){
    try{sessionStorage.setItem(STORAGE,JSON.stringify({
      term,cursor,totals,matches,done,findings,otherSamples
    }));}catch{} // Safari private browsing may block storage.
  }
  function restore(){
    try{
      const s=JSON.parse(sessionStorage.getItem(STORAGE)||"null");
      if(!s||!VALID.test(s.term)||s.cursor!==null&&!CURSOR.test(s.cursor)||
        !s.totals||!Array.isArray(s.findings)||!Array.isArray(s.otherSamples))return;
      term=s.term;cursor=s.cursor;done=s.done===true;
      totals=Object.fromEntries(Object.keys(ZERO()).map(k=>
        [k,Number.isSafeInteger(s.totals[k])&&s.totals[k]>=0?s.totals[k]:0]));
      matches=Number.isSafeInteger(s.matches)?s.matches:0;
      findings=s.findings.slice(0,MAX_CARDS);
      otherSamples=s.otherSamples.slice(0,MAX_CARDS);
      query.value=term;render();
      status.textContent=(done?"Recherche terminée. ":"Recherche interrompue, reprise disponible. ")+progress();
    }catch{}
  }
  function reset(){
    term=query.value.trim();cursor=null;totals=ZERO();
    matches=0;done=false;findings=[];otherSamples=[];
    results.replaceChildren();save();
  }
  function progress(){
    return fmt(totals.searched)+" JSON examinés / "+fmt(totals.listed)+
      " fichiers listés · "+fmt(totals.tooLarge)+" volumineux · "+
      fmt(totals.expired)+" expirés · "+fmt(totals.unverified)+" non vérifiables · "+
      fmt(matches)+" JSON correspondants · "+fmt(findings.length)+" identifiant(s) distinct(s).";
  }
  function controls(){
    start.disabled=running;
    pause.hidden=!running;
    more.hidden=running||done||!cursor;
    pause.disabled=!running;
  }
  function addMatch(item){
    matches++;
    const ids=Array.isArray(item.materialIds)?item.materialIds:[];
    if(ids.length){
      for(const id of ids){
        if(typeof id!=="string"||
           !/^ABILITY_MATERIAL_[A-Z0-9_]{1,80}$/.test(id))continue;
        const existing=findings.find(x=>x.id===id);
        if(existing){existing.count++;continue;}
        if(findings.length<MAX_CARDS)findings.push({
          id,sha256:item.sha256,uploadedAt:item.uploadedAt,count:1
        });
      }
    }else if(otherSamples.length<MAX_CARDS &&
      !otherSamples.some(x=>x.sha256===item.sha256)){
      otherSamples.push({sha256:item.sha256,uploadedAt:item.uploadedAt,
        excerpts:(item.excerpts||[]).slice(0,2)});
    }
  }
  function fullJSON(card,sha){
    const btn=node("button","Afficher le JSON complet");btn.type="button";
    btn.addEventListener("click",async()=>{
      btn.disabled=true;
      try{
        const res=await fetch("/admin/api/game-archive-content-search?"+
          new URLSearchParams({sha}),{credentials:"same-origin",cache:"no-store"});
        const data=await res.json();
        if(!res.ok||data.status!=="found")
          throw Error(data.reason||data.error||"HTTP "+res.status);
        const raw=JSON.stringify(data.payload,null,2);
        const details=node("details"),title=node("summary",
          "JSON vérifié (URL originale non prouvée)");
        details.append(title,node("pre",raw));
        details.open=true;
        const copy=node("button","Copier ce JSON");copy.type="button";
        copy.addEventListener("click",async()=>{
          try{await navigator.clipboard.writeText(raw);
            status.textContent="JSON copié. "+progress();}
          catch{status.textContent="Copie indisponible, sélectionne le JSON affiché.";}
        });
        card.append(details,copy);btn.remove();
      }catch(error){
        btn.disabled=false;
        status.textContent="Impossible de lire ce JSON : "+
          (error instanceof Error?error.message:"erreur");
      }
    });
    card.append(btn);
  }
  function render(){
    results.replaceChildren();
    if(findings.length){
      const heading=node("h4","Identifiants de matériaux distincts retrouvés");
      results.append(heading);
      for(const match of findings){
        const card=node("article");card.className="member-card";
        card.append(node("strong",match.id));
        card.append(node("p",fmt(match.count)+" fichier(s) correspondant(s) · "+
          "SHA-256 vérifié · URL historique non prouvée"));
        card.append(node("p","Exemple stocké le : "+match.uploadedAt));
        fullJSON(card,match.sha256);results.append(card);
      }
    }
    if(otherSamples.length){
      const details=node("details");
      details.append(node("summary","Autres correspondances sans ID de matériau identifié ("+
        otherSamples.length+" premiers exemples)"));
      for(const match of otherSamples){
        const card=node("article");card.className="member-card";
        card.append(node("strong","JSON "+match.sha256.slice(0,12)+"…"));
        for(const excerpt of match.excerpts||[]){
          const pre=node("pre",excerpt);pre.className="scroll";card.append(pre);
        }
        fullJSON(card,match.sha256);details.append(card);
      }
      results.append(details);
    }
  }
  function stop(){
    if(!running)return;
    stopping=true;
    controller?.abort();
  }
  async function scan(restart){
    if(running)return;
    if(restart)reset();
    if(!VALID.test(term)){
      status.textContent="Saisis un terme de 3 à 100 caractères (lettres, chiffres, _ : -).";
      return;
    }
    if(done)return;
    running=true;stopping=false;controls();
    try{
      do{
        if(stopping)break;
        if(document.visibilityState==="hidden"){stopping=true;break;}
        if(query.value.trim()!==term){
          stopping=true;status.textContent="Terme modifié. Relance une recherche.";break;
        }
        status.textContent="Recherche automatique en cours… "+progress();
        const params=new URLSearchParams({q:term});
        if(cursor)params.set("cursor",cursor);
        controller=new AbortController();
        const response=await fetch("/admin/api/game-archive-content-search?"+params,{
          credentials:"same-origin",cache:"no-store",signal:controller.signal});
        const data=await response.json();
        controller=null;
        if(stopping)break;
        if(!response.ok)throw Error(data.error||"HTTP "+response.status);
        if(data.query!==term||!data.stats||!Array.isArray(data.matches))
          throw Error("Réponse R2 inattendue");
        for(const key of Object.keys(totals))totals[key]+=data.stats[key]||0;
        for(const item of data.matches)addMatch(item);
        if(data.status==="complete"){
          done=true;cursor=null;
        }else if(data.status==="searching"&&CURSOR.test(data.nextCursor||"")&&
          data.nextCursor!==cursor){
          cursor=data.nextCursor;
        }else throw Error("Pagination R2 incohérente");
        save();
        if(data.matches.length)render();
        status.textContent=(done?"Recherche terminée dans les fichiers admissibles. ":
          "Recherche automatique en cours… ")+progress();
        // Yield between pages: keep Safari responsive and R2 requests sequential.
        if(!done)await new Promise(resolve=>setTimeout(resolve,180));
      }while(!done&&!stopping);
    }catch(error){
      if(!stopping)status.textContent="Recherche suspendue : "+
        (error instanceof Error?error.message:"erreur")+". "+progress();
    }finally{
      controller=null;running=false;controls();save();
      if(stopping)
        status.textContent="Recherche en pause. "+progress()+
          " Appuie sur « Poursuivre la recherche » pour reprendre.";
      else if(done)
        status.textContent="Recherche terminée dans les JSON d'origine lisibles. "+
          progress()+" Les objets volumineux, expirés et les deltas ne sont pas couverts.";
    }
  }
  start.addEventListener("click",()=>void scan(true));
  more.addEventListener("click",()=>void scan(false));
  pause.addEventListener("click",stop);
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="hidden")stop();
  });
  query.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();void scan(true);}
  });
  restore();controls();
})();
