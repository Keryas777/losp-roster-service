// Admin-only selection of a consented Scopely account as level-110 model.
// No private event payloads or OAuth credentials reach GitHub Pages.
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const status=$('events-reference-status');
  const selection=$('events-reference-session');
  if(!status||!selection)return;
  const say=message=>{status.textContent=message;};
  const request=async(path,options)=>{
    const res=await fetch(path,{cache:'no-store',...options});
    let body={};try{body=await res.json();}catch{}
    if(!res.ok)throw Error(body.error||'HTTP '+res.status);
    return body;
  };
  const refresh=async()=>{
    const config=await request('/admin/api/events-reference');
    const previous=selection.value;
    selection.replaceChildren();
    const prompt=document.createElement('option');
    prompt.value='';prompt.textContent='Choisir un compte connecté';
    selection.append(prompt);
    let cursor=null,found=0,chosen=false;
    for(let page=0;page<20;page++){
      const url='/admin/api/sessions'+(cursor?'?cursor='+encodeURIComponent(cursor):'');
      const result=await request(url);
      for(const entry of result.sessions||[]){
        if(entry.status!=='active'||!entry.playerName||!entry.id)continue;
        const option=document.createElement('option');
        option.value=entry.id;
        option.textContent=entry.playerName+' — '+(entry.allianceName||'Alliance inconnue');
        selection.append(option);found++;
        if(entry.id===(previous||config.selectedSession)){
          option.selected=true;chosen=true;
        }
      }
      if(!result.nextCursor)break;
      cursor=result.nextCursor;
    }
    if(!chosen)selection.value='';
    say(config.configured?
      'Référence déjà autorisée (niveau 110). '+(chosen?'Compte sélectionné dans la liste.':'Compte indisponible dans cette liste.')+
        ' La collecte vérifiée se fait avec les événements du compte, sans sa progression.':
      found+' comptes connectés disponibles. Sélectionner uniquement ton compte Scopely.');
  };
  $('events-reference-load')?.addEventListener('click',()=>refresh().catch(e=>say(e.message)));
  $('events-reference-select')?.addEventListener('click',async()=>{
    if(!selection.value){say('Choisis ton compte dans la liste.');return;}
    if(!confirm('Utiliser uniquement les identifiants de tes missions Scopely pour les objectifs publics niveau 110 ? Aucun statut personnel ne sera publié.'))return;
    say('Vérification du compte niveau 110…');
    try{
      await request('/admin/api/events-reference',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'select',session:selection.value})
      });
      say('Compte de référence sélectionné. Le prochain Cron actualisera le catalogue public après contrôle des missions.');
    }catch(e){say('Référence non modifiée : '+e.message);}
  });
  $('events-reference-clear')?.addEventListener('click',async()=>{
    if(!confirm('Désactiver la référence commune et republier le catalogue sans sélection personnelle ?'))return;
    try{
      await request('/admin/api/events-reference',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'clear'})
      });
      say('Référence désactivée. Une publication sans filtrage sera déclenchée par le Cron.');
    }catch(e){say('Désactivation impossible : '+e.message);}
  });
  // Reading the selected account only happens when the admin requests it.
})();
