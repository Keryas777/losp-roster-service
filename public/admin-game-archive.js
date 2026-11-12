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

// Persistent R2-backed DD9 status, including after a page reload.
if(dd9TargetedStart&&dd9TargetedStatus){
  const refreshDd9=async()=>{
    try{
      const response=await fetch("/admin/api/game-differential-dd9",{
        credentials:"same-origin",cache:"no-store"
      });
      if(!response.ok)throw Error("HTTP "+response.status);
      const state=await response.json();
      if(state.status==="not-started")return;
      if(state.status==="finished"){
        dd9TargetedStatus.textContent="Dernière collecte DD9 terminée : "+
          (state.processed??0)+"/"+(state.total??0)+" traitées, "+
          (state.archived??0)+" archivées, "+(state.failed??0)+
          " sans archive. État conservé dans R2.";
      }else if(state.status==="previous-campaign"){
        dd9TargetedStatus.textContent="Dernière collecte DD9 : campagne antérieure. Vérifier les archives R2.";
      }else{
        dd9TargetedStatus.textContent="Collecte DD9 ("+state.status+") : "+
          (state.processed??0)+"/"+(state.total??state.queued??0)+
          " traitées, "+(state.archived??0)+" archivées.";
      }
    }catch(error){
      dd9TargetedStatus.textContent="Statut DD9 indisponible : "+
        (error instanceof Error?error.message:"erreur inconnue");
    }
  };
  void refreshDd9();
  const original=dd9TargetedStart.onclick;
  dd9TargetedStart.addEventListener("click",()=>{
    // Read back the persisted result after the enqueue request settles.
    setTimeout(()=>void refreshDd9(),2000);
  });
  if(gameArchiveRefresh)gameArchiveRefresh.addEventListener("click",()=>void refreshDd9());
}

// Deliberate one-call diagnostic; status is restored after reload.
const dd9ProbeButton=document.getElementById("game-dd9-a1-probe");
const dd9ProbeStatus=document.getElementById("game-dd9-a1-probe-status");
if(dd9ProbeButton&&dd9ProbeStatus){
  const renderProbe=data=>{
    dd9ProbeStatus.textContent=data.status==="tested"?
      "Test A1 : HTTP "+data.httpStatus+(data.ok?" (réponse valide)":" (rejet API)")+
      ". Champs data : "+(data.dataKeys?.join(", ")||"aucun")+
      ". Vérifié : "+data.checkedAt:
      data.status==="not-tested"?"Aucun test A1 effectué.":
      "Diagnostic A1 : "+data.status+(data.result?.httpStatus?" (HTTP "+data.result.httpStatus+")":"");
  };
  fetch("/admin/api/game-dd9-a1-probe",{credentials:"same-origin",cache:"no-store"})
    .then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json();})
    .then(renderProbe).catch(()=>{dd9ProbeStatus.textContent="Statut du diagnostic indisponible.";});
  dd9ProbeButton.addEventListener("click",async()=>{
    if(dd9ProbeButton.disabled||!window.confirm("Effectuer un seul appel Scopely pour A1, sans expansions ?"))return;
    dd9ProbeButton.disabled=true;dd9ProbeStatus.textContent="Test A1 en cours…";
    try{
      const r=await fetch("/admin/api/game-dd9-a1-probe",{
        method:"POST",credentials:"same-origin",cache:"no-store"
      });
      if(!r.ok)throw Error("HTTP "+r.status);
      renderProbe(await r.json());
    }catch(error){dd9ProbeStatus.textContent="Erreur : "+(error instanceof Error?error.message:"inconnue");}
    finally{dd9ProbeButton.disabled=false;}
  });
}
