// Manual, durable, R2-only comparison audit. Never auto-fetches on load.
(()=>{
  "use strict";
  const $=id=>document.getElementById(id);
  const button=$("game-diff-comparison-start");
  const copy=$("game-diff-comparison-copy");
  const status=$("game-diff-comparison-status");
  const summary=$("game-diff-comparison-summary");
  const results=$("game-diff-comparison-results");
  if(!button||!copy||!status||!summary||!results)return;
  const API="/admin/api/game-differential-comparison-audit";
  const labels={
    "false-change":"Même contenu utile mais classé modifié",
    "missed-change":"Différence non détectée",
    "byte-identical":"Octets strictement identiques",
    "only-asof-or-order":"Contenu sémantique identique",
    "metadata-other-change":"Autres métadonnées modifiées",
    "serialization-order-change":"Ordre des propriétés JSON modifié, valeurs identiques",
    "data-change":"Données métier modifiées",
    "no-linked-previous-version":"Version précédente non liée",
    "previous-receipt-missing":"Ancien reçu manquant",
    "previous-receipt-inconsistent":"Ancien reçu incohérent",
    "no-current-receipt":"Reçu actuel absent",
    "current-receipt-inconsistent":"Reçu actuel incohérent",
    "semantic-receipt-mismatch":"Empreinte sémantique incompatible",
    "invalid-self-link":"Référence sur elle-même"
  };
  const el=(tag,value,parent,cls)=>{
    const node=document.createElement(tag);
    if(value!==undefined)node.textContent=String(value);
    if(cls)node.className=cls;
    if(parent)parent.appendChild(node);
    return node;
  };
  const fmtDate=v=>v&&!Number.isNaN(Date.parse(v))?
    new Date(v).toLocaleString("fr-FR"):"—";
  let report=null,busy=false,started=false;
  const warning=x=>["false-change","missed-change","semantic-receipt-mismatch"].includes(x)||
    x.includes("mismatch")||x.includes("inconsistent");
  function draw(){
    if(!report)return;
    const completed=report.status==="snapshot-complete";
    status.textContent=(completed?"Analyse terminée":"Analyse en cours")+
      " · "+(report.sampled||0)+" / "+(report.limit||24)+
      " URL examinées · "+(report.scanned||0)+" pointeurs parcourus."+
      (report.sourceChanged?" Attention : la campagne source a évolué pendant la lecture.":"");
    button.textContent=completed?"Relancer le diagnostic R2":
      "Actualiser l'état du diagnostic R2";
    copy.disabled=!completed;
    summary.replaceChildren();results.replaceChildren();
    const counts=el("div",undefined,summary,"health-card");
    el("strong","Périmètre réel",counts);
    el("p","Échantillon : "+(report.sampled||0)+
      " URL · pointeurs parcourus : "+(report.scanned||0)+
      " · ignorés : "+(report.skipped||0),counts);
    el("p","Campagne source : "+(report.sourceAtStart?.runId||"—")+
      " · contrôles initiaux : "+(report.sourceAtStart?.checked??"—"),counts);
    el("p","Début : "+fmtDate(report.startedAt)+
      " · fin : "+fmtDate(report.finishedAt),counts);
    el("p","Arrêt de l'échantillonnage : "+(report.reason||"en cours"),counts);
    if(report.sourceChanged)
      el("p","La campagne source a évolué pendant l'audit : les observations ne forment pas un instantané transactionnel.",counts);
    const categories=el("div",undefined,summary,"health-card");
    el("strong","Classements observés",categories);
    for(const [kind,n] of Object.entries(report.byClass||{}).
      sort((a,b)=>b[1]-a[1])){
      const text=(labels[kind]||kind)+" : "+n;
      el("p",text,categories);
    }
    if(!Object.keys(report.byClass||{}).length)
      el("p","Aucun échantillon encore analysé.",categories);
    el("p","Échantillon exploratoire : ces proportions ne sont pas représentatives des 12 232 URL. Un reçu sans version précédente liée n'autorise aucune conclusion sur les différences.",summary,"muted");
    for(const item of report.rows||[]){
      const card=el("div",undefined,results,"member-card");
      el("strong",item.path||"(chemin non identifié)",card);
      el("p",(labels[item.classification]||item.classification)+
        " · "+item.group,card);
      if(item.recordedStatus)
        el("p","Classement du collecteur : "+item.recordedStatus,card);
      if(Array.isArray(item.changedFields)&&item.changedFields.length)
        el("p","Champs concernés : "+item.changedFields.join(", "),card);
      if(warning(item.classification))
        el("p","Anomalie ou incompatibilité à examiner avant modification du collecteur.",card);
    }
  }
  async function load(){
    const response=await fetch(API,{
      credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}
    });
    const json=await response.json();
    if(!response.ok)throw Error(json.error||"HTTP "+response.status);
    return json;
  }
  async function submit(action){
    const response=await fetch(API,{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({action})
    });
    const json=await response.json();
    if(!response.ok)throw Error(json.error||"HTTP "+response.status);
    return json;
  }
  async function click(){
    if(busy)return;
    busy=true;button.disabled=true;
    try{
      const existing=await load();
      report=existing.status==="not-started"?
        await submit("start"):existing.status==="snapshot-complete"?
          await submit("restart"):existing;
      started=true;draw();
    }catch(err){
      status.textContent="Diagnostic indisponible : "+
        (err instanceof Error?err.message:"erreur");
    }finally{busy=false;button.disabled=false;}
  }
  button.addEventListener("click",()=>void click());
  copy.addEventListener("click",()=>{
    if(report?.status==="snapshot-complete"&&navigator.clipboard?.writeText)
      void navigator.clipboard.writeText(JSON.stringify(report,null,2))
        .then(()=>{status.textContent="Rapport JSON copié.";})
        .catch(()=>{status.textContent="Copie impossible sur ce navigateur.";});
  });
  // No timer until a user explicitly launches/opens the audit.
  setInterval(()=>{
    if(!started||busy||report?.status!=="running"||document.hidden)return;
    busy=true;
    void load().then(data=>{report=data;draw();})
      .catch(()=>{status.textContent="Lecture R2 temporairement indisponible.";})
      .finally(()=>{busy=false;});
  },15000);
  document.addEventListener("visibilitychange",()=>{
    if(!started||document.hidden||busy||report?.status!=="running")return;
    busy=true;
    void load().then(data=>{report=data;draw();})
      .catch(()=>{}).finally(()=>{busy=false;});
  });
})();
