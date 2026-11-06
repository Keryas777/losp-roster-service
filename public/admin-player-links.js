// Admin-only Discord <-> MSF matching. All endpoints already Access-gated.
// No browser persistence of member directories; no Scopely collection.
(()=>{
 "use strict";
 const $=id=>document.getElementById(id);
 const panel=$("player-links-admin"),alliance=$("player-links-alliance");
 const msf=$("player-links-msf"),discord=$("player-links-discord");
 const load=$("player-links-load"),save=$("player-links-save");
 const status=$("player-links-status"),list=$("player-links-list");
 if(!panel||!alliance||!msf||!discord||!load||!save||!status||!list)return;
 let alliances=[],items=[],revision="",players=[],members=[],busy=false;
 const note=text=>{status.textContent=text;};
 const option=(select,value,label)=>{
   const o=document.createElement("option");o.value=value;o.textContent=label;
   select.appendChild(o);
 };
 const request=async(url,init={})=>{
   const r=await fetch(url,{credentials:"same-origin",cache:"no-store",...init});
   let data;try{data=await r.json();}catch{throw Error("HTTP "+r.status);}
   if(!r.ok||data.status!=="ok")throw Error(data.status||"HTTP "+r.status);
   return data;
 };
 const updateSave=()=>{
   save.disabled=busy||!msf.value||!discord.value||!revision;
 };
 function setOptions(select,rows,placeholder){
   select.replaceChildren();option(select,"",placeholder);
   rows.forEach(row=>option(select,row.value,row.label));
   updateSave();
 }
 function displayAll(){
   list.replaceChildren();
   const selected=alliance.value;
   const group=items.filter(i=>i.alliance===selected);
   const p=document.createElement("p");
   p.className="muted";
   p.textContent=group.length+" association(s) enregistrée(s) dans cette alliance.";
   list.appendChild(p);
   if(!group.length)return;
   const table=document.createElement("table"),head=document.createElement("thead"),
     tr=document.createElement("tr");
   ["Pseudo MSF","Discord","Action"].forEach(label=>{
     const th=document.createElement("th");th.textContent=label;tr.appendChild(th);
   });
   head.appendChild(tr);table.appendChild(head);
   const body=document.createElement("tbody");
   group.slice().sort((a,b)=>a.player.localeCompare(b.player,"fr")).forEach(link=>{
     const tr=document.createElement("tr"),p=document.createElement("td"),
       d=document.createElement("td"),a=document.createElement("td");
     p.textContent=link.player;
     const member=members.find(m=>m.id===link.discordId);
     d.textContent=member?
       member.displayName+" (@"+member.username+")":"ID "+link.discordId;
     const remove=document.createElement("button");remove.type="button";
     remove.textContent="Dissocier";
     remove.addEventListener("click",async()=>{
       if(!window.confirm("Dissocier "+link.player+" de ce compte Discord ?"))return;
       await mutate({action:"delete",alliance:link.alliance,
         discordId:link.discordId});
     });
     a.appendChild(remove);tr.append(p,d,a);body.appendChild(tr);
   });
   table.appendChild(body);list.appendChild(table);
 }
 async function refreshLinks(){
   const data=await request("/admin/api/player-links?view=links");
   items=data.items;revision=data.revision;displayAll();
 }
 async function refreshDirectory(){
   if(!alliance.value)return;
   busy=true;updateSave();
   players=[];members=[];
   setOptions(msf,[],"Chargement des joueurs…");
   setOptions(discord,[],"Chargement de Discord…");
   note("Lecture des rosters existants et des rôles Discord…");
   try{
     const key=encodeURIComponent(alliance.value);
     const [p,d]=await Promise.all([
       request("/admin/api/player-links?view=players&alliance="+key),
       request("/admin/api/player-links?view=discord&alliance="+key)
     ]);
     players=p.players;members=d.members;
     setOptions(msf,players.map(name=>({value:name,label:name})),
       "— Choisir un pseudo MSF —");
     setOptions(discord,members.map(m=>({value:m.id,
       label:m.displayName+" (@"+m.username+")"})),
       "— Choisir un compte Discord —");
     note(players.length+" joueur(s) MSF et "+members.length+
       " membre(s) Discord disponibles. Les rapprochements sont manuels.");
   }catch(error){
     note("Chargement impossible : "+error.message+
       ". Vérifier le roster publié et le secret DISCORD_BOT_TOKEN du Roster Service.");
     setOptions(msf,[],"— Données indisponibles —");
     setOptions(discord,[],"— Données indisponibles —");
   }finally{busy=false;updateSave();displayAll();}
 }
 async function mutate(payload){
   if(busy)return;
   busy=true;updateSave();note("Enregistrement privé en cours…");
   try{
     const data=await request("/admin/api/player-links?view=links",{
       method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({...payload,revision})
     });
     items=data.items;revision=data.revision;
     note(payload.action==="delete"?"Association supprimée.":"Association enregistrée.");
     displayAll();
   }catch(error){
     note("Enregistrement refusé : "+error.message+
       ". Actualiser les associations si une autre session les a modifiées.");
   }finally{busy=false;updateSave();}
 }
 load.addEventListener("click",async()=>{
   if(busy)return;
   busy=true;updateSave();note("Chargement des associations…");
   try{
     if(!alliances.length){
       const data=await request("/admin/api/player-links?view=alliances");
       alliances=data.alliances;
       setOptions(alliance,alliances.map(a=>({
         value:a.key,label:a.name+" · "+a.key
       })),"— Choisir une alliance —");
       if(alliances.length)alliance.value=alliances[0].key;
     }
     await refreshLinks();
   }catch(error){note("Erreur : "+error.message);busy=false;updateSave();return;}
   busy=false;updateSave();
   await refreshDirectory();
 });
 alliance.addEventListener("change",()=>{displayAll();void refreshDirectory();});
 msf.addEventListener("change",updateSave);
 discord.addEventListener("change",updateSave);
 save.addEventListener("click",()=>{
   if(!alliance.value||!msf.value||!discord.value)return;
   void mutate({action:"upsert",alliance:alliance.value,
     player:msf.value,discordId:discord.value});
 });
})();
