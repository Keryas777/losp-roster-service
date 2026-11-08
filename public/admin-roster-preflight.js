// Admin-only roster synchronization preflight. No roster reads or publication.
// Alliance approval is an explicit action independent of OAuth consent.
const rosterEl=id=>document.getElementById(id);
let rosterSnapshot=null;
const WEBAPP_ALLIANCES_URL="https://raw.githubusercontent.com/Keryas777/msf/main/docs/data/alliances.json";
let webappAlliancesPromise=null;
function fetchWebappAlliances(){
  if(!webappAlliancesPromise)webappAlliancesPromise=fetch(WEBAPP_ALLIANCES_URL,{
    mode:"cors",cache:"no-store",credentials:"omit"
  }).then(r=>{if(!r.ok)throw Error("webapp-registry-unavailable");return r.json();})
    .then(rows=>Array.isArray(rows)?rows.filter(a=>
      a&&a.group&&a.group!=="losp"&&
      /^[a-z][a-z0-9-]{1,63}$/.test(a.key||"")):[])
    .catch(()=>[]);
  return webappAlliancesPromise;
}
function normalizedAllianceName(value){
  return String(value||"").replace(/<[^>]*>/g,"")
    .replace(/[ΔΛΑ]/g,"A").replace(/Π/g,"N").replace(/Σ/g,"E")
    .replace(/Я/g,"R").replace(/Ƨ/g,"S")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]/g,"");
}
function scopelyNameColor(value){
  const tags=String(value||"").matchAll(/<(?:color=)?(#[0-9a-f]{3,6}|red|orange)>/gi);
  for(const tag of tags){
    let code=tag[1].toLowerCase();
    if(code==="red")code="#ff0000";
    if(code==="orange")code="#ffa500";
    if(code.length===4)code="#"+[...code.slice(1)].map(c=>c+c).join("");
    if(!/^#[0-9a-f]{6}$/.test(code))continue;
    return [1,3,5].map(n=>parseInt(code.slice(n,n+2),16));
  }
  return null;
}
function suggestWebappKey(alliance,rows){
  const name=normalizedAllianceName(alliance?.name);
  if(!name)return "";
  const matches=rows.filter(a=>
    [a.name,a.displayName,...(Array.isArray(a.aliases)?a.aliases:[])]
      .some(label=>normalizedAllianceName(label)===name));
  if(matches.length===1)return matches[0].key;
  if(matches.length<2)return "";
  // Never guess between tenants sharing a name without Scopely colour evidence.
  const color=scopelyNameColor(alliance.name);
  if(!color)return "";
  const scored=matches.map(a=>{
    const code=String(a.color||"");
    if(!/^#[0-9a-f]{6}$/i.test(code))return null;
    const rgb=[1,3,5].map(n=>parseInt(code.slice(n,n+2),16));
    return {key:a.key,dist:rgb.reduce((sum,v,i)=>sum+(v-color[i])**2,0)};
  });
  if(scored.some(x=>!x))return "";
  scored.sort((a,b)=>a.dist-b.dist);
  const [best,second]=scored;
  return best.dist<=28000&&second.dist-best.dist>=1300&&
    second.dist>=1.3*best.dist?best.key:"";
}

function rosterClear(){
  rosterSnapshot=null;
  rosterEl("roster-preflight-list").replaceChildren();
  rosterEl("roster-approve").disabled=true;
}
function rosterLine(parent,text,tag="p"){
  const node=document.createElement(tag);
  node.textContent=text;
  parent.appendChild(node);
  return node;
}
// Deliberately on-demand and bounded to one co-member; results stay in R2.
async function runPrivateRosterPilot(alliance,button,status){
  button.disabled=true;
  status.textContent="Lecture complète du premier roster partagé de "+
    alliance.name+" en cours…";
  try{
    const response=await fetch("/admin/api/roster-pilot",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprint:alliance.fingerprint})
    });
    const result=await response.json();
    if(!response.ok||result.status!=="stored")
      throw Error(typeof result.status==="string"?result.status:"unknown-error");
    status.textContent="Pilote enregistré dans R2 privé : "+
      result.player+" — "+result.characters+" personnages, "+
      result.pages+" page(s), "+result.requests+
      " appels. Expire le "+new Date(result.expiresAt).toLocaleDateString("fr-FR")+
      ". Aucune transmission à la WebApp.";
  }catch(e){
    status.textContent="Pilote non enregistré : "+(e.message||"indisponible")+
      ". Aucune donnée partielle n'a été sauvegardée.";
  }finally{button.disabled=false;}
}
async function rosterBatchStatus(alliance,status){
  try{
    const response=await fetch("/admin/api/roster-batch-status?fingerprint="+
      encodeURIComponent(alliance.fingerprint),{credentials:"same-origin",cache:"no-store"});
    const state=await response.json();
    if(!response.ok)throw Error("status");
    if(state.status==="not-started")status.textContent="Aucun micro-lot enregistré.";
    else status.textContent="Progression des coéquipiers partagés : "+
      state.completed+"/"+state.eligibleCoMembers+" ; état : "+state.status+
      (state.expiresAt?" ; expiration "+new Date(state.expiresAt).toLocaleDateString("fr-FR"):"");
    return state;
  }catch{
    status.textContent="État de progression indisponible.";
    return null;
  }
}
async function rosterBatchStart(alliance,button,status,restart=false,refresh=false){
  button.disabled=true;
  status.textContent="Collecte de deux coéquipiers maximum en cours…";
  try{
    const response=await fetch("/admin/api/roster-batch",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprint:alliance.fingerprint,
        ...(restart?{restart:true}:{}),...(refresh?{refresh:true}:{})})
    });
    const result=await response.json();
    if(!response.ok){
      if(["membership-changed-restart-required","expired-restart-required"].includes(result.status)){
        status.textContent="Effectif modifié ou collecte expirée : redémarrage nécessaire.";
        const reset=document.createElement("button");
        reset.type="button";
        reset.textContent="Recommencer cette alliance depuis zéro";
        reset.addEventListener("click",async()=>{
          reset.disabled=true;
          await rosterBatchStart(alliance,button,status,true);
          reset.remove();
        },{once:true});
        status.parentNode.appendChild(reset);
        return;
      }
      throw Error(result.status||"batch-error");
    }
    const state=await rosterBatchStatus(alliance,status);
    const refreshButton=status.parentNode.querySelector(".roster-refresh");
    if(refreshButton)refreshButton.disabled=state?.status!=="complete-co-members";
    if(result.savedThisBatch)
      status.textContent+=" — dernier lot : "+result.savedThisBatch+
        " roster(s), "+result.charactersThisBatch+" personnages, "+
        result.pagesThisBatch+" page(s), "+result.requestsThisBatch+
        " appels Scopely (dont "+result.unchangedThisBatch+
        " roster(s) inchangé(s)) ; aucune transmission à la WebApp.";
  }catch(e){
    status.textContent="Lot non validé : "+(e.message||"indisponible")+
      ". Progression précédente conservée.";
  }finally{button.disabled=false;}
}
async function runOneAutoRosterTest(){
  const button=rosterEl("roster-auto-test"),status=rosterEl("roster-auto-test-status");
  if(!button||!status)return;
  button.disabled=true;
  status.textContent="Exécution d’un seul micro-lot, via le planificateur réel…";
  try{
    const response=await fetch("/admin/api/roster-auto-test",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:"{}"
    });
    const result=await response.json();
    if(!response.ok)throw Error(result.status||"http-error");
    const code=typeof result.status==="string"?result.status:"unavailable";
    const alliance=typeof result.alliance==="string"?result.alliance:"une alliance approuvée";
    status.textContent="Alliance : "+alliance+". Résultat : "+code+
      ". Requêtes Scopely : "+(result.requestsThisTick??0)+
      ". Total aujourd’hui : "+(result.requestsToday??0)+
      ". Maximum 1 test par créneau d’une minute. R2 privé uniquement.";
  }catch(error){
    status.textContent="Test non exécuté ou interrompu : "+
      (error instanceof Error?error.message:"unavailable")+
      ". Vérifier l’état dans le bilan privé et les logs Cloudflare.";
  }finally{
    button.disabled=false;
    void showRosterAutoStatus();
  }
}
async function showRosterAutoStatus(){
  const target=rosterEl("roster-auto-status");
  if(!target)return;
  try{
    const response=await fetch("/admin/api/roster-auto-status",{
      credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}
    });
    if(!response.ok)throw Error("unavailable");
    const state=await response.json();
    if(!state.enabled){
      target.textContent="Collecte automatique désactivée ; R2 privé uniquement. "+
        "La règle de suppression après 7 jours doit être confirmée avant activation.";
      return;
    }
    if(!state.retentionConfirmed){
      target.textContent="Automatisation en attente : rétention R2 non confirmée.";
      return;
    }
    target.textContent="Automatisation active : 2 campagnes quotidiennes, "+
      "un micro-lot par passage. Appels API aujourd’hui : "+
      state.requestsToday+
      ". Dernier état : "+(state.lastOutcome||"aucun")+".";
  }catch{target.textContent="État de l’automatisation indisponible.";}
}
// Read-only directory; first visit backfills older consenting accounts.
// The list never approves a new alliance or starts a roster collection.
async function loadConnectedAlliances(bindingFeedback=null){
  // MSF names may contain <color=red>, <color=#f60> or <#RRGGBB>.
  // Render only text in spans; never interpret provider markup as HTML.
  const allianceLabel=(node,prefix,name,suffix="")=>{
    node.textContent=prefix;
    const source=typeof name==="string"?name:"";
    const markers=/<(?:color=(#[\da-f]{6}|#[\da-f]{3}|red|orange|white)|#([\da-f]{6}|[\da-f]{3})|\/color)>/gi;
    let cursor=0,color="";
    const appendPart=part=>{
      if(!part)return;
      const span=document.createElement("span");
      span.textContent=part;
      if(color)span.style.color=color;
      // END is deliberately white; GAME and the rest use the MSF tag.
      else if(part==="END"&&/^END<color=/i.test(source))
        span.style.color="#fff";
      node.appendChild(span);
    };
    for(const marker of source.matchAll(markers)){
      appendPart(source.slice(cursor,marker.index));
      color=marker[0].toLowerCase()==="</color>"?"":marker[1]||"#"+marker[2];
      cursor=marker.index+marker[0].length;
    }
    appendPart(source.slice(cursor));
    if(suffix){
      const trailing=document.createElement("span");
      trailing.textContent=suffix;
      node.appendChild(trailing);
    }
  };
  const status=rosterEl("roster-connected-status");
  const parent=rosterEl("roster-connected-list");
  const button=rosterEl("roster-connected-refresh");
  if(!status||!parent)return;
  status.textContent="Lecture des alliances connectées…";
  parent.replaceChildren();
  if(button)button.disabled=true;
  try{
    const res=await fetch("/admin/api/connected-alliances",{
      credentials:"same-origin",cache:"no-store",
      headers:{Accept:"application/json"}
    });
    const result=await res.json();
    if(!res.ok||result.status!=="ok"||!Array.isArray(result.alliances))
      throw Error("unavailable");
    // The admin directory remains usable even if registry discovery fails.
    const registered=typeof fetchWebappAlliances==="function"?
      await fetchWebappAlliances():[];
    if(!result.alliances.length)rosterLine(parent,
      "Aucune alliance identifiable parmi les sessions OAuth actives.");
    for(const alliance of result.alliances){
      const suggestedKey=typeof suggestWebappKey==="function"?
        suggestWebappKey(alliance,registered):"";
      const summary=rosterLine(parent,"");
      allianceLabel(summary,"",alliance.name," — "+
        alliance.captainConnections+" connexion(s) OAuth — "+
        (alliance.approved?"collecte LoSP approuvée":
          alliance.guestApproved?"collecte invitée approuvée":
          "roster personnel uniquement"));
      // Future guest enrollment: one admin dispatch produces a reviewable
      // WebApp PR containing both JSON registries. Never approves collection.
      const unstyled=String(alliance.name||"").replace(/<[^>]*>/g,"").trim();
      // Two separate approved Scopely alliances can share the SAME name.
      // A display-name match must never suppress guest onboarding.
      if(!alliance.approved&&!suggestedKey&&!alliance.guestAllianceKey){
        const section=document.createElement("div");
        const heading=document.createElement("p");
        heading.textContent="Nouvelle alliance détectée : préparer son accès WebApp";
        const makeField=(label,value,placeholder)=>{
          const wrapper=document.createElement("label");
          wrapper.textContent=label+" : ";
          const input=document.createElement("input");
          input.type="text";input.autocomplete="off";input.spellcheck=false;
          input.value=value;input.placeholder=placeholder;
          wrapper.appendChild(input);section.appendChild(wrapper);
          return input;
        };
        const shortName=unstyled.replace(/^ +| +$/g,"");
        const slug=shortName.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
          .toLowerCase().replace(/[^a-z0-9]+/g,"-")
          .replace(/^-+|-+$/g,"").slice(0,64);
        section.appendChild(heading);
        const newName=makeField("Nom officiel",shortName,"Nom de l'alliance");
        const newKey=makeField("Clé technique",slug,"ex. another-us-team");
        const newRole=makeField("ID du rôle Discord","","16 à 22 chiffres");
        newRole.inputMode="numeric";newRole.maxLength=22;
        const colorLabel=document.createElement("label");
        colorLabel.textContent="Couleur : ";
        const newColor=document.createElement("input");
        newColor.type="color";newColor.value="#ffffff";
        colorLabel.appendChild(newColor);section.appendChild(colorLabel);
        const register=document.createElement("button");
        register.type="button";register.textContent="Préparer la PR WebApp";
        const registerStatus=document.createElement("p");
        registerStatus.setAttribute("role","status");
        registerStatus.setAttribute("aria-live","polite");
        register.addEventListener("click",async()=>{
          const selection={key:newKey.value.trim(),name:newName.value.trim(),
            roleId:newRole.value.trim(),color:newColor.value.toUpperCase()};
          if(!/^[a-z][a-z0-9-]{1,63}$/.test(selection.key)||
             !selection.name||!/^#[0-9A-F]{6}$/.test(selection.color)||
             !/^[0-9]{16,22}$/.test(selection.roleId)){
            registerStatus.textContent="Vérifie la clé, le nom, la couleur et les 16 à 22 chiffres du rôle Discord.";
            return;
          }
          register.disabled=true;
          registerStatus.textContent="Demande de PR GitHub en cours…";
          try{
            const response=await fetch("/admin/api/guest-webapp-onboarding",{
              method:"POST",credentials:"same-origin",cache:"no-store",
              headers:{"Content-Type":"application/json",Accept:"application/json"},
              body:JSON.stringify(selection)
            });
            const result=await response.json();
            if(response.status!==202||result.status!=="queued")
              throw Error(result.status||"github-unavailable");
            registerStatus.textContent="Workflow GitHub lancé. Vérifie puis fusionne la PR ; aucune collecte n'a été autorisée.";
            const link=document.createElement("a");
            link.href="https://github.com/Keryas777/msf/actions/workflows/register-guest-alliance.yml";
            link.target="_blank";link.rel="noopener noreferrer";
            link.textContent="Voir le workflow GitHub";
            registerStatus.appendChild(link);
          }catch(error){
            registerStatus.textContent="Envoi impossible : "+(error.message||"indisponible");
            register.disabled=false;
          }
        });
        section.append(register,registerStatus);
        parent.appendChild(section);
      }
      if(!alliance.approved){
        const guest=document.createElement("button");
        guest.type="button";
        allianceLabel(guest,alliance.guestApproved?
          "Révoquer la collecte invitée — ":
          "Autoriser la collecte invitée — ",alliance.name);
        const guestStatus=document.createElement("p");
        guestStatus.setAttribute("role","status");
        guest.addEventListener("click",async()=>{
          guest.disabled=true;
          guestStatus.textContent="Vérification des autorisations…";
          try{
            const response=await fetch("/admin/api/guest-alliance-approval",{
              method:"POST",credentials:"same-origin",cache:"no-store",
              headers:{"Content-Type":"application/json",Accept:"application/json"},
              body:JSON.stringify({fingerprint:alliance.fingerprint,
                 action:alliance.guestApproved?"revoke":"approve",
                 ...(!alliance.guestApproved&&suggestedKey?
                   {allianceKey:suggestedKey}:{})})
            });
            const result=await response.json();
            if(!response.ok)throw Error(result.error||"approval-unavailable");
            guestStatus.textContent=alliance.guestApproved?
               "Collecte invitée révoquée.":
               suggestedKey?
                 "Collecte approuvée et association WebApp enregistrée : "+suggestedKey+".":
                 "Collecte approuvée. Clé WebApp à confirmer : nom absent du registre ou ambigu.";
            void loadConnectedAlliances();
          }catch(error){
            guestStatus.textContent="Impossible : "+(error.message||"indisponible");
            guest.disabled=false;
          }
        });
        parent.append(guest,guestStatus);
        if(alliance.guestApproved){
          const identity=document.createElement("label");
          identity.textContent="Clé WebApp autorisée (docs/data/alliances.json) : ";
          const field=document.createElement("input");
          field.type="text";field.autocomplete="off";field.spellcheck=false;
          field.placeholder="ex. endgame-revolution-red";
          // Only guestAllianceKey comes from the persisted R2 approval registry.
          // A colour-based suggestion must never be presented as a saved link.
          const savedKey=typeof alliance.guestAllianceKey==="string"?
            alliance.guestAllianceKey:"";
          field.value=savedKey||suggestedKey;
          field.maxLength=64;
          identity.append(field);
          const bind=document.createElement("button");
          bind.type="button";bind.textContent="Associer à la WebApp";
          const identityStatus=document.createElement("p");
          identityStatus.setAttribute("role","status");
          identityStatus.setAttribute("aria-live","polite");
          // The authenticated directory reads this binding from R2 on EVERY
          // refresh. A pre-filled suggestion is never proof of association.
          identityStatus.textContent=savedKey?
            "✅ Association confirmée : "+savedKey+" (enregistrée dans R2).":
            "⚠️ Association non enregistrée dans R2."+
              (suggestedKey?" Clé proposée automatiquement : "+suggestedKey+
                " (non enregistrée ; utiliser « Associer à la WebApp »).":"");
          // A successful POST is not enough: the subsequent GET must confirm
          // the requested binding, including explicit unbinding.
          if(bindingFeedback?.fingerprint===alliance.fingerprint){
            if(savedKey!==bindingFeedback.expectedKey)
              identityStatus.textContent="⚠️ Association non confirmée dans R2. "+
                "Actualise les alliances connectées avant de réessayer.";
            else if(!savedKey)
              identityStatus.textContent="Association WebApp supprimée "+
                "(confirmée dans R2).";
          }
          bind.addEventListener("click",async()=>{
            const key=field.value.trim();
            if(key&&!/^[a-z][a-z0-9-]{1,63}$/.test(key)){
              identityStatus.textContent="Clé invalide : utiliser la clé exacte du registre WebApp.";
              return;
            }
            bind.disabled=true;
            try{
              const response=await fetch("/admin/api/guest-alliance-approval",{
                method:"POST",credentials:"same-origin",cache:"no-store",
                headers:{"Content-Type":"application/json",Accept:"application/json"},
                body:JSON.stringify({fingerprint:alliance.fingerprint,
                  action:key?"bind":"unbind",...(key?{allianceKey:key}:{})})
              });
              const result=await response.json();
              if(!response.ok||
                 !["bound","already-bound","unbound","already-unbound"]
                   .includes(result.status))
                throw Error(result.error||result.status||"binding-unavailable");
              identityStatus.textContent="Enregistrement effectué ; confirmation R2…";
              await loadConnectedAlliances({
                fingerprint:alliance.fingerprint,expectedKey:key
              });
            }catch(error){
              identityStatus.textContent="Association impossible : "+
                (error.message||"indisponible");
              bind.disabled=false;
            }
          });
          parent.append(identity,bind,identityStatus);
          if(savedKey){
            const title=document.createElement("p");
            title.textContent="Rattrapage automatique à l’arrivée — "+savedKey;
            const progress=document.createElement("p");
            progress.setAttribute("role","status");
            progress.setAttribute("aria-live","polite");
            const check=document.createElement("button");
            check.type="button";check.textContent="Voir le rattrapage initial";
            const restart=document.createElement("button");
            restart.type="button";restart.textContent="Relancer les collectes initiales";
            const labels={roster:"Rosters partagés",infos:"Infos enrichies",
              ranks:"Rangs Guerre / Raid de la saison précédente",
              trophies:"Trophées rattachés au dernier relevé groupé",
              arena:"Premier relevé d'Arène",done:"Terminé"};
            const update=async()=>{
              check.disabled=true;
              try{
                const res=await fetch("/admin/api/guest-initial-sync?fingerprint="+
                  encodeURIComponent(alliance.fingerprint),{
                  credentials:"same-origin",cache:"no-store",
                  headers:{Accept:"application/json"}});
                const body=await res.json();
                if(!res.ok)throw Error(body.status||"unavailable");
                progress.textContent="État : "+body.status+
                  (body.phase?" — "+(labels[body.phase]||body.phase):"")+
                  (body.lastOutcome?" ("+body.lastOutcome+")":"")+
                  (body.updatedAt?" — "+body.updatedAt:"");
              }catch(error){
                progress.textContent="Impossible de lire la progression : "+
                  (error.message||"indisponible");
              }finally{check.disabled=false;}
            };
            check.addEventListener("click",update);
            restart.addEventListener("click",async()=>{
              restart.disabled=true;
              progress.textContent="Relance de la collecte initiale…";
              try{
                const res=await fetch("/admin/api/guest-initial-sync?fingerprint="+
                  encodeURIComponent(alliance.fingerprint),{
                  method:"POST",credentials:"same-origin",cache:"no-store",
                  headers:{"Content-Type":"application/json",Accept:"application/json"},
                  body:JSON.stringify({action:"restart"})
                });
                const body=await res.json();
                if(res.status!==202||body.status!=="queued")
                  throw Error(body.status||"unavailable");
                await update();
              }catch(error){
                progress.textContent="Relance impossible : "+
                  (error.message||"indisponible");
              }finally{restart.disabled=false;}
            });
            parent.append(title,progress,check,restart);
            void update();
          }
        }
      }
      if(!alliance.approved&&!alliance.guestApproved){
        const enable=document.createElement("button");
        enable.type="button";
        enable.className="roster-losp-enroll-danger";
        allianceLabel(enable,"Inclure ",alliance.name," dans les collectes LoSP");
        const info=document.createElement("p");
        info.setAttribute("role","status");
        enable.addEventListener("click",async()=>{
          enable.disabled=true;
          info.textContent="Vérification Scopely et ajout sans remplacer les alliances actuelles…";
          try{
            const approval=await fetch("/admin/api/roster-approve-one",{
              method:"POST",credentials:"same-origin",cache:"no-store",
              headers:{"Content-Type":"application/json",Accept:"application/json"},
              body:JSON.stringify({fingerprint:alliance.fingerprint})
            });
            const result=await approval.json();
            if(!approval.ok||!["approved","already-approved"].includes(result.status))
              throw Error(result.error||result.status||"approval-unavailable");
            info.textContent="Alliance intégrée aux collectes LoSP. Les collectes des "+
              "rosters partagés démarreront lors de la prochaine campagne.";
            void loadConnectedAlliances();
          }catch(error){
            info.textContent="Ajout impossible : "+(error.message||"indisponible");
            enable.disabled=false;
          }
        });
        parent.append(enable,info);
      }
    }
    status.textContent=result.alliances.length+" alliance(s) détectée(s) automatiquement sur "+
      result.connectedSessions+" connexion(s) active(s)."+
      (result.unresolvedSessions?" "+result.unresolvedSessions+
        " connexion(s) non identifiée(s) : réessayer ultérieurement.":"");
  }catch{
    status.textContent="Annuaire temporairement indisponible. Les autorisations restent conservées.";
  }finally{if(button)button.disabled=false;}
}

async function loadRosterPreflight(){
  const btn=rosterEl("roster-preflight"),status=rosterEl("roster-preflight-status"),
    parent=rosterEl("roster-preflight-list");
  rosterClear();status.textContent="Lecture de la couverture Scopely actuelle…";
  rosterEl("roster-approve-status").textContent="";
  btn.disabled=true;
  try{
    const response=await fetch("/admin/api/roster-preflight",{
      credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
    });
    const report=await response.json();
    if(!response.ok||report.mode!=="approval-preflight-only"||
       !Array.isArray(report.alliances))throw Error("preflight-failed");
    rosterSnapshot=report;
    rosterLine(parent,report.alliances.length+" alliance(s) détectée(s), "+
      report.scannedSessions+" connexion(s). Registre : "+
      (report.registryStatus==="configured"?"déjà configuré":"à initialiser")+".");
    for(const a of report.alliances){
      const label=document.createElement("label");
      const input=document.createElement("input");
      input.type="checkbox";
      input.className="roster-approval-choice";
      input.value=a.fingerprint;
      input.checked=a.approved===true;
      input.disabled=a.status!=="available"||!report.complete;
      label.appendChild(input);
      label.appendChild(document.createTextNode(" "+a.name+" — "+
        (a.memberCount??"?")+" membres ; "+(a.sharedCount??"?")+
        " partages ; "+(a.captainConnections??0)+" connexion(s) ; "+
        (a.status==="available"?"API accessible":"indisponible")));
      parent.appendChild(label);
      if(a.approved&&a.status==="available"){
        const pilot=document.createElement("button");
        pilot.type="button";
        pilot.textContent="Tester 1 roster — "+a.name;
        pilot.disabled=!report.complete;
        const progress=document.createElement("p");
        progress.setAttribute("role","status");
        pilot.addEventListener("click",()=>runPrivateRosterPilot(a,pilot,progress));
        parent.appendChild(pilot);
        parent.appendChild(progress);
        const advance=document.createElement("button");
        advance.type="button";
        advance.textContent="Collecter le prochain lot (2) — "+a.name;
        const batchProgress=document.createElement("p");
        batchProgress.setAttribute("role","status");
        advance.disabled=!report.complete;
        advance.addEventListener("click",()=>rosterBatchStart(a,advance,batchProgress));
        parent.appendChild(advance);
        const refresh=document.createElement("button");
        refresh.type="button";
        refresh.className="roster-refresh";
        refresh.textContent="Vérifier les changements (since / 344) — "+a.name;
        refresh.disabled=true;
        refresh.addEventListener("click",()=>rosterBatchStart(a,refresh,batchProgress,false,true));
        parent.appendChild(refresh);
        parent.appendChild(batchProgress);
        void rosterBatchStatus(a,batchProgress).then(state=>{
          refresh.disabled=state?.status!=="complete-co-members"||!report.complete;
        });
      }else parent.appendChild(document.createElement("p"));
    }
    for(const absent of report.unobservedApproved||[])
      rosterLine(parent,"Alliance approuvée mais non retrouvée aujourd'hui : "+
        absent.name+" (non disponible pour collecte).");
    rosterLine(parent,"Le nombre de partages ne garantit pas encore la lecture "+
      "complète des rosters. Le roster personnel du compte OAuth nécessitera "+
      "aussi un contrôle distinct.");
    status.textContent=report.complete?
      "Couverture complète : tu peux enregistrer ta sélection. "+
      "Cela N'ACTIVE PAS encore de collecte automatique.":
      "Couverture incomplète : aucune approbation possible. Vérifie les sessions OAuth.";
    rosterEl("roster-approve").disabled=!report.complete;
  }catch{
    status.textContent="Prévalidation indisponible ; aucune modification effectuée.";
  }finally{btn.disabled=false;}
}
async function submitRosterApprovals(){
  const button=rosterEl("roster-approve"),status=rosterEl("roster-approve-status");
  if(!rosterSnapshot?.complete)return;
  const choices=[...document.querySelectorAll(".roster-approval-choice")]
    .filter(c=>c.checked&&!c.disabled).map(c=>c.value);
  if(!choices.length){status.textContent="Choisis au moins une alliance.";return;}
  button.disabled=true;
  status.textContent="Enregistrement privé en cours…";
  try{
    const response=await fetch("/admin/api/roster-approvals",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify({fingerprints:choices})
    });
    const body=await response.json();
    if(!response.ok||body.status!=="approved")throw Error("approval-failed");
    status.textContent=body.count+" alliance(s) approuvée(s) dans R2 privé. "+
      "Aucun roster téléchargé, aucun cron de collecte activé.";
    rosterClear(); // Require a fresh Scopely census before any new mutation.
    void loadConnectedAlliances();
  }catch{
    status.textContent="Enregistrement refusé ou indisponible. "+
      "Aucune activation de collecte n'a eu lieu.";
    button.disabled=false;
  }
}
const connectedRefresh=rosterEl("roster-connected-refresh");
if(connectedRefresh)connectedRefresh.addEventListener("click",loadConnectedAlliances);
void loadConnectedAlliances();
rosterEl("roster-preflight").addEventListener("click",loadRosterPreflight);
rosterEl("roster-approve").addEventListener("click",submitRosterApprovals);

const rosterAutoTestButton=rosterEl("roster-auto-test");
if(rosterAutoTestButton)rosterAutoTestButton.addEventListener("click",runOneAutoRosterTest);
const rosterAutoRefresh=rosterEl("roster-auto-refresh");
if(rosterAutoRefresh)rosterAutoRefresh.addEventListener("click",()=>void showRosterAutoStatus());
