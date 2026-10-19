// No private data is rendered. Only aggregate state and outcome are shown.
const gameArchiveStatus=document.getElementById("game-archive-status");
const gameArchiveStart=document.getElementById("game-archive-start");
const gameArchiveTick=document.getElementById("game-archive-tick");
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
  void status().catch(()=>{
    gameArchiveStatus.textContent="Impossible de lire le statut de l’archive privée.";
  });
}
