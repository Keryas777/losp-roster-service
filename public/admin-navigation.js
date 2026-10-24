// Compact, mobile-first navigation for the existing authenticated admin page.
// Pure DOM rearrangement: never fetches data or changes the underlying controls.
(()=>{
  const main=document.querySelector("main");
  if(!main)return;
  const groups=[
    {id:"overview",label:"Vue d’ensemble",targets:[
      "collection-dashboard-refresh","refresh","check-refresh","season-ranks-refresh"]},
    {id:"rosters",label:"Rosters",targets:[
      "connected-alliance-directory","check-coverage","roster-preflight","roster-r2-refresh"]},
    {id:"archives",label:"Archives R2",targets:[
      "player-campaign-start","game-archive-status","game-r2-inventory-start","game-orphan-start",
      "game-inspect-start","game-schema-start"]},
    {id:"advanced",label:"Outils avancés",targets:[
      "player-extra-capture","msf-secondary-probe","pid-check","load","output"]}
  ];
  const sections=[...main.children].filter(el=>el.tagName==="SECTION");
  const byGroup=new Map(groups.map(g=>[g.id,[]]));
  const nav=document.createElement("nav");
  nav.className="admin-tabs";
  nav.setAttribute("aria-label","Rubriques d’administration");
  const buttons=new Map();
  function sourceLabel(section){
    // Labels are UI guidance only; real requests still require the explicit controls.
    if(section.querySelector("#refresh,#check-coverage,#roster-preflight,"+
        "#pid-check,#msf-secondary-probe,#load"))return " · API à la demande";
    if(section.querySelector("#season-ranks-refresh"))return " · R2 / capture manuelle";
    if(section.querySelector("#player-campaign-start"))return " · collecte globale /player";
    return " · R2";
  }
  for(const section of sections){
    const group=groups.find(g=>g.targets.some(id=>
      section.id===id||section.querySelector("#"+id)));
    if(!group)continue; // Preserve future admin sections visibly if unknown.
    byGroup.get(group.id).push(section);
    section.dataset.adminGroup=group.id;
    // Explorer rebuilds #output with replaceChildren() after each provider read.
    // Keep it as a normal section: wrapping it would be erased on first result.
    if(section.id==="collection-dashboard"||section.id==="connected-alliance-directory"){
      section.classList.add(section.id==="collection-dashboard"?"admin-dashboard":"admin-alliance-directory");
      continue;
    }
    if(section.id==="output"){
      section.classList.add("admin-output");
      continue;
    }
    const title=section.querySelector(":scope > h2");
    const panel=document.createElement("details");
    panel.className="admin-disclosure";
    const summary=document.createElement("summary");
    summary.className="admin-disclosure-title";
    summary.textContent=(title?.textContent||"Résultat de l’explorateur")+sourceLabel(section);
    if(title)title.remove();
    const body=document.createElement("div");
    body.className="admin-disclosure-body";
    while(section.firstChild)body.appendChild(section.firstChild);
    panel.append(summary,body);
    section.append(panel);
  }
  const desired=window.location.hash.slice(1);
  let selected=groups.some(g=>g.id===desired)?desired:"overview";
  function select(id,updateHash=true){
    if(!byGroup.has(id))return;
    selected=id;
    for(const section of sections){
      if(!section.dataset.adminGroup)continue;
      section.hidden=section.dataset.adminGroup!==id;
    }
    for(const [groupId,button] of buttons){
      const active=groupId===id;
      button.setAttribute("aria-current",active?"page":"false");
      button.classList.toggle("active",active);
    }
    // Keep every panel collapsed by default. A user's manual choices stay
    // unchanged when switching between tabs; navigation never expands one.
    if(updateHash&&window.history?.replaceState)
      window.history.replaceState(null,"","#"+id);
  }
  for(const group of groups){
    const button=document.createElement("button");
    button.type="button";
    button.textContent=group.label;
    button.className="admin-tab";
    button.addEventListener("click",()=>select(group.id));
    buttons.set(group.id,button);
    nav.appendChild(button);
  }
  main.before(nav);
  document.body.classList.add("admin-nav-ready");
  select(selected,false);
  window.addEventListener("hashchange",()=>{
    const id=window.location.hash.slice(1);
    if(byGroup.has(id))select(id,false);
  });
})();
