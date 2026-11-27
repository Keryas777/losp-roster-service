import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createRequire} from "node:module";

const require=createRequire(import.meta.url);
const {chromium,webkit}=require("playwright");
const browserName=process.env.BROWSER||"webkit";
const browserType=browserName==="chromium"?chromium:webkit;
const root=resolve(new URL("../public/event-planner/",import.meta.url).pathname);
const now=Math.floor(Date.now()/1000);
const enEvent={id:"planner-test",name:"Planner Test",type:"milestone",startTime:now-3600,endTime:now+86400,
  milestone:{type:"solo",scoring:{methods:[],cappedScorings:[
    {cap:10,soFar:5,isPremium:true,methods:[{description:"Play Blitz with Captain America at 7 Yellow Stars",points:5}]},
    {cap:1,soFar:1,methods:[{description:"Daily Login",points:1}]},
    {cap:5,methods:[{description:"Play Blitz with Captain America at 8 Yellow Stars",points:1}]},
    {cap:100,soFar:0,methods:[{description:"Spend Gold",points:1}]}
  ]},brackets:[{id:"default",objective:{progress:{points:10,completedTier:1,claimableTiers:[]},tiers:{
    1:{goal:10,rewards:{allOf:[]}},2:{goal:20,rewards:{allOf:[]}}
  }}}]}};
const frEvent={...enEvent,name:"Événement de test"};
const commandWrapper={id:"command-wrapper",name:"Poste de commandement de test",type:"milestone",locationHints:["lohub_wrapper"],
  startTime:now-3600,endTime:now+86400,
  milestone:{type:"solo",scoring:{methods:[],cappedScorings:[]},brackets:[]}};
const commandFeeder={id:"command-feeder",name:"Poste de commandement de test",type:"milestone",locationHints:["lohub_feeder"],
  startTime:now-1800,endTime:now+43200,milestone:{type:"solo",scoring:{methods:[],cappedScorings:[
    {cap:10,soFar:10,methods:[{description:"Play Blitz with Captain America",points:1}]},
    {cap:10,methods:[{description:"Daily Login",points:1}]}
  ]},brackets:[{id:"default",objective:{progress:{points:10},tiers:{}}}]}};

const art="https://assets.marvelstrikeforce.com/key_art/PlannerTest.webp";
const calendarEvent={...enEvent,cardArt:art,popupArt:art};
const campaign={id:"campaign-test",name:"Campagne de test",type:"episodic",startTime:now-1200,endTime:now+2*86400,
  cardArt:art,popupArt:art,episodic:{type:"eventCampaign",ids:["campaign-id"]}};
const trial={id:"trial-test",name:"Épreuve de test",type:"pickYourPoison",startTime:now-1200,endTime:now+3*86400,
  cardArt:art,popupArt:art,pickYourPoison:{brackets:[{}]}};
const hiddenEvents=[
  {...calendarEvent,id:"past-test",name:"Jalon passé",startTime:now-90000,endTime:now-1000},
  {...calendarEvent,id:"future-test",name:"Jalon futur",startTime:now+1000,endTime:now+90000},
  {...calendarEvent,id:"battlepass-test",name:"Passe de combat",type:"battlePass"},
  {...calendarEvent,id:"onboarding-test",name:"First S.T.R.I.K.E."},
  {...calendarEvent,id:"feeder-test",name:"Jalon secondaire",locationHints:["lohub_feeder"]}
];
const snapshot={events:[calendarEvent,commandWrapper,commandFeeder,campaign,trial,...hiddenEvents],updatedAt:new Date().toISOString(),pages:1,locale:"fr",localizationStatus:"verified"};
const privateById=new Map([[enEvent.id,enEvent],[commandWrapper.id,commandWrapper],[commandFeeder.id,commandFeeder],[campaign.id,campaign],[trial.id,trial],...hiddenEvents.map(item=>[item.id,item])]);
const apiCalls=[];
let externalResourceCatalogRequests=0;
const captureScreenshots=process.env.CAPTURE_SCREENSHOTS==="1";
if(captureScreenshots)await mkdir(resolve("artifacts","planner-tabs"),{recursive:true});
let failEvents=false;
let failRoster=false;
let currentNamespace="a".repeat(64),currentConnected=true;
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(pathname==="/__test/profile"){const params=new URL(req.url,"http://localhost").searchParams;currentNamespace=params.get("namespace")||currentNamespace;currentConnected=params.get("connected")!=="false";res.writeHead(204);res.end();return;}
  if(pathname==="/__test/roster"){const params=new URL(req.url,"http://localhost").searchParams;failRoster=params.get("missing")==="true";res.writeHead(204);res.end();return;}
  if(pathname.startsWith("/admin/api/event-planner")){
    const params=new URL(req.url,"http://localhost").searchParams,resource=params.get("resource");
    apiCalls.push({resource,lang:params.get("lang"),itemType:params.get("itemType"),eventId:params.get("eventId"),refresh:params.get("refresh")});
    let body;
    if(resource==="status")body=currentConnected?{status:"connected",storageNamespace:currentNamespace,scopes:["m3p.f.pr.act","m3p.f.pr.ros","m3p.f.pr.inv"]}:{status:"disconnected",reason:"session-revoked"};
    else if(!currentConnected){res.writeHead(403,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"disconnected"}));return;}
    else if(resource==="events"&&failEvents){res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"provider-error",upstreamStatus:502,diagnostic:{endpoint:"/player/v1/events",httpStatus:502,providerCode:"event-list-unavailable",error:"provider-error",lang:params.get("lang"),page:1}}));return;}
    else if(resource==="events")body={status:"ok",data:[...privateById.values()].map(item=>item.id===enEvent.id&&params.get("lang")==="fr"?frEvent:item)};
    else if(resource==="roster"&&failRoster){res.writeHead(404,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"roster-unavailable",calls:0}));return;}
    else if(resource==="roster")body={status:"ok",retrievedAt:new Date().toISOString(),data:[{id:"CaptainAmerica",activeYellow:7,activeRed:0,gearTier:20,level:90,iso8:{active:"raider",raider:10}}]};
    else if(resource==="inventory")body={status:"ok",retrievedAt:new Date().toISOString(),upstream:{asOf:"inventory-test"},data:params.get("itemType")==="ISOITEM"?[{item:"ISO8-TIER-0-CURRENCY",quantity:0},{item:"ISO8-TIER-1-A-CURRENCY",quantity:125},{item:"ISOITEM_ORANGE_BLASTER_HEALTH_16",quantity:16},{item:"ISOITEM_ORANGE_BLASTER_DAMAGE_16",quantity:26},{item:"ISOITEM_ORANGE_BLASTER_ARMOR_16",quantity:17},{item:"ISOITEM_ORANGE_BLASTER_FOCUS_16",quantity:42},{item:"ISOITEM_ORANGE_BLASTER_RESIST_16",quantity:16}]:[{item:"SC",quantity:0},{item:"CONSUMABLE_XPLVL80",quantity:24},{item:"UNMAPPED_ITEM",name:"English Technical Name",icon:art}]};
    else if(resource==="detail"){await new Promise(resolve=>setTimeout(resolve,180));const item=privateById.get(params.get("eventId"))||enEvent;body={status:"ok",data:item.id===enEvent.id&&params.get("lang")==="fr"?frEvent:item};}
    else {res.writeHead(400);res.end("{}");return;}
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(body));return;
  }
  let path=pathname;
  const mount="/admin/events-planner/";
  if(path==="/admin/events-planner")path=mount+"index.html";
  if(path.startsWith(mount))path=path.slice(mount.length);
  const file=resolve(join(root,path));
  if(!file.startsWith(root+"/")){res.writeHead(404);res.end();return;}
  try{
    const bytes=await readFile(file),extension=file.split(".").at(-1);
    const type=extension==="html"?"text/html; charset=utf-8":extension==="css"?"text/css; charset=utf-8":extension==="json"?"application/json; charset=utf-8":"text/javascript; charset=utf-8";
    res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"});res.end(bytes);
  }catch{res.writeHead(404);res.end("not found");}
});

const launchOptions={headless:true};
if(browserName==="chromium"&&process.env.CHROMIUM_EXECUTABLE)launchOptions.executablePath=process.env.CHROMIUM_EXECUTABLE;
const browser=await browserType.launch(launchOptions);
try{
  await new Promise(resolveListen=>server.listen(0,"127.0.0.1",resolveListen));
  const address=server.address(),context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage(),runtimeErrors=[],consoleErrors=[];
  page.on("pageerror",error=>runtimeErrors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")consoleErrors.push(message.text());});
  await page.route("https://keryas777.github.io/msf/data/**",route=>{
    const url=route.request().url();let body;
    if(url.endsWith("msf-characters.json"))body=[{id:"CaptainAmerica",nameKey:"Captain America",nameEn:"Captain America",nameFr:"Captain America",portraitUrl:art,player_Character:true}];
    else if(url.endsWith("dd-character-traits.json"))body={characters:{CaptainAmerica:["Avenger"]}};
    else if(url.endsWith("evenements-snapshot.json"))body=snapshot;
    else if(url.endsWith("msf-resource-catalog.json")){externalResourceCatalogRequests++;body={items:[
      {id:"SC",names:{fr:"Or"},group:"gold",priority:true,sortOrder:1,categoryLabelFr:"Monnaie"},
      {id:"HC",names:{fr:"Noyaux d’énergie"},group:"cores",priority:true,sortOrder:2,categoryLabelFr:"Monnaie"},
      {id:"CONSUMABLE_XPLVL80",names:{fr:"Module d’entraînement N4"},group:"training",priority:true,sortOrder:3,icon:"https://assets.marvelstrikeforce.com/imgs/ICON_CONSUMABLE_XPLVL80_4ae2e7af.png",categoryLabelFr:"Progression"},
      {id:"ISO8-TIER-0-CURRENCY",names:{fr:"Ions P1"},group:"iso8Ions",priority:true,sortOrder:4,categoryLabelFr:"Ions ISO-8"},
      {id:"ISO8-TIER-1-A-CURRENCY",names:{fr:"Ions P2 niveau 1"},group:"iso8Ions",priority:true,sortOrder:5,categoryLabelFr:"Ions ISO-8"}
    ]};}
    else body={characters:{}};
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body),headers:{"Access-Control-Allow-Origin":"*"}});
  });
  if(process.env.LIVE_LOSP_STYLES!=="1"){
    await page.route("https://keryas777.github.io/msf/style.css*",route=>route.fulfill({status:200,contentType:"text/css",body:":root{--text:#eee;--muted:#aaa;--muted2:#888;--border:#444;--panel:#181818;--panel2:#222;--shadow:none;--toggle-on-bg:#292929}"}));
    await page.route("https://keryas777.github.io/msf/evenements.css*",route=>route.fulfill({status:200,contentType:"text/css",body:".ev-page{display:flex;flex-direction:column;width:100%;max-width:800px}.ev-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.ev-stat{display:flex;flex-direction:column}.ev-card{display:flex}.ev-cover{position:relative;flex:0 0 100px;min-height:135px}.ev-card-copy{flex:1;min-width:0}.ev-card h3{overflow-wrap:anywhere}.ev-section{display:flex;flex-direction:column}"}));
  }
  await page.route("https://keryas777.github.io/msf/HeaderObjectifs.webp",route=>route.fulfill({status:200,contentType:"image/gif",body:Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=","base64")}));
  await page.route("https://assets.marvelstrikeforce.com/**",route=>route.fulfill({status:200,contentType:"image/gif",body:Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=","base64")}));
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner?eventId=planner-test`,{waitUntil:"networkidle"});
  assert.equal(externalResourceCatalogRequests,0,`${browserName} resource catalog loads from the Worker assets, not unpublished MSF Pages`);
  await page.locator(".planner-event-card").first().waitFor({state:"attached"});
  assert.equal(await page.locator(".planner-event-card").count(),4,`${browserName} should use only public-calendar eligible current events and fold command-center feeders`);
  assert.equal(await page.getByRole("tab",{name:"Mon inventaire"}).count(),1);
  assert.equal(await page.getByText("Recalculer les relevés Maddoxx",{exact:true}).count(),0);
  assert.equal(await page.getByText("Passe de combat",{exact:true}).count(),0);
  assert.equal(await page.getByText("Jalon passé",{exact:true}).count(),0);
  assert.equal(await page.getByText("First S.T.R.I.K.E.",{exact:true}).count(),0);
  await page.locator("#selected-event h2").filter({hasText:"Événement de test"}).waitFor();
  assert.equal(await page.locator("#event-list-view").isHidden(),true,`${browserName} direct eventId link opens the matching event fiche`);
  assert.equal(apiCalls.filter(call=>call.resource==="detail").length,0,`${browserName} ordinary event selection does not request an unauthorized detail`);
  assert.equal(apiCalls.filter(call=>call.resource==="events"&&call.lang==="en").length,0,`${browserName} initialization never requests a second English event list`);
  assert.ok(apiCalls.filter(call=>call.resource==="events").every(call=>call.lang==="fr"),`${browserName} only the authorized French event list is requested`);
  assert.ok(apiCalls.filter(call=>call.resource==="roster").every(call=>call.lang==="fr"),`${browserName} roster is only addressed in French`);
  await page.locator(`#selected-event button[data-action="back-list"]`).click();
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner?eventId=future-test`,{waitUntil:"networkidle"});
  await page.getByText("Cet événement ne figure pas dans le calendrier LoSP actif ou est ignoré.",{exact:false}).waitFor();
  assert.equal(apiCalls.filter(call=>call.resource==="detail").length,0,`${browserName} filtered event deep links never fetch personal details`);
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner`,{waitUntil:"networkidle"});
  await page.locator(".planner-event-card").first().waitFor();
  const callsBeforeTabChanges=apiCalls.length;
  await page.getByRole("tab",{name:"Objectifs"}).click();
  await page.getByRole("tab",{name:"Planifier"}).click();
  await page.getByText("Sélectionne un événement pour afficher ton plan.",{exact:true}).waitFor();
  assert.equal(await page.locator("#plan-view .warning").count(),0,`${browserName} an unselected plan is an invitation, not an event-data error`);
  await page.getByRole("tab",{name:"Mon inventaire"}).click();
  await page.getByRole("tab",{name:"Événements"}).click();
  assert.equal(apiCalls.length,callsBeforeTabChanges,`${browserName} changing tabs does not repeat personal reads`);
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  const selectButton=page.locator('button[data-action="select"][data-event-id="planner-test"]');
  await selectButton.scrollIntoViewIfNeeded();
  const savedScroll=await page.evaluate(()=>window.scrollY);
  const savedHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  await selectButton.click();
  await page.locator("#selected-event").waitFor({state:"visible"});
  await page.locator("#selected-event h2").filter({hasText:"Événement de test"}).waitFor();
  await page.locator("#selected-event").getByText("Terminé confirmé").first().waitFor();
  await page.locator("#selected-event").getByText("Faisable gratuitement").first().waitFor();
  await page.locator("#selected-event").getByText(/Objectif associé au Passe Premium/).first().waitFor();
  await page.getByRole("button",{name:"Planifier cet événement"}).click();
  await page.getByRole("heading",{name:"Événement planifié"}).waitFor();
  assert.equal(await page.locator("#plan-event-name").textContent(),"Événement de test");
  await page.getByRole("progressbar",{name:"Progression vers le palier 2"}).waitFor();
  await page.getByText("Faisabilité inconnue",{exact:true}).waitFor();
  assert.equal(await page.locator("#plan-view").getByText("Atteignable avec les données connues",{exact:true}).count(),0,
    `${browserName} must not mark a tier attainable when the required resource is absent`);
  await page.getByRole("button",{name:"Retour à la fiche"}).click();
  await page.getByRole("button",{name:/Liste des événements/}).waitFor();
  await page.getByRole("button",{name:/Liste des événements/}).click();
  await page.waitForTimeout(60);
  const returnedScroll=await page.evaluate(()=>window.scrollY);
  const returnedHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  assert.ok(Math.abs(returnedScroll-savedScroll)<=2,`${browserName} list scroll position restored (${savedScroll} → ${returnedScroll}; height ${savedHeight} → ${returnedHeight})`);
  await page.locator('button[data-action="skip"][data-event-id="campaign-test"]').click();
  await page.locator(".skipped-wrap summary").click();
  await page.locator("#skipped-list").getByText("Campagne de test").waitFor();
  await page.locator('#skipped-list button[data-action="restore"][data-event-id="campaign-test"]').click();
  assert.equal(await page.locator(".planner-event-card").count(),4,`${browserName} skipped event restored with one grouped command-center wrapper`);
  const widthChecks={};
  const checkMobileWidths=async tabName=>{
    widthChecks[tabName]=[];
    for(const viewportWidth of [320,360,390,430]){
      await page.setViewportSize({width:viewportWidth,height:844});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
      const metrics=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
      widthChecks[tabName].push({viewportWidth,...metrics});
      assert.ok(metrics.scroll<=metrics.client+1,`horizontal overflow on ${browserName} in ${tabName} at ${viewportWidth}px: ${JSON.stringify(metrics)}`);
    }
    await page.setViewportSize({width:390,height:844});
  };
  const capture=async name=>{if(captureScreenshots)await page.screenshot({path:resolve("artifacts","planner-tabs",`${browserName}-${name}.png`),fullPage:true});};
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.locator("#panel-events").waitFor({state:"visible"});await checkMobileWidths("Événements");await capture("evenements");
  assert.equal(await page.locator('.planner-event-card[data-event-id="command-feeder"]').count(),0,
    `${browserName} command-center objectives are nested under their wrapper instead of duplicated in the event list`);
  await page.locator('button[data-action="select"][data-event-id="command-wrapper"]').click();
  await page.locator("#selected-event h2").filter({hasText:"Poste de commandement de test"}).waitFor();
  await page.getByRole("heading",{name:"Séries d’objectifs en cours"}).waitFor();
  await page.getByText("Compteurs connus : 1/2",{exact:false}).waitFor();
  assert.equal(apiCalls.filter(call=>call.resource==="detail"&&call.eventId==="command-feeder").length,0,
    `${browserName} showing command-center feeders reuses the existing event list without requesting feeder details`);
  await page.locator('#selected-event button[data-action="select-feeder"][data-event-id="command-feeder"]').click();
  await page.locator("#selected-event h2").filter({hasText:"Poste de commandement de test"}).waitFor();
  const detailCalls=apiCalls.filter(call=>call.resource==="detail");
  assert.deepEqual(detailCalls.map(({eventId,lang})=>({eventId,lang})),[{eventId:"command-feeder",lang:"fr"}],`${browserName} a single selected command-center series uses one French detail request`);
  await page.locator('#selected-event button[data-action="back-list"]').click();
  await page.locator('button[data-action="select"][data-event-id="command-wrapper"]').click();
  await page.locator('#selected-event button[data-action="select-feeder"][data-event-id="command-feeder"]').click();
  assert.equal(apiCalls.filter(call=>call.resource==="detail").length,1,`${browserName} reopening the same command-center series does not request details again`);
  await page.locator('#selected-event button[data-action="back-list"]').click();
  await checkMobileWidths("Poste de commandement");await capture("poste-commandement");
  await page.locator('button[data-action="select"][data-event-id="planner-test"]').click();
  await page.locator("#selected-event h2").filter({hasText:"Événement de test"}).waitFor();
  await page.getByRole("tab",{name:"Objectifs"}).click();
  await page.locator("#objectives-view .objective-group").first().waitFor();
  const loginObjective=page.locator("#objectives-view").getByText("Connexion quotidienne",{exact:true}).first();
  if(!(await loginObjective.isVisible()))await page.locator("#objectives-view .objective-completed-summary").first().click();
  await loginObjective.waitFor();
  const unknownProgressRow=page.locator("#objectives-view .action-row").filter({hasText:"Progression : données indisponibles"}).first();
  await unknownProgressRow.waitFor();
  await unknownProgressRow.getByText(/7\/8 étoiles jaunes/).waitFor();
  assert.equal(await unknownProgressRow.getByRole("progressbar").count(),0,`${browserName} unknown objective progress is not rendered as a zero-valued bar`);
  assert.equal(await page.locator("#objectives-view .objective-group-portrait").count(),1,`${browserName} multiple objectives share one character portrait`);
  await page.locator("#objectives-view [role=progressbar]").first().waitFor();await checkMobileWidths("Objectifs");await capture("objectifs");
  await page.getByRole("tab",{name:"Planifier"}).click();
  await page.getByRole("heading",{name:"Événement planifié"}).waitFor();await checkMobileWidths("Planifier");await capture("planifier");
  await page.getByRole("tab",{name:"Mon inventaire"}).click();
  await page.getByRole("heading",{name:"Ressources MSF"}).waitFor();await checkMobileWidths("Mon inventaire");await capture("mon-inventaire");
  await page.locator(".inventory-quantity").filter({hasText:"0"}).first().waitFor();
  assert.equal(await page.locator(".inventory-technical").count(),0,`${browserName} player inventory contains no technical diagnostics`);
  assert.ok(await page.locator("#inventory-priority").getByText("Certaines quantités ne sont pas disponibles.",{exact:true}).count()>0,`${browserName} missing inventory quantities are summarized without being converted to zero`);
  assert.equal(await page.locator("#inventory-priority .inventory-quantity").filter({hasText:"Inconnue"}).count(),0,`${browserName} unavailable resource groups do not repeat one unknown label for every catalog entry`);
  assert.equal(await page.getByText("English Technical Name",{exact:true}).count(),0,`${browserName} raw English inventory names are not presented as French`);
  assert.equal(await page.locator("#inventory-priority .inventory-row").filter({hasText:"Module d’entraînement N4"}).count(),1,`${browserName} French module appears once in the player inventory`);
  assert.equal(await page.locator("#inventory-iso-matrix").getByText(/ISOITEM_/).count(),0,`${browserName} crystal identifiers stay out of the player matrix`);
  assert.equal(await page.locator("#panel-stock").getByText(/diagnostic|référentiel|non classifiés|identifiants reconnus/i).count(),0,`${browserName} player inventory contains no developer terminology`);
  assert.equal(await page.locator("#panel-stock").getByText(/ISOITEM_|CONSUMABLE_|Identifiant|Cache/i).count(),0,`${browserName} player inventory exposes no provider IDs or cache details`);
  await page.locator("#inventory-iso-matrix select[aria-label='Palier ISO-8 des cristaux']").selectOption("P4");
  await page.locator("#inventory-iso-matrix select[aria-label='Niveau des cristaux ISO-8']").selectOption("1");
  const isoRow=page.locator(".iso-matrix tbody tr").filter({hasText:"Tireur"});
  assert.deepEqual(await page.locator(".iso-matrix thead th").allTextContents(),["Classe","Vie","Dégâts","Armure","Focalisation","Résistance","Niveau accessible"]);
  assert.deepEqual(await page.locator(".iso-matrix tbody tr th").allTextContents(),["Cogneur","Tireur","Contrôleur","Protecteur","Soutien"]);
  assert.deepEqual(await isoRow.locator("td").evaluateAll(cells=>cells.map(cell=>cell.childNodes[0].textContent.trim())),["16","26","17","42","16","Niv. 16"],`${browserName} the owner-provided P4 level-1 matrix totals 117 crystals`);
  const matrixScroll=await page.locator(".iso-matrix-scroll").evaluate(element=>({scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,firstColumn:getComputedStyle(element.querySelector("th:first-child")).position}));
  assert.ok(matrixScroll.scrollWidth>matrixScroll.clientWidth,`${browserName} ISO-8 matrix remains horizontally scrollable on mobile`);
  assert.equal(matrixScroll.firstColumn,"sticky",`${browserName} ISO-8 class names remain fixed during horizontal scroll`);
  await capture("matrice-iso-p4-n1");
  const stickyGeometry=await page.locator(".iso-matrix-scroll").evaluate(element=>{
    element.scrollLeft=element.scrollWidth;
    const outer=element.getBoundingClientRect(),first=element.querySelector("tbody th").getBoundingClientRect();
    return {outerLeft:outer.left,firstLeft:first.left,scrollLeft:element.scrollLeft};
  });
  assert.ok(stickyGeometry.scrollLeft>0,`${browserName} horizontal swipe reaches the remaining crystal categories`);
  assert.ok(Math.abs(stickyGeometry.outerLeft-stickyGeometry.firstLeft)<=1,`${browserName} class labels stay visible after swiping the ISO-8 matrix`);
  if(captureScreenshots)await page.locator(".iso-matrix-scroll").screenshot({path:resolve("artifacts","planner-tabs",`${browserName}-matrice-iso-p4-n1-apres-defilement.png`)});
  await page.locator(".iso-matrix-scroll").evaluate(element=>element.scrollLeft=0);
  await page.locator("#stock-view").getByRole("button",{name:"Enregistrer la déclaration"}).waitFor();
  const inventoryCallsBeforeRepaint=apiCalls.filter(call=>call.resource==="inventory").length;
  await page.getByRole("button",{name:"Réafficher l’inventaire"}).click();
  assert.equal(apiCalls.filter(call=>call.resource==="inventory").length,inventoryCallsBeforeRepaint,`${browserName} inventory repaint reuses the first read instead of requesting again`);
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  assert.ok((await page.locator("#tab-events").getAttribute("class")).includes("ev-stat"));
  assert.equal(await page.getByText(/Équipe synchronisée le/).count(),1,`${browserName} displays the roster's last synchronization time in French`);
  assert.deepEqual(consoleErrors,[],`${browserName} console errors before simulated provider failure`);
  await page.getByRole("tab",{name:"Mon inventaire"}).click();
  const manualInput=page.locator("#stock-view input[data-stock-key]").first();
  await manualInput.fill("12345");
  await page.locator('#stock-view button[data-action="save-stock"]').first().click();
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.locator('#selected-event button[data-action="back-list"]').click();
  await page.locator("#event-list-view").waitFor({state:"visible"});
  await page.locator('button[data-action="skip"][data-event-id="campaign-test"]').click();
  const savedForA=await page.evaluate(()=>localStorage.getItem("losp-event-planner-v1:"+"a".repeat(64)));
  const parsedForA=JSON.parse(savedForA||"{}");
  assert.ok(savedForA?.includes("campaign-test"),`${browserName} account A ignored event uses its session-scoped key`);
  assert.ok(Object.keys(parsedForA.stock||{}).length>0,`${browserName} account A manual stock is saved in its session-scoped key`);
  await page.evaluate(async()=>fetch("/__test/profile?namespace="+"b".repeat(64)));
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.locator('button[data-action="skip"][data-event-id="campaign-test"]').waitFor();
  const savedForB=await page.evaluate(()=>localStorage.getItem("losp-event-planner-v1:"+"b".repeat(64)));
  const parsedForB=JSON.parse(savedForB||"{}");
  assert.ok(savedForB&&!savedForB.includes("campaign-test"),`${browserName} switching accounts does not load account A ignored events`);
  assert.equal(Object.keys(parsedForB.stock||{}).length,0,`${browserName} switching accounts does not load account A manual stock`);
  const eventsBeforeDisconnect=apiCalls.filter(call=>call.resource==="events").length;
  await page.evaluate(async()=>fetch("/__test/profile?connected=false"));
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.getByRole("link",{name:"Connecter mon compte MSF"}).waitFor();
  assert.equal(apiCalls.filter(call=>call.resource==="events").length,eventsBeforeDisconnect,`${browserName} disconnect triggers no additional personal event requests`);
  await page.evaluate(async()=>fetch("/__test/profile?namespace="+"c".repeat(64)+"&connected=true"));
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.locator(".planner-event-card").first().waitFor();
  assert.ok(await page.evaluate(()=>Object.keys(localStorage).includes("losp-event-planner-v1:"+"a".repeat(64))),`${browserName} previous account preferences remain partitioned`);
  await page.evaluate(async()=>fetch("/__test/roster?missing=true"));
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.locator(".planner-event-card").first().waitFor();
  await page.locator('button[data-action="select"][data-event-id="planner-test"]').click();
  await page.locator("#selected-event").getByText("Personnages : indisponible",{exact:true}).waitFor();
  await page.getByRole("tab",{name:"Objectifs"}).click();
  await page.locator("#objectives-view").getByText(/équipe n’est pas disponible/i).first().waitFor();
  await page.getByRole("tab",{name:"Planifier"}).click();
  await page.locator("#plan-view").getByText(/ton équipe n’est pas disponible/i).first().waitFor();
  assert.equal(await page.getByText("Aucune ressource de stock n’est requise",{exact:true}).count(),0,`${browserName} unavailable roster is never misrepresented as a zero-resource plan`);
  assert.equal(await page.locator(".planner-diagnostic").count(),0,`${browserName} missing R2 roster exposes no technical diagnostic in the player view`);
  await page.evaluate(async()=>fetch("/__test/roster?missing=false"));
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.locator('#selected-event button[data-action="back-list"]').click();
  await page.getByRole("button",{name:"Actualiser"}).click();
  failEvents=true;
  await page.evaluate(async()=>fetch("/__test/profile?namespace="+"d".repeat(64)));
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.locator('#selected-event button[data-action="back-list"]').click();
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.getByText("Les événements ne sont pas disponibles pour le moment.",{exact:true}).waitFor();
  assert.equal(await page.locator(".planner-diagnostic").count(),0,`${browserName} provider diagnostics are not shown in the player interface`);
  assert.equal(await page.getByText(/event-list-unavailable|\/player\/v1\/events/).count(),0);
  assert.ok(apiCalls.some(call=>call.resource==="roster"));
  assert.ok(apiCalls.some(call=>call.resource==="inventory"&&call.itemType==="CONSUMABLE"&&call.lang==="fr"));
  assert.deepEqual(apiCalls.filter(call=>call.resource==="detail").map(call=>({eventId:call.eventId,lang:call.lang})),[{eventId:"command-feeder",lang:"fr"}]);
  assert.deepEqual(runtimeErrors,[],`${browserName} page errors`);
  assert.ok(consoleErrors.every(message=>/Failed to load resource: the server responded with a status of (404|502) \((?:Not Found|Bad Gateway)\)/.test(message)),
    `${browserName} only expected HTTP failure responses are logged during simulated unavailable-data checks`);
  console.log(JSON.stringify({browser:browserName,version:browser.version(),result:"passed",eligibleCards:3,apiCalls:apiCalls.length,mobileViewport:width}));
  await context.close();
}finally{
  await browser.close();
  await new Promise(resolveClose=>server.close(resolveClose));
}
