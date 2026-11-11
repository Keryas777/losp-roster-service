// No private data is rendered. Only aggregate state and outcome are shown.
const gameArchiveStatus=document.getElementById("game-archive-status");
const gameArchiveStart=document.getElementById("game-archive-start");
const gameArchiveTick=document.getElementById("game-archive-tick");
const gameArchiveRefresh=document.getElementById("game-archive-refresh");
const gameArchiveMessage=document.getElementById("game-archive-action-status");
if(gameArchiveStatus&&gameArchiveStart&&gameArchiveTick&&gameArchiveMessage){
  let busy=false;
  const render=report=>{
    gameArchiveStatus.textContent="État : "+report.status+
      ". Réponses archivées : "+(report.archivedResponses??0)+
      ". Tâches traitées : "+(report.cursor??report.completedTasks??0)+
      "/"+(report.totalTasks??0)+
      ". Appels officiels aujourd’hui : "+(report.requestsToday??0)+
      "/"+(report.dailyLimit??9000)+
      (report.currentResource?". Ressource : "+report.currentResource:"")+
      (report.gapCount!==undefined?". Lacunes : "+report.gapCount:"")+
      ". Dernier résultat : "+(report.lastOutcome||"aucun")+
      (report.pauseUntil?". Prochaine reprise : "+report.pauseUntil:"")+".";
  };
  const status=async()=>{
    const r=await fetch("/admin/api/game-archive",{credentials:"same-origin",cache:"no-store"});
    if(!r.ok)throw Error("HTTP "+r.status);
    render(await r.json());
  };
  const act=async action=>{
    if(busy)return;
    busy=true;gameArchiveStart.disabled=true;gameArchiveTick.disabled=true;
    gameArchiveMessage.textContent="Traitement : "+action+"…";
    try{
      const r=await fetch("/admin/api/game-archive",{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({action})
      });
      if(!r.ok)throw Error("HTTP "+r.status);
      const result=await r.json();
      gameArchiveMessage.textContent="Résultat : "+result.status+
        ". "+(result.lastOutcome||"")+
        (result.processed!==undefined?" Appels GET : "+result.processed+".":"");
      await status();
    }catch(error){
      gameArchiveMessage.textContent="Erreur : "+(error instanceof Error?error.message:"unavailable");
    }finally{busy=false;gameArchiveStart.disabled=false;gameArchiveTick.disabled=false;}
  };
  gameArchiveStart.addEventListener("click",()=>act("start"));
  gameArchiveTick.addEventListener("click",()=>act("tick"));
  if(gameArchiveRefresh)gameArchiveRefresh.addEventListener("click",()=>void status().catch(()=>{
    gameArchiveStatus.textContent="Impossible de lire le statut de l’archive privée.";
  }));
}

// Explicit, authenticated DD9-only enqueue. Scopely requests are performed by the existing Cron.
const dd9TargetedStart=document.getElementById("game-dd9-targeted-start");
const dd9TargetedStatus=document.getElementById("game-dd9-targeted-status");
if(dd9TargetedStart&&dd9TargetedStatus){
  dd9TargetedStart.addEventListener("click",async()=>{
    if(dd9TargetedStart.disabled||!window.confirm("Ajouter les salles DD9 manquantes à la file de collecte existante ?"))return;
    dd9TargetedStart.disabled=true;
    dd9TargetedStatus.textContent="Préparation des salles DD9…";
    try{
      const response=await fetch("/admin/api/game-differential-dd9",{
        method:"POST",credentials:"same-origin",cache:"no-store"
      });
      const result=await response.json();
      if(!response.ok)throw Error(result.error||"HTTP "+response.status);
      const summary="Positions : "+(result.discovered??"?")+
        ", déjà archivées : "+(result.archived??"?")+
        ", déjà en attente : "+(result.pending??"?")+
        ", ajoutées à la file : "+(result.queued??0)+".";
      if(result.status==="queued"||result.status==="already-queued"){
        dd9TargetedStatus.textContent="Collecte DD9 en file ("+result.status+"). "+summary+
          " Les appels Scopely seront effectués par le Cron existant.";
      }else if(result.status==="nothing-to-queue"||result.status==="already-seen"){
        dd9TargetedStatus.textContent="Aucune nouvelle salle à ajouter ("+result.status+"). "+summary;
      }else{
        dd9TargetedStatus.textContent="Collecte non lancée : "+result.status+
          (result.campaignStatus?" ("+result.campaignStatus+")":"")+
          ". Aucun appel Scopely déclenché par ce bouton.";
      }
    }catch(error){
      dd9TargetedStatus.textContent="Impossible de préparer la collecte DD9 : "+
        (error instanceof Error?error.message:"erreur inconnue");
    }finally{dd9TargetedStart.disabled=false;}
  });
}
