// A single read-only request shows what has actually been archived.
// This script NEVER calls Scopely, sessions, roster preflight or any start action.
(()=>{
  "use strict";
  const button=document.getElementById("collection-dashboard-refresh");
  const output=document.getElementById("collection-dashboard-content");
  const status=document.getElementById("collection-dashboard-status");
  if(!button||!output||!status)return;
  const node=(tag,text,parent,cls)=>{
    const x=document.createElement(tag);
    if(text!==undefined&&text!==null)x.textContent=String(text);
    if(cls)x.className=cls;
    if(parent)parent.appendChild(x);
    return x;
  };
  const time=v=>{
    if(typeof v!=="string"||!Number.isFinite(Date.parse(v)))return "—";
    return new Date(v).toLocaleString("fr-FR");
  };
  const count=x=>Number.isSafeInteger(x)?String(x):"—";
  function tile(parent,title,headline,detail,kind="neutral"){
    const card=node("article",null,parent,"collection-tile collection-"+kind);
    node("strong",title,card);
    node("div",headline,card,"collection-metric");
    node("p",detail,card);
  }
  const label=v=>({
    running:"En cours",complete:"Terminée",partial:"Partielle",
    completed:"Terminée", "completed-with-gaps":"Terminée avec lacunes",
    scanning:"Indexation R2",checking:"Vérification des données",
    "up-to-date":"À jour",cooldown:"En pause",
    "not-started":"Non démarrée",ready:"Programmée",disabled:"Désactivée",
    "not-configured":"Non configurée",archived:"Archivé",
    missing:"Absent",expired:"Expiré",valid:"Manifeste présent",
    "in-progress":"En cours","missing-pages":"Pages manquantes",
    "partial-consent":"Partages incomplets",
    "complete-co-members":"Roster personnel en attente",
    "on-demand":"À la demande","not-verified":"Non vérifié",
    "archived-unindexed":"Archive brute, non indexée",
    "awaiting-initial-archive":"En attente de l'archive initiale",
    "awaiting-initial-completion":"Archive initiale en cours",
    "awaiting-phase2":"En attente de la phase 2",
    "not-yet-observed":"Pas encore observé",
    unavailable:"État indisponible"
  })[v]||v||"Inconnu";

  // Render official MSF color markers as text + a bounded CSS color.
  // The alliance label remains the original Unicode text; never use innerHTML.
  function allianceNameParts(value){
    const raw=String(value??"");
    const markers=raw.match(/<#[0-9a-f]{6}>/gi);
    const color=markers?.length?"#"+markers[markers.length-1].slice(2,-1):null;
    const cleaned=raw.replace(/<#[0-9a-f]{6}>/gi,"")
      .replace(/\s+/g," ").trim().replace(/^(LoSP\s+){2,}/i,"LoSP ");
    const match=/^(LoSP\s+)(.+)$/i.exec(cleaned);
    return {prefix:match?.[1]||"",name:match?.[2]||cleaned,color};
  }
  function allianceTitle(parent,value){
    const parts=allianceNameParts(value);
    const title=node("strong",null,parent,"collection-alliance-name");
    if(parts.prefix)node("span",parts.prefix,title);
    const name=node("span",parts.name,title);
    if(parts.color)name.style.color=parts.color;
  }
  function renderProgress(parent,metric,description){
    if(!metric||!Number.isSafeInteger(metric.done)||
       !Number.isSafeInteger(metric.total)||metric.total<=0||
       metric.done<0||metric.done>metric.total)return;
    const text=metric.done+" / "+metric.total;
    const track=node("progress",null,parent,"collection-progress");
    track.max=metric.total;track.value=metric.done;
    track.setAttribute("aria-label",description+" : "+text);
    node("small",description+" : "+text+" ("+
      Math.round(metric.done*100/metric.total)+" %)",parent,"collection-progress-label");
  }
  function renderFileCatalog(parent,catalog){
    node("h3","Inventaire des fichiers et horaires de collecte",parent);
    if(catalog?.status!=="ok"||!Array.isArray(catalog.rows)){
      node("p","Inventaire indisponible ; aucune collecte n'est supposée réussie.",parent);
      return;
    }
    node("h4","Progression des campagnes enregistrées dans R2",parent);
    const monitors=node("div",null,parent,"collection-grid");
    for(const monitor of catalog.monitors||[]){
      const card=node("article",null,monitors,"collection-alliance");
      node("strong",monitor.title,card);
      node("p",label(monitor.status),card,"collection-monitor-status");
      renderProgress(card,monitor.progress,
        monitor.id==="game"?"URLs vérifiées":
        monitor.id==="player"?"Comptes OAuth traités":"Membres traités");
      node("p","Dernière activité : "+time(monitor.lastAt),card);
      if(monitor.nextAt)node("p","Prochaine passe : "+time(monitor.nextAt),card);
      node("p",monitor.detail,card,"collection-caveat");
    }
    node("p","Les barres représentent des compteurs réels de la campagne, pas "+
      "la totalité des données accessibles sur MSF. Le dénominateur /game "+
      "peut évoluer quand de nouvelles URLs sont découvertes. "+
      "Actualiser la vue après un passage Cron pour lire le nouveau checkpoint.",
      parent,"collection-caveat");
    node("p","« Automatique ? » décrit les collectes programmées en fonctionnement courant. "+
      "Pour /game, l’archive initiale manuelle est historique : le différentiel est automatique tous les 7 jours. "+
      "Chemins entre {accolades} = modèles de fichiers ; horaires UTC.",parent,"collection-caveat");
    const controls=node("div",null,parent,"controls");
    const searchLabel=node("label","Recherche",controls);
    const search=node("input",null,searchLabel);
    search.type="search";search.placeholder="Route, fichier ou contenu…";
    const groupLabel=node("label","Source",controls);
    const group=node("select",null,groupLabel);
    for(const g of ["Toutes",...new Set(catalog.rows.map(x=>x.group))]){
      const option=node("option",g,group);option.value=g;
    }
    const counter=node("p",null,parent,"collection-caveat");
    const scroll=node("div",null,parent,"scroll");
    const table=node("table",null,scroll,"collection-file-table");
    const head=node("tr",null,node("thead",null,table));
    for(const col of ["Famille","Route API / source","Fichier(s) R2","Contenu",
      "Collecte automatique ?","Quand ? (UTC)","État observé",
      "Preuve disponible","Dernière capture"])
      node("th",col,head);
    const body=node("tbody",null,table);
    function redraw(){
      const q=search.value.trim().toLocaleLowerCase("fr-FR");
      const filtered=catalog.rows.filter(r=>
        (group.value==="Toutes"||r.group===group.value)&&
        (!q||[r.group,r.source,r.file,r.contains,r.when,r.evidence,r.note]
          .some(x=>String(x||"").toLocaleLowerCase("fr-FR").includes(q))));
      body.replaceChildren();
      for(const info of filtered){
        const tr=node("tr",null,body);
        node("td",info.group,tr);
        node("td",info.source,tr);
        node("td",info.file,tr);
        const desc=node("td",info.contains,tr);
        if(info.note)node("small",info.note,desc);
        node("td",info.automatic?(info.enabled?"Oui":"Non · désactivé"):
          "Non · manuel",tr);
        node("td",info.when,tr);
        const activity=node("td",null,tr);
        node("strong",label(info.activity?.status),activity);
        if(info.activity?.lastAt)node("small","Dernier signal : "+
          time(info.activity.lastAt),activity);
        if(info.activity?.scope==="global")
          node("small","État global du collecteur, pas de cette route",activity);
        renderProgress(activity,info.activity?.progress,"Couverture R2");
        node("td",info.evidence,tr);
        node("td",time(info.lastAt),tr);
      }
      counter.textContent=filtered.length+" ligne(s) sur "+catalog.rows.length;
      if(!filtered.length)node("tr","Aucun résultat",body);
    }
    search.addEventListener("input",redraw);
    group.addEventListener("change",redraw);
    redraw();
    node("p",catalog.note,parent,"collection-caveat");
  }
  function render(data){
    output.replaceChildren();
    const r=data.rosters||{},sched=data.rosterScheduler||{};
    const alliances=Array.isArray(r.alliances)?r.alliances:[];
    const valid=alliances.filter(x=>x.snapshot==="valid").length;
    const progress=alliances.filter(x=>x.progress==="in-progress").length;
    const player=data.player||{},pers=data.personal||{};
    const f=Array.isArray(pers.families)?pers.families:[];
    const g=data.game||{},o=data.oauth||{};
    const diff=data.gameDifferential||{};
    const cards=node("div",null,output,"collection-grid");
    tile(cards,"Rosters des alliances",
      valid+"/"+count(r.approvedCount)+" manifests",
      "Collecte automatique : "+label(sched.status)+
        " · "+progress+" alliance(s) en progression"+
        " · dernier Cron : "+time(sched.lastTick),
      valid&&valid===r.approvedCount?"ok":"warn");
    const archives=f.reduce((n,x)=>n+(x.archived||0),0);
    const eligible=f.reduce((n,x)=>n+(x.eligible||0),0);
    tile(cards,"Données /player personnelles",
      archives+"/"+(pers.status==="ok"?eligible:"—")+" familles vérifiées",
      "Campagne complémentaire : "+label(player.status)+
        " · comptes OAuth actifs en R2 : "+count(pers.accountsActive),
      eligible&&archives===eligible?"ok":"warn");
    tile(cards,"Archives /game",
      count(g.archivedResponses)+" réponses",
      "Collecte : "+label(g.status)+
        " · "+count(g.cursor)+"/"+count(g.totalTasks)+
        " tâches · "+count(g.gapCount)+" lacune(s). "+
        "Compteur du checkpoint, objets non vérifiés ici. "+
        "Différentiel hebdomadaire : "+label(diff.status)+
        " · changements : "+count(diff.changed)+
        " · inchangés : "+count(diff.unchanged)+
        " · échecs : "+count(diff.failed)+
        " · dernière vérification : "+time(diff.lastCheckedAt)+
        " · dernier changement : "+time(diff.lastChangedAt)+
        " · prochaine passe : "+time(diff.nextRunAt),
      g.status==="complete"?"ok":"neutral");
    tile(cards,"Sessions OAuth",
      count(o.checked)+" contrôlées",
      "Dernier contrôle : "+time(o.checkedAt)+
        " · "+count(o.rotated)+" renouvellement(s) confirmés",
      o.status==="ok"?"ok":"neutral");
    const note=node("p",null,output,"collection-caveat");
    note.textContent="Lecture R2 uniquement (aucun appel Scopely). "+
      "Un manifeste de roster ou le compteur /game ne prouve pas à lui seul "+
      "que tous les fichiers sources sont physiquement présents.";

    renderFileCatalog(output,data.catalog);
    const heading=node("h3","Données /player : preuves d'archivage par famille",output);
    if(pers.status!=="ok"){
      node("p","Inventaire des familles indisponible ; il serait trompeur d'afficher zéro.",output);
    }else{
      const scroll=node("div",null,output,"scroll");
      const table=node("table",null,scroll);
      const tr=node("tr",null,node("thead",null,table));
      for(const col of ["Famille","Archivées","Manquantes","Incomplètes","Sans permission","Origine","Dernière archive"])
        node("th",col,tr);
      const tbody=node("tbody",null,table);
      for(const family of f){
        const row=node("tr",null,tbody);
        const cells=[family.label||family.id,count(family.archived)+"/"+
          count(family.eligible),count(family.missing),count(family.broken),
          count(family.notGranted),
          count(family.automatic)+" auto · "+count(family.manual)+" manuel"+
            (family.provenanceUnknown?" · "+count(family.provenanceUnknown)+" inconnu":""),
          time(family.lastCapture)];
        cells.forEach(v=>node("td",v,row));
      }
      node("p", "Une archive /player n'est comptée que si son manifeste et "+
        "chacune de ses pages sont présents dans R2. Les membres qui ne "+
        "sont pas connectés n'ont pas d'inventaire personnel autorisé.",
        output,"collection-caveat");
    }

    node("h3","Rosters : suivi par alliance approuvée",output);
    if(r.status!=="ok")node("p","Lecture des états des alliances indisponible.",output);
    else if(!alliances.length)node("p","Aucune alliance approuvée trouvée dans R2.",output);
    else{
      const grid=node("div",null,output,"collection-grid");
      for(const a of alliances){
        const article=node("article",null,grid,"collection-alliance");
        allianceTitle(article,a.name);
        node("p","Dernier snapshot : "+label(a.snapshot)+
          " · "+time(a.capturedAt),article);
        node("p","Collecte : "+label(a.progress)+
          " · coéquipiers partageant leur roster : "+
          count(a.completed)+"/"+count(a.eligible)+
          " · roster OAuth : "+(a.personalRosterCollected?
            a.personalFilePresent===true?"fichier présent":
            a.personalFilePresent===false?"fichier introuvable":
            "signalé comme collecté":"non confirmé"),article);
        if(["in-progress","complete","complete-co-members","partial-consent"].includes(a.progress))
          renderProgress(article,{done:a.completed,total:a.eligible},
            "Rosters autorisés traités");
        if(Number.isSafeInteger(a.noShareCount)&&a.noShareCount>0){
          node("p",a.noShareCount+" membre(s) sans partage de roster sur "+
            count(a.observedMembers)+" membres observés. "+
            (a.snapshot==="missing"&&a.progress==="partial-consent"?
              "Le manifeste complet n’est volontairement pas créé : "+
              "ce n’est pas un échec d’écriture R2.":""),
            article,"collection-coverage-warning");
        }else if(a.snapshot==="missing"&&a.progress==="complete"){
          node("p","Anomalie : campagne indiquée complète, mais manifeste absent. "+
            "Vérifier le diagnostic R2 détaillé.",article,"collection-coverage-warning");
        }else if(a.snapshot==="missing"&&a.progress==="partial-consent"){
          node("p","Partages incomplets : manifeste complet non produit. "+
            "Nombre de membres sans partage non confirmé ici.",article,"collection-coverage-warning");
        }else if(a.snapshot==="missing"&&a.progress==="complete-co-members"){
          node("p","Les coéquipiers sont traités, mais le roster personnel "+
            "reste à collecter avant la création du manifeste.",article,
            "collection-coverage-warning");
        }
        node("p","Campagne : "+(a.lastCampaign||"—")+
          " · expire : "+time(a.expiresAt),article);
      }
    }
    node("p","Rosters : la vérification exhaustive des fichiers de chaque "+
      "alliance reste dans l'onglet Rosters. Les équipes partagées "+
      "sont traitées dans la campagne /player, mais ses compteurs "+
      "ne prouvent pas individuellement la présence de tous les fichiers.",
      output,"collection-caveat");
    node("p","Dernière lecture : "+time(data.checkedAt),output,"collection-timestamp");
  }
  async function load(){
    button.disabled=true;
    status.textContent="Vérification des preuves enregistrées dans R2…";
    try{
      const r=await fetch("/admin/api/collection-overview",{
        credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
      });
      const data=await r.json();
      if(!r.ok)throw Error(data.error||"HTTP "+r.status);
      render(data);
      status.textContent="État réel des archives R2 · "+time(data.checkedAt)+
        " · sans nouvelle collecte";
    }catch(error){
      output.replaceChildren();
      status.textContent="Lecture indisponible : "+error.message+
        ". Aucun état n'est présenté comme collecté sans preuve.";
    }finally{button.disabled=false;}
  }
  button.addEventListener("click",load);
  void load();
})();
