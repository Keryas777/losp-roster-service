// Admin-only manual collection of still-unarchived /player families.
// No token, raw player data or provider response is rendered by this panel.
(()=>{"use strict";
const $=id=>document.getElementById(id);
const type=$("player-extra-resource"),memberWrap=$("player-extra-member-wrap");
const members=$("player-extra-member"),status=$("player-extra-status");
const capture=$("player-extra-capture"),loadMembers=$("player-extra-members-load");
const inspect=$("player-extra-inspect"),report=$("player-extra-report");
const session=$("session");
let membersSession=null;
const shared=()=>type.value==="shared-member-squads";
function reset(){
  membersSession=null;members.replaceChildren(new Option("Charger les membres…",""));
  report.textContent="";status.textContent="";
}
function toggle(){memberWrap.hidden=!shared();status.textContent="";}
session.addEventListener("change",reset);type.addEventListener("change",toggle);toggle();
async function send(url,body){
  const r=await fetch(url,{credentials:"same-origin",cache:"no-store",
    method:body?"POST":"GET",
    headers:body?{"Content-Type":"application/json",Accept:"application/json"}:
      {Accept:"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const value=await r.json();
  if(!r.ok)throw Error((value.error||value.status||"HTTP "+r.status)+
    (value.upstreamStatus?" (HTTP "+value.upstreamStatus+")":""));
  return value;
}
loadMembers.addEventListener("click",async()=>{
  if(!session.value){status.textContent="Sélectionne un compte OAuth.";return;}
  loadMembers.disabled=true;membersSession=null;
  members.replaceChildren(new Option("Chargement…",""));
  try{
    const data=await send("/admin/api/data?"+
      new URLSearchParams({session:session.value,resource:"alliance-members"}));
    members.replaceChildren(new Option("Choisir un membre…",""));
    for(const x of data.payload?.data||[]){
      if(x?.isSelf===true||x?.card?.rosterShare!==true||
        typeof x.id!=="string")continue;
      // Names can contain MSF color markers, never interpreted as HTML.
      const label=String(x.card.name||"Membre sans pseudo").replace(/<#[0-9a-f]{6}>/gi,"");
      members.add(new Option(label,x.id));
    }
    membersSession=session.value;
    status.textContent="Membres actuels partageant leur roster chargés.";
  }catch(e){status.textContent="Lecture impossible : "+e.message;}
  finally{loadMembers.disabled=false;}
});
capture.addEventListener("click",async()=>{
  if(!session.value){status.textContent="Sélectionne un compte OAuth.";return;}
  const body={session:session.value,resource:type.value};
  if(shared()){
    if(membersSession!==session.value||!members.value){
      status.textContent="Charge les membres actuels et sélectionne un partage autorisé.";
      return;
    }
    body.member=members.value;
  }
  capture.disabled=true;report.textContent="";
  status.textContent="Lecture officielle en cours : archivage privé, pages contrôlées…";
  try{
    const result=await send("/admin/api/player-extras",body);
    report.textContent=JSON.stringify(result,null,2);
    status.textContent=result.status==="archived"?
      "Archivage complet confirmé : "+result.pages+" page(s), "+result.entries+
      " entrée(s). Rétention R2 de 7 jours.":
      "Capture récente réutilisée : aucun nouvel appel au fournisseur.";
  }catch(e){status.textContent="Collecte non confirmée : "+e.message+
    ". Une erreur ou une limite ne vaut jamais archive complète.";}
  finally{capture.disabled=false;}
});
inspect.addEventListener("click",async()=>{
  if(!session.value){status.textContent="Sélectionne un compte OAuth.";return;}
  inspect.disabled=true;status.textContent="Vérification R2 sans appeler Scopely…";
  try{
    const data=await send("/admin/api/player-extras?"+
      new URLSearchParams({session:session.value}));
    report.textContent=JSON.stringify(data,null,2);
    status.textContent="Bilan privé chargé : aucune requête vers Scopely.";
  }catch(e){status.textContent="Bilan indisponible : "+e.message;}
  finally{inspect.disabled=false;}
});
})();