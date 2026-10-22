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
    unavailable:"État indisponible"
  })[v]||v||"Inconnu";
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
        node("strong",a.name,article);
        node("p","Dernier snapshot : "+label(a.snapshot)+
          " · "+time(a.capturedAt),article);
        node("p","Membres traités : "+count(a.completed)+"/"+
          count(a.eligible)+" · roster OAuth : "+
          (a.personalRosterCollected?"signalé comme collecté":"non confirmé"),article);
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
