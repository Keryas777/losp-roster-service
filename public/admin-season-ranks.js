// Administrator-only preservation of observed alliance ranks before rollover.
// All server-provided values are rendered as text; no tokens or player data.
(()=>{
 const capture=document.getElementById("season-ranks-capture"),
   refresh=document.getElementById("season-ranks-refresh"),
   copy=document.getElementById("season-ranks-copy"),
   status=document.getElementById("season-ranks-status"),
   table=document.getElementById("season-ranks-table");
 if(!capture||!refresh||!copy||!status||!table)return;
 const url="/admin/api/alliance-season-ranks";
 let current=null,busy=false;
 const cell=(tag,text)=>{
   const item=document.createElement(tag);item.textContent=String(text??"—");return item;
 };
 const displayName=s=>String(s||"").replace(/<#[0-9a-f]{6}>/gi,"")
   .replace(/\s+/g," ").trim();
 function render(data){
   current=data.snapshot||null;
   copy.disabled=!current;
   table.replaceChildren();
   if(!current){
     status.textContent="Aucune capture enregistrée. Utilise le bouton de capture avant la fin de saison.";
     return;
   }
   const s=current,when=new Date(s.capturedAt);
   status.textContent=(data.status==="partial-capture"?"Capture partielle. ":
     "Capture disponible. ")+s.connectedAlliances+" alliance(s) connectée(s), "+
     s.unavailableSessions+" session(s) indisponible(s). Relevé : "+
     (Number.isNaN(when.getTime())?s.capturedAt:when.toLocaleString("fr-FR"))+
     ". Aucun ID de saison retourné par Scopely. Conservation R2 : 7 jours.";
   const grid=document.createElement("table"),header=document.createElement("tr");
   for(const v of ["Alliance","Guerre","Raid","Trophées guerre","Ligue"])
     header.append(cell("th",v));
   grid.append(header);
   for(const a of s.alliances||[]){
     const row=document.createElement("tr");
     const league=a.warLeague?.name||a.warLeague?.id||"—";
     for(const v of [displayName(a.name),a.warRank,a.raidRank,
       a.warTrophies,league])row.append(cell("td",v));
     grid.append(row);
   }
   table.append(grid);
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
   }finally{busy=false;capture.disabled=false;refresh.disabled=false;}
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
