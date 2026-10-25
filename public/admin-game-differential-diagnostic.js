// Explicit, private R2-only differential failure diagnostic.
// Progressive cursor pagination; never calls Scopely or starts a collection.
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
  const el=(tag,value,parent,cls)=>{
    const e=document.createElement(tag);
    if(value!==undefined)e.textContent=String(value);
    if(cls)e.className=cls;
    if(parent)parent.appendChild(e);
    return e;
  };
  const when=value=>value&&Number.isFinite(Date.parse(value))?
    new Date(value).toLocaleString("fr-FR"):"—";
  const counter=x=>Number.isSafeInteger(x)?x:"—";
  const reasons={
    "http-472":"HTTP 472 · représentation refusée",
    "http-429":"HTTP 429 · temporisation",
    "http-4xx":"Autres refus HTTP 4xx",
    "http-5xx":"Réponse HTTP 5xx",
    network:"Réseau",
    "validation-or-storage":"Validation / archivage",
    other:"Autres / non identifiés"
  };
  const byPath=new Map();
  let cursor=null,busy=false,started=false,complete=false,seen=0,
    rejected=0,checkpoint=null,checkpointsConsistent=true,shown=40;
  const groupValue=x=>reasons[x]||x;
  function errorState(row){
    if(row.status==="resolved")return "resolved";
    if(row.exhausted)return "exhausted";
    return "pending";
  }
  function metrics(){
    const rows=[...byPath.values()];
    const active=rows.filter(x=>x.status==="pending");
    return {rows,active,
      resolved:rows.filter(x=>x.status==="resolved").length,
      exhausted:active.filter(x=>x.exhausted).length,
      variants:rows.filter(x=>x.recoveredVariants>0).length,
      byGroup:frequency(rows,x=>x.group),
      byReason:frequency(rows,x=>x.reason)};
  }
  function frequency(rows,fn){
    const map=new Map();
    for(const row of rows){
      const v=fn(row);
      map.set(v,(map.get(v)||0)+1);
    }
    return [...map].map(([value,count])=>({value,count}))
      .sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,"fr"));
  }
  function group(parent,title,items,translate){
    const card=el("div",undefined,parent,"health-card");
    el("strong",title,card);
    if(!items.length)el("p","Aucune entrée à ce stade.",card);
    for(const item of items.slice(0,15))
      el("p",(translate?groupValue(item.value):item.value)+
        " : "+item.count,card);
    if(items.length>15)el("p","… autres motifs : "+
      (items.length-15),card);
  }
  function selectOptions(select,values,label){
    const old=select.value;
    select.replaceChildren();
    const none=el("option",label,select);none.value="";
    for(const item of values){
      const option=el("option",item.label||item.value,select);
      option.value=item.value;
    }
    select.value=[...select.options].some(x=>x.value===old)?old:"";
  }
  function render(){
    const m=metrics();
    summary.replaceChildren();
    const statusLabel=complete?"Lecture terminée":"Lecture partielle";
    const counters=el("div",undefined,summary,"health-cards");
    group(counters,"URL uniques enregistrées",[
      {value:"Registre R2",count:m.rows.length},
      {value:"Attente (toutes)",count:m.active.length},
      {value:"Dont tentatives épuisées",count:m.exhausted},
      {value:"Résolution de l'URL d'origine",count:m.resolved},
      {value:"Avec ≥1 variante récupérée",count:m.variants}
    ],false);
    group(counters,"Par code / famille d'erreur",m.byGroup,true);
    group(counters,"Par motif exact enregistré",m.byReason,false);
    if(checkpoint){
      const scan=checkpoint.backfillScanned,total=checkpoint.backfillTotal;
      const info=el("div",undefined,summary,"health-card");
      el("strong","Périmètre et couverture",info);
      el("p","Campagne : "+checkpoint.runId+" · "+
        checkpoint.status,info);
      el("p","Compteur d'échecs du checkpoint : "+
        counter(checkpoint.failed)+" (cumul d'événements, "+
        "pas nombre d'URL distinctes)",info);
      el("p","Rattrapage des anciens reçus : "+
        (Number.isSafeInteger(scan)&&Number.isSafeInteger(total)?
          scan+" / "+total:
          "progression non disponible"),info);
      if(!Number.isSafeInteger(scan)||!Number.isSafeInteger(total)||
         scan<total)el("p","Attention : le rattrapage historique "+
           "n'est pas attesté terminé ; ce diagnostic ne couvre "+
           "pas encore nécessairement tous les anciens échecs.",info);
      if(!checkpointsConsistent)el("p","La campagne a évolué pendant "+
        "la lecture : chiffres à réactualiser pour une photographie "+
        "homogène.",info);
    }
    el("p","Lecture : "+statusLabel+" · "+seen+
      " entrées R2 parcourues"+
      (rejected?" · "+rejected+" entrées invalides non classées":"")+
      ". Les récupérations par variantes ne prouvent pas la "+
      "reconstitution du JSON initial. Une URL peut rester en attente "+
      "tout en ayant des variantes récupérées.",summary,"muted");
    selectOptions(cause,m.byGroup.map(x=>({value:x.value,
      label:groupValue(x.value)+" ("+x.count+")"})),"Toutes les causes");
    selectOptions(state,[
      {value:"pending",label:"En attente"},
      {value:"exhausted",label:"Tentatives épuisées"},
      {value:"resolved",label:"URL originale résolue"},
      {value:"variants",label:"Variantes récupérées"}
    ],"Tous les états");
    const filtered=m.rows.filter(x=>
      (!cause.value||x.group===cause.value)&&
      (!state.value||state.value==="variants"&&x.recoveredVariants>0||
       state.value!=="variants"&&errorState(x)===state.value));
    filtered.sort((a,b)=>String(b.lastSeenAt||"").localeCompare(
      String(a.lastSeenAt||""))||a.path.localeCompare(b.path));
    results.replaceChildren();
    for(const row of filtered.slice(0,shown)){
      const card=el("div",undefined,results,"member-card");
      el("strong",row.path,card);
      el("p",groupValue(row.group)+" · "+row.reason,card);
      el("p",row.status==="resolved"?"URL originale résolue":
        row.exhausted?"Tentatives automatiques épuisées":
          "En attente de récupération",card);
      el("p","Campagnes échouées : "+counter(row.attempts)+
        " · variantes récupérées : "+row.recoveredVariants,card);
      if(row.recoveryOf)el("p","Variante de : "+row.recoveryOf,card);
      el("p","Dernier constat : "+when(row.lastSeenAt)+
        " · prochain essai : "+when(row.nextAt),card);
    }
    if(!filtered.length)el("p","Aucune URL pour ce filtre.",results);
    more.hidden=filtered.length<=shown;
    more.textContent="Afficher davantage d’URL ("+
      Math.min(filtered.length-shown,40)+")";
    status.textContent=statusLabel+" · "+m.rows.length+
      " URL distinctes suivies · "+m.active.length+
      " en attente · "+m.exhausted+" tentatives épuisées."+
      " Aucun appel Scopely.";
    run.textContent=!complete&&started&&cursor?
      "Continuer l’analyse R2":"Relancer l’analyse R2";
  }
  function reset(){
    byPath.clear();cursor=null;started=true;complete=false;
    seen=0;rejected=0;checkpoint=null;shown=40;checkpointsConsistent=true;
  }
  async function load(){
    if(busy)return;
    if(!started||complete)reset();
    busy=true;run.disabled=true;
    try{
      // Maximum 100 pages (= 4 000 records) per explicit action.
      // Larger ledgers require another click, never an infinite loop.
      for(let page=0;page<100;page++){
        const suffix=cursor?"?cursor="+encodeURIComponent(cursor):"";
        const response=await fetch(
          "/admin/api/game-differential-failures"+suffix,{
            credentials:"same-origin",cache:"no-store",
            headers:{Accept:"application/json"}
          });
        if(!response.ok)throw Error("HTTP "+response.status);
        const data=await response.json();
        if(data.status==="not-started"){
          complete=true;break;
        }
        if(data.status!=="ok"||!Array.isArray(data.entries)||
           !data.checkpoint||typeof data.checkpoint.runId!=="string")
          throw Error("rapport R2 invalide");
        if(checkpoint&&(checkpoint.runId!==data.checkpoint.runId||
           checkpoint.failed!==data.checkpoint.failed||
           checkpoint.backfillScanned!==data.checkpoint.backfillScanned))
          checkpointsConsistent=false;
        checkpoint=data.checkpoint;
        seen+=data.totalInPage||0;rejected+=data.rejected||0;
        for(const item of data.entries)byPath.set(item.path,item);
        if(data.nextCursor!==null&&
           (typeof data.nextCursor!=="string"||data.nextCursor===cursor))
          throw Error("pagination incohérente");
        cursor=data.nextCursor;
        complete=cursor===null;
        if(page===0||page%5===0||complete)render();
        if(complete)break;
      }
      render();
    }catch(error){
      status.textContent="Diagnostic interrompu : "+
        (error instanceof Error?error.message:"erreur")+
        ". Aucun résultat partiel n'est déclaré définitif.";
      run.textContent="Reprendre l’analyse R2";
    }finally{busy=false;run.disabled=false;}
  }
  run.addEventListener("click",()=>void load());
  cause.addEventListener("change",()=>{shown=40;render();});
  state.addEventListener("change",()=>{shown=40;render();});
  more.addEventListener("click",()=>{shown+=40;render();});
})();
