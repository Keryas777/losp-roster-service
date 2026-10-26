// Private /player R2 inspector. UI only; all authorization and R2 key
// validation happen server-side. No Scopely requests, browser storage or HTML injection.
(()=>{
"use strict";
const get=id=>document.getElementById(id),endpoint="/admin/api/player-r2-explorer";
const status=get("player-r2-status"),content=get("player-r2-json");
const type=get("player-r2-type"),account=get("player-r2-account"),
 family=get("player-r2-family"),alliance=get("player-r2-alliance"),
 target=get("player-r2-target"),page=get("player-r2-page"),
 rosterMode=get("player-r2-roster-mode"),summary=get("player-r2-summary"),
 diagnostic=get("player-r2-diagnostics"),metadata=get("player-r2-file-meta");
if(!status||!content||!account||!target)return;
let cursor=null,hasMore=false,loaded=false,offset=0,preview=null;
const phrase={
 missing:"Fichier absent de R2",archived:"Archivé et pages présentes",
 "missing-pages":"Pages R2 manquantes",expired:"Archive expirée",
 "invalid-json":"JSON invalide", "too-large":"Fichier trop volumineux",
 "invalid-manifest":"Manifeste incohérent","scope-not-granted":"Permission OAuth absente",
 "oauth-unavailable":"Compte OAuth expiré ou inaccessible",
 "not-started":"Campagne non démarrée",
 running:"Campagne en cours",partial:"Campagne partielle",complete:"Campagne terminée",
 "invalid-source":"Source incohérente","source-inconsistent":"Réponse incompatible avec le manifeste",
 "r2-inspection-unavailable":"Lecture R2 indisponible",
 "storage-unavailable":"R2 indisponible"
};
const human=x=>phrase[x]||x||"Indéterminé";
const when=x=>typeof x==="string"&&Number.isFinite(Date.parse(x))?
 new Date(x).toLocaleString("fr-FR"):"—";
const node=(parent,tag,value,cls)=>{
 const el=document.createElement(tag);
 if(value!==undefined&&value!==null)el.textContent=String(value);
 if(cls)el.className=cls;
 parent.appendChild(el);return el;
};
const option=(select,value,label)=>{
 const o=document.createElement("option");
 o.value=value;o.textContent=label;select.appendChild(o);
};
const enable=(id,on)=>{get(id).disabled=!on;};
const show=(id,on)=>{get(id).hidden=!on;};
function resetPreview(){
 offset=0;preview=null;metadata.textContent="";
 content.textContent="Choisis un fichier pour lire ses données R2.";
 enable("player-r2-next",false);enable("player-r2-prev",false);
}
async function api(params){
 const query=new URLSearchParams(params);
 const response=await fetch(endpoint+"?"+query.toString(),{
   credentials:"same-origin",cache:"no-store",
   headers:{"Accept":"application/json"}
 });
 let data;
 try{data=await response.json();}
 catch{throw Error("Réponse du Worker illisible (HTTP "+response.status+")");}
 if(!response.ok)throw Error(human(data.error)+" (HTTP "+response.status+")");
 return data;
}
function textResult(title,details){
 summary.replaceChildren();
 node(summary,"strong",title);
 for(const line of details)node(summary,"p",line);
}
function renderTraces(traces){
 diagnostic.replaceChildren();
 const events=traces?.events||[];
 if(events.length){
   node(diagnostic,"strong","Dernières erreurs de la famille");
   for(const e of events)
     node(diagnostic,"p",when(e.at)+" — "+human(e.reason)+
       (e.retry!==undefined?" · tentative "+e.retry:""));
 }else node(diagnostic,"p","Aucune erreur détaillée récente enregistrée. "+
   "Les événements précédant l'activation de ce diagnostic ne sont pas reconstitués.");
}
function selectedFamily(){return family.value;}
function selectedAccount(){return account.value;}
function selectedAlliance(){return alliance.value;}
function refreshMode(){
 const isRoster=type.value==="roster";
 show("player-r2-account-wrap",!isRoster);
 show("player-r2-family-wrap",!isRoster);
 show("player-r2-alliance-wrap",isRoster);
 show("player-r2-roster-mode-wrap",isRoster);
 show("player-r2-page-wrap",!isRoster);
 resetPreview();summary.replaceChildren();diagnostic.replaceChildren();
 target.replaceChildren();page.replaceChildren();
 cursor=null;hasMore=false;show("player-r2-more-files",false);
}
async function loadAccounts(){
 status.textContent="Lecture des comptes et des alliances R2…";
 enable("player-r2-load",false);
 try{
   const result=await api({view:"accounts"});
   account.replaceChildren();alliance.replaceChildren();
   for(const [i,a] of result.accounts.entries())
     option(account,a.session,(a.alliance||"Compte OAuth "+(i+1))+
       (a.active?"":" — autorisation expirée")+" · "+a.session.slice(0,9));
   for(const item of result.alliances)
     option(alliance,item.fingerprint,item.name);
   loaded=true;
   status.textContent=result.accounts.length+" compte(s) OAuth enregistrés · "+
     result.alliances.length+" alliance(s) approuvée(s). "+
     "Lecture R2 uniquement. Campagne /player : "+
     human(result.campaign?.status)+".";
   if((type.value==="roster"&&alliance.value)||
      (type.value==="extra"&&account.value))await list();
 }catch(e){status.textContent="Impossible de charger : "+e.message;}
 finally{enable("player-r2-load",true);}
}
function refreshPageOptions(){
 page.replaceChildren();
 const option=target.options[target.selectedIndex];
 const count=Number(option?.dataset?.pages||0);
 for(let i=1;i<=count;i++){
   const item=document.createElement("option");item.value=String(i);
   item.textContent="Page R2 "+i;page.appendChild(item);
 }
}
function entriesOptions(items,append=false){
 if(!append)target.replaceChildren();
 for(const item of items){
   const display=item.target==="self"?"Compte OAuth personnel":
      "Membre partagé "+item.target.slice(0,11);
   option(target,item.target,display+" · "+human(item.status)+
     " · "+when(item.capturedAt));
   target.lastChild.dataset.pages=String(item.pages||0);
 }
}
async function list(cursorValue=null,append=false){
 if(!loaded){status.textContent="Charge d'abord les comptes et alliances R2.";return;}
 if(!append){resetPreview();target.replaceChildren();page.replaceChildren();
   cursor=null;hasMore=false;}
 enable("player-r2-list",false);
 status.textContent="Vérification des fichiers R2…";
 try{
   if(type.value==="extra"){
     if(!selectedAccount())throw Error("Aucun compte OAuth sélectionné.");
     const req={view:"extra",session:selectedAccount(),family:selectedFamily()};
     if(cursorValue)req.cursor=cursorValue;
     const data=await api(req);
     if(data.status==="scope-not-granted"){
       textResult("Permission OAuth absente",["Ce compte n'autorise pas cette famille.",
         "Aucun fichier ne sera ouvert sans autorisation valide."]);
       renderTraces(data.traces);status.textContent=human(data.status);return;
     }
     entriesOptions(data.entries,append);
     const ok=data.entries.filter(x=>x.status==="archived").length;
     const invalid=data.entries.filter(x=>x.status!=="archived").length;
     textResult("Archives de la famille "+selectedFamily(),
       [ok+" fichier(s) vérifiés, "+invalid+" absent(s), expiré(s) ou incomplet(s).",
        "Les identifiants partagés sont masqués par empreinte. Une archive absente"+
        " n'est pas automatiquement un refus Scopely."]);
     renderTraces(data.traces);
     refreshPageOptions();
     cursor=data.nextCursor||null;hasMore=data.more===true;
     show("player-r2-more-files",hasMore);
     status.textContent="Liste lue depuis R2 · "+data.entries.length+" entrée(s) dans ce lot.";
   }else{
     if(!selectedAlliance())throw Error("Aucune alliance approuvée sélectionnée.");
     const data=await api({view:"roster",fingerprint:selectedAlliance()});
     const m=data.coverage?.manifest||{};
     const p=data.coverage?.progress||{};
     const a=data.coverage?.automation||{};
     textResult(data.alliance+" — dernier manifeste roster",
       ["Manifeste : "+human(data.manifestStatus)+
        " · date : "+when(data.lastCompleteAt)+
        " · expiration : "+when(data.expiresAt),
        "Campagne actuelle : "+human(p.status)+
        " · "+(p.completed??"—")+"/"+(p.eligibleCoMembers??"—")+
        " coéquipiers · propriétaire OAuth : "+
        (p.personalRosterCollected===true?"archivé":p.personalRosterCollected===false?
          "non terminé":"inconnu"),
        "Dernier Cron : "+when(a.at)+" · résultat : "+
          human(a.outcome)+" · HTTP : "+(a.httpStatus??"—"),
        "Le dernier manifeste complet peut appartenir à la veille si "+
          "la nouvelle campagne est inachevée."]);
     diagnostic.replaceChildren();
     node(diagnostic,"p","Ceci ne déclenche ni collecte ni renouvellement OAuth. "+
       "Les refus explicites de partage ne sont pas des erreurs réseau.");
     if(rosterMode.value==="roster-file"){
       for(const role of data.roles||[])
         option(target,role,role==="self"?"Roster personnel OAuth":
           "Coéquipier partagé · index "+role);
       status.textContent=(data.roles||[]).length+" fichier(s) de roster proposés.";
     }else await listSources();
   }
 }catch(e){status.textContent="Diagnostic : "+e.message;}
 finally{enable("player-r2-list",true);}
}
async function listSources(c=null,append=false){
 if(!append)target.replaceChildren();
 const params={view:"roster-sources",fingerprint:selectedAlliance()};
 if(c)params.cursor=c;
 const data=await api(params);
 for(const path of data.sources||[])option(target,path,path);
 cursor=data.nextCursor||null;hasMore=data.more===true;
 show("player-r2-more-files",hasMore);
 status.textContent=(data.sources||[]).length+" réponses Scopely dans ce lot R2. "+
   "Certaines peuvent être des reçus HTTP 344, sans corps JSON.";
}
async function openFile(newOffset=0){
 if(!loaded||!target.value){status.textContent="Sélectionne d'abord un fichier.";return;}
 enable("player-r2-open",false);enable("player-r2-next",false);enable("player-r2-prev",false);
 status.textContent="Lecture du contenu du fichier R2…";
 try{
   let params;
   if(type.value==="extra"){
     params={view:"extra-file",session:selectedAccount(),family:selectedFamily(),
       target:target.value,page:page.value||"1",offset:String(newOffset)};
   }else if(rosterMode.value==="roster-file"){
     params={view:"roster-file",fingerprint:selectedAlliance(),
       member:target.value,offset:String(newOffset)};
   }else{
     params={view:"roster-source",fingerprint:selectedAlliance(),
       source:target.value,offset:String(newOffset)};
   }
   const data=await api(params);
   preview=data;offset=newOffset;
   metadata.textContent="R2 · "+(data.file?.kind||"fichier")+
     " · "+(data.file?.bytes??"—")+" octets · "+
     (data.file?.endpoint?"route "+data.file.endpoint+" · ":"")+
     "capturé le "+when(data.file?.capturedAt)+
     " · expiration "+when(data.file?.expiresAt)+
     (data.entries!==null?" · entrées affichées "+(offset+1)+"–"+
       (offset+(data.shown||0))+" sur "+data.entries:"");
   content.textContent=JSON.stringify(data.document,null,2);
   enable("player-r2-prev",offset>0);
   enable("player-r2-next",data.hasMore===true);
   status.textContent="Fichier existant lu et validé dans R2. "+
     (data.entries!==null?"Aperçu paginé : aucun contenu inventé.":"JSON affiché.");
 }catch(e){content.textContent="";metadata.textContent="";
   status.textContent="Lecture impossible : "+e.message;}
 finally{enable("player-r2-open",true);}
}
get("player-r2-load").addEventListener("click",loadAccounts);
get("player-r2-list").addEventListener("click",()=>list());
get("player-r2-open").addEventListener("click",()=>openFile());
get("player-r2-next").addEventListener("click",()=>openFile(offset+20));
get("player-r2-prev").addEventListener("click",()=>openFile(Math.max(0,offset-20)));
get("player-r2-more-files").addEventListener("click",async()=>{
 if(!cursor)return;
 try{
   if(type.value==="extra")await list(cursor,true);
   else await listSources(cursor,true);
 }catch(e){status.textContent="Liste suivante indisponible : "+e.message;}
});
type.addEventListener("change",refreshMode);
rosterMode.addEventListener("change",()=>list());
account.addEventListener("change",()=>list());
family.addEventListener("change",()=>list());
alliance.addEventListener("change",()=>list());
target.addEventListener("change",()=>{resetPreview();
 if(type.value==="extra"){
   const opt=target.options[target.selectedIndex];
   const text=opt?.textContent||"";
   // Pages are loaded only from the selected verified manifest on read.
   refreshPageOptions();
   if(!text.includes("Archivé"))status.textContent="Cette entrée n'est pas forcément lisible.";
 }
});
page.addEventListener("change",resetPreview);
refreshMode();
})();