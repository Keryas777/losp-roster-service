// Durable /game differential failure audit: the browser ONLY starts/displays it.
// A separate Cloudflare Cron tick advances the R2 checkpoint after page close.
(()=>{
  "use strict";
  const $=id=>document.getElementById(id);
  const run=$("game-diff-diagnostic-refresh"),
    status=$("game-diff-diagnostic-status"),
    summary=$("game-diff-diagnostic-summary"),
    results=$("game-diff-diagnostic-results"),
    cause=$("game-diff-diagnostic-cause"),
    state=$("game-diff-diagnostic-state"),
    more=$("game-diff-diagnostic-more");
  if(!run||!status||!summary||!results||!cause||!state||!more)return;
  const AUDIT="/admin/api/game-differential-failure-audit";
  const ROWS="/admin/api/game-differential-failures";
  const names={
    "http-472":"HTTP 472 · représentation refusée",
    "http-429":"HTTP 429 · temporisation",
    "http-4xx":"Autres refus HTTP 4xx",
    "http-5xx":"Réponse HTTP 5xx",
    network:"Réseau",
    "validation-or-storage":"Validation / archivage",
    other:"Autres / non identifiés"
  };
  const el=(tag,value,parent,cls)=>{
    const e=document.createElement(tag);
    if(value!==undefined)e.textContent=String(value);
    if(cls)e.className=cls;
    if(parent)parent.appendChild(e);
    return e;
  };
  const when=v=>v&&Number.isFinite(Date.parse(v))?
    new Date(v).toLocaleString("fr-FR"):"—";
  const num=v=>Number.isSafeInteger(v)?v.toLocaleString("fr-FR"):"—";
  const translate=v=>names[v]||v;
  const freq=obj=>Object.entries(obj||{}).filter(([,n])=>
    Number.isSafeInteger(n)&&n>=0).map(([value,count])=>({value,count}))
    .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,"fr"));
  const byPath=new Map();
  let report=null,cursor=null,rowsStarted=false,rowsComplete=false,busy=false;
  function group(parent,title,items,translated=false){
    const card=el("div",undefined,parent,"health-card");
    el("strong",title,card);
    if(!items.length)el("p","Aucune entrée.",card);
    for(const item of items.slice(0,15))
      el("p",(translated?translate(item.value):item.value)+
        " : "+num(item.count),card);
    if(items.length>15)el("p","Autres motifs : "+(items.length-15),card);
  }
  function chooseOptions(input,items,placeholder){
    const previous=input.value;
    input.replaceChildren();
    const all=el("option",placeholder,input);all.value="";
    for(const entry of items){
      const option=el("option",entry.label||entry.value,input);
      option.value=entry.value;
    }
    input.value=[...input.options].some(x=>x.value===previous)?previous:"";
  }
  function draw(){
    summary.replaceChildren();
    const stats=report?.stats;
    if(stats){
      const cards=el("div",undefined,summary,"health-cards");
      group(cards,"URL uniques du registre",[
        {value:"Parcourues",count:stats.scanned},
        {value:"Valides",count:stats.valid},
        {value:"En attente",count:stats.pending},
        {value:"Dont tentatives épuisées",count:stats.exhausted},
        {value:"URL originale résolue",count:stats.resolved},
        {value:"Avec variante récupérée",count:stats.variants},
        {value:"Entrées invalides",count:stats.rejected}
      ]);
      group(cards,"Par famille d'erreur",freq(report.byGroup),true);
      group(cards,"Par motif exact",freq(report.byReason));
      const info=el("div",undefined,summary,"health-card");
      el("strong","Périmètre et progression persistante",info);
      el("p","Départ : "+when(report.startedAt)+
        " · dernière avancée : "+when(report.updatedAt),info);
      const source=report.sourceAtStart||{};
      el("p","Campagne source : "+(source.runId||"—")+
        " · échecs comptabilisés : "+num(source.failed)+
        " (événements, pas URL uniques)",info);
      el("p","Rattrapage historique au départ : "+
        num(source.backfillScanned)+" / "+num(source.backfillTotal),info);
      if(report.sourceChanged)el("p",
        "Attention : la campagne différentielle a évolué pendant l'audit ; "+
        "le résultat est une photographie non homogène.",info);
      el("p","Une variante réussie ne prouve pas la résolution de "+
        "l'URL d'origine. Les compteurs restent provisoires avant la fin.",summary,"muted");
    }
    const running=report?.status==="running";
    run.disabled=busy||running;
    run.textContent=running?"Analyse en cours via Cron…":
      report?.status==="snapshot-complete"?"Recommencer un nouvel audit R2":
        "Analyser les échecs (R2)";
    status.textContent=!report||report.status==="not-started"?
      "Audit non démarré. Le lancement est manuel.":
      running?"Analyse R2 en cours (même si tu quittes cette page) · "+
        num(stats?.scanned)+" URL parcourues · "+num(stats?.pending)+
        " en attente · dernière progression : "+when(report.updatedAt):
      report.status==="snapshot-complete"?
        "Analyse terminée · "+num(stats?.valid)+
        " URL valides · "+num(stats?.pending)+" en attente · "+
        num(stats?.resolved)+" résolues.":
        "Statut : "+report.status;
    chooseOptions(cause,freq(report?.byGroup).map(x=>({
      value:x.value,label:translate(x.value)+" ("+num(x.count)+")"
    })),"Toutes les causes");
    chooseOptions(state,[
      {value:"pending",label:"En attente"},
      {value:"exhausted",label:"Tentatives épuisées"},
      {value:"resolved",label:"URL originale résolue"},
      {value:"variants",label:"Variantes récupérées"}
    ],"Tous les états");
    const rows=[...byPath.values()].filter(x=>
      (!cause.value||x.group===cause.value)&&
      (!state.value||state.value==="pending"&&x.status==="pending"||
        state.value==="exhausted"&&x.exhausted||
        state.value==="resolved"&&x.status==="resolved"||
        state.value==="variants"&&x.recoveredVariants>0))
      .sort((a,b)=>String(b.lastSeenAt||"").localeCompare(
        String(a.lastSeenAt||""))||a.path.localeCompare(b.path));
    results.replaceChildren();
    if(rowsStarted){
      el("p","Détail paginé : "+num(byPath.size)+
        " URL chargées ; les filtres ne concernent que ces lignes. "+
        "Les totaux au-dessus couvrent l'audit R2.",results,"muted");
      for(const row of rows){
        const card=el("div",undefined,results,"member-card");
        el("strong",row.path,card);
        el("p",translate(row.group)+" · "+row.reason,card);
        el("p",row.status==="resolved"?"URL d'origine résolue":
          row.exhausted?"Tentatives automatiques épuisées":
          "En attente de récupération",card);
        el("p","Campagnes échouées : "+num(row.attempts)+
          " · variantes récupérées : "+num(row.recoveredVariants),card);
        if(row.recoveryOf)el("p","Variante de : "+row.recoveryOf,card);
        el("p","Dernier constat : "+when(row.lastSeenAt)+
          " · prochain essai : "+when(row.nextAt),card);
      }
      if(!rows.length)el("p","Aucune des URL chargées ne correspond au filtre.",results);
    }
    more.hidden=!(report&&report.status!=="not-started")||rowsComplete;
    more.disabled=busy;
    more.textContent=rowsStarted?"Afficher les 40 URL suivantes":
      "Afficher les premières 40 URL";
  }
  async function fetchStatus(){
    const response=await fetch(AUDIT,{credentials:"same-origin",
      cache:"no-store",headers:{Accept:"application/json"}});
    if(!response.ok)throw Error("HTTP "+response.status);
    const data=await response.json();
    if(typeof data?.status!=="string")throw Error("rapport invalide");
    report=data;draw();
  }
  async function startAudit(){
    if(busy)return;
    busy=true;draw();
    try{
      const action=report?.status==="snapshot-complete"?"restart":"start";
      const response=await fetch(AUDIT,{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({action})
      });
      const data=await response.json();
      if(!response.ok)throw Error(data.error||"HTTP "+response.status);
      report=data;
      byPath.clear();cursor=null;rowsStarted=false;rowsComplete=false;
    }catch(error){
      status.textContent="Impossible de lancer l'audit : "+
        (error instanceof Error?error.message:"erreur");
    }finally{busy=false;draw();}
  }
  async function loadRows(){
    if(busy||rowsComplete)return;
    busy=true;draw();
    try{
      const suffix=cursor?"?cursor="+encodeURIComponent(cursor):"";
      const response=await fetch(ROWS+suffix,{credentials:"same-origin",
        cache:"no-store",headers:{Accept:"application/json"}});
      if(!response.ok)throw Error("HTTP "+response.status);
      const data=await response.json();
      if(!Array.isArray(data.entries))throw Error("réponse R2 invalide");
      for(const item of data.entries)byPath.set(item.path,item);
      if(data.nextCursor!==null&&
         (typeof data.nextCursor!=="string"||data.nextCursor===cursor))
        throw Error("pagination incohérente");
      cursor=data.nextCursor;
      rowsStarted=true;rowsComplete=cursor===null;
    }catch(error){
      status.textContent="Pagination interrompue : "+
        (error instanceof Error?error.message:"erreur");
    }finally{busy=false;draw();}
  }
  run.addEventListener("click",()=>void startAudit());
  more.addEventListener("click",()=>void loadRows());
  cause.addEventListener("change",draw);
  state.addEventListener("change",draw);
  void fetchStatus().catch(error=>{
    status.textContent="État R2 indisponible : "+
      (error instanceof Error?error.message:"erreur");
  });
  // Polling is display-only. Cron progress remains in R2 if Safari closes.
  setInterval(()=>{if(!busy&&report?.status==="running"&&
      !document.hidden)void fetchStatus().catch(()=>{});},15000);
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden&&!busy)void fetchStatus().catch(()=>{});
  });
})();
