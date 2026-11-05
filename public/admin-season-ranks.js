// Administrator-only preservation of observed alliance ranks before rollover.
// All server-provided values are rendered as text; no tokens or player data.
(()=>{
 const capture=document.getElementById("season-ranks-capture"),
   refresh=document.getElementById("season-ranks-refresh"),
   copy=document.getElementById("season-ranks-copy"),
   status=document.getElementById("season-ranks-status"),
   table=document.getElementById("season-ranks-table"),
   backfillAlliance=document.getElementById("guest-rank-backfill-alliance"),
   backfillStart=document.getElementById("guest-rank-backfill-start"),
   backfillEnd=document.getElementById("guest-rank-backfill-end"),
   backfillConfirm=document.getElementById("guest-rank-backfill-confirm"),
   backfillButton=document.getElementById("guest-rank-backfill-publish"),
   backfillStatus=document.getElementById("guest-rank-backfill-status");
 if(!capture||!refresh||!copy||!status||!table)return;
 const url="/admin/api/alliance-season-ranks";
 let current=null,busy=false;
 const updateBackfill=()=>{
   if(!backfillButton||!backfillAlliance)return;
   const captured=current?.guests?.capturedAt;
   const fresh=Number.isFinite(Date.parse(captured))&&
     Date.now()-Date.parse(captured)>=0&&
     Date.now()-Date.parse(captured)<=24*3600000;
   const start=Date.parse((backfillStart?.value||"")+"T00:00:00Z"),
     end=Date.parse((backfillEnd?.value||"")+"T00:00:00Z");
   const length=(end-start)/86400000;
   const confirmedSeason=Number.isFinite(length)&&length>=7&&length<=60&&
     Number.isFinite(Date.parse(captured))&&
     Date.parse(captured)>=end+86400000&&
     Date.parse(captured)<end+(end-start);
   backfillButton.disabled=busy||!fresh||!confirmedSeason||
     !backfillAlliance.value||!backfillConfirm?.checked;
 };
 function fillGuestChoices(){
   if(!backfillAlliance)return;
   const previous=backfillAlliance.value;
   backfillAlliance.replaceChildren();
   const empty=document.createElement("option");
   empty.value="";empty.textContent="Choisir une alliance";backfillAlliance.append(empty);
   const records=current?.guests?.alliances||[];
   for(const a of records){
     if(typeof a.allianceFingerprint!=="string"||
       !Number.isSafeInteger(a.warRank)||!Number.isSafeInteger(a.raidRank))continue;
     const option=document.createElement("option");
     option.value=a.allianceFingerprint;
     option.textContent=displayName(a.name)+" — guerre "+a.warRank+
       ", raid "+a.raidRank+" — "+a.allianceFingerprint.slice(-6);
     backfillAlliance.append(option);
   }
   backfillAlliance.value=records.some(a=>a.allianceFingerprint===previous)?
     previous:records.length===1?records[0].allianceFingerprint:"";
   if(backfillConfirm)backfillConfirm.checked=false;
   updateBackfill();
 }
 const cell=(tag,text)=>{
   const item=document.createElement(tag);item.textContent=String(text??"—");return item;
 };
 const displayName=s=>String(s||"")
   .replace(/<#[0-9a-f]{6}>/gi,"")
   .replace(/<\/?color(?:=[^<>]{1,32})?>/gi,"")
   .replace(/\s+/g," ").trim();
 function render(data){
   current={losp:data.snapshot||null,guests:data.guestSnapshot||null};
   copy.disabled=!current.losp&&!current.guests;
   fillGuestChoices();
   table.replaceChildren();
   if(!current.losp&&!current.guests){
     status.textContent="Aucune capture pour les alliances actuellement autorisées.";
     return;
   }
   function renderScope(label,s){
     table.append(cell("h3",label));
     if(!s){table.append(cell("p","Aucune capture disponible."));return;}
     const when=new Date(s.capturedAt);
     table.append(cell("p",(s.connectedAlliances||0)+" alliance(s) · relevé "+(
       Number.isNaN(when.getTime())?s.capturedAt:when.toLocaleString("fr-FR"))+
       (s.completeSessionScan===false?" · capture partielle":"")));
     const grid=document.createElement("table"),header=document.createElement("tr");
     for(const v of ["Alliance","Guerre","Raid","Trophées guerre","Ligue"])
       header.append(cell("th",v));
     grid.append(header);
     for(const a of s.alliances||[]){
       const row=document.createElement("tr"),league=a.warLeague?.name||
         a.warLeague?.id||"—";
       for(const v of [displayName(a.name),a.warRank,a.raidRank,
         a.warTrophies,league])row.append(cell("td",v));
       grid.append(row);
     }
     table.append(grid);
   }
   status.textContent="Captures R2 privées · aucune donnée d'une invitée révoquée. "+
     "Aucun ID de saison fourni par Scopely · conservation 7 jours.";
   renderScope("Alliances LoSP",current.losp);
   renderScope("Alliances invitées autorisées",current.guests);
   const note=cell("p","Important : warTrophies ≠ points de saison guerre. "+
     "Les points de saison raid ne sont pas exposés ici. "+
     "Vérifie la saison affichée dans le jeu avant de qualifier cette capture.");
   note.className="muted";table.append(note);
 }
 async function call(write){
   if(busy)return;
   busy=true;capture.disabled=true;refresh.disabled=true;
   status.textContent=write?"Capture officielle des alliances autorisées…":
     "Lecture de la dernière capture R2…";
   try{
     const response=await fetch(url,{
       method:write?"POST":"GET",credentials:"same-origin",cache:"no-store",
       ...(write?{headers:{"Content-Type":"application/json"},
         body:JSON.stringify({action:"capture"})}:{})
     });
     const result=await response.json();
     if(!response.ok)throw Error(result.error||"HTTP "+response.status);
     render(result);
   }catch(error){
     status.textContent="Capture indisponible : "+
       (error instanceof Error?error.message:"erreur");
   }finally{busy=false;capture.disabled=false;refresh.disabled=false;updateBackfill();}
 }
 for(const input of [backfillAlliance,backfillStart,backfillEnd,backfillConfirm])
   input?.addEventListener("change",updateBackfill);
 if(backfillButton){
   backfillButton.addEventListener("click",async()=>{
     if(busy||backfillButton.disabled)return;
     const selected=current?.guests?.alliances?.find(a=>
       a.allianceFingerprint===backfillAlliance.value);
     if(!selected||!backfillConfirm.checked)return;
     busy=true;backfillButton.disabled=true;
     capture.disabled=true;refresh.disabled=true;
     backfillStatus.textContent="Validation du relevé existant dans R2…";
     try{
       const response=await fetch("/admin/api/guest-season-rank-backfill",{
         method:"POST",credentials:"same-origin",cache:"no-store",
         headers:{"Content-Type":"application/json",Accept:"application/json"},
         body:JSON.stringify({
           allianceFingerprint:selected.allianceFingerprint,
           sourceCapturedAt:current.guests.capturedAt,
           seasonId:backfillStart.value+"/"+backfillEnd.value,
           confirmation:"verified-in-game"
         })
       });
       const result=await response.json();
       if(!response.ok)throw Error(result.error||"HTTP "+response.status);
       backfillStatus.textContent=(result.status==="recorded"?
         "Rattrapage enregistré : ":"Relevé déjà enregistré : ")+
         "saison "+result.seasonId.replace("/"," au ")+
         " — Guerre "+result.warRank+", Raid "+result.raidRank+
         ". La projection publique reste soumise aux autorisations.";
       backfillConfirm.checked=false;
     }catch(error){
       backfillStatus.textContent="Rattrapage impossible : "+
         (error instanceof Error?error.message:"erreur");
     }finally{
       busy=false;capture.disabled=false;refresh.disabled=false;
       updateBackfill();
     }
   });
 }
 capture.addEventListener("click",()=>void call(true));
 refresh.addEventListener("click",()=>void call(false));
 copy.addEventListener("click",async()=>{
   if(!current)return;
   const data=JSON.stringify(current,null,2);
   try{
     await navigator.clipboard.writeText(data);
     status.textContent="Capture copiée. Colle-la dans ChatGPT pour vérification.";
   }catch{
     const pre=cell("pre",data);
     pre.setAttribute("aria-label","Capture JSON à copier manuellement");
     table.prepend(pre);
     status.textContent="Copie automatique indisponible : sélectionne le JSON affiché.";
   }
 });
 status.textContent="Dernière capture R2 non chargée. Clique sur « Voir la dernière capture ».";
})();
