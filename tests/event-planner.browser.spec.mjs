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
const enEvent={id:"planner-test",name:"Maddoxx Planner Test",type:"milestone",startTime:now-3600,endTime:now+86400,
  milestone:{type:"solo",scoring:{methods:[],cappedScorings:[
    {cap:10,soFar:5,methods:[{description:"Play Blitz with Captain America at 7 Yellow Stars",points:5}]},
    {cap:1,soFar:1,methods:[{description:"Daily Login",points:1}]},
    {cap:5,methods:[{description:"Play Blitz with Captain America at 8 Yellow Stars",points:1}]},
    {cap:100,soFar:0,methods:[{description:"Spend Gold",points:1}]}
  ]},brackets:[{id:"default",objective:{progress:{points:10,completedTier:1,claimableTiers:[]},tiers:{
    1:{goal:10,rewards:{allOf:[]}},2:{goal:20,rewards:{allOf:[]}}
  }}}]}};
const frEvent={...enEvent,name:"Événement de test Maddoxx"};
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
const snapshot={events:[calendarEvent,campaign,trial,...hiddenEvents],updatedAt:new Date().toISOString(),pages:1,locale:"fr",localizationStatus:"verified"};
const privateById=new Map([[enEvent.id,enEvent],[campaign.id,campaign],[trial.id,trial],...hiddenEvents.map(item=>[item.id,item])]);
const apiCalls=[];
const captureScreenshots=process.env.CAPTURE_SCREENSHOTS==="1";
if(captureScreenshots)await mkdir(resolve("artifacts","planner-tabs"),{recursive:true});
let failEvents=false;
let currentNamespace="a".repeat(64),currentConnected=true;
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(pathname==="/__test/profile"){const params=new URL(req.url,"http://localhost").searchParams;currentNamespace=params.get("namespace")||currentNamespace;currentConnected=params.get("connected")!=="false";res.writeHead(204);res.end();return;}
  if(pathname.startsWith("/admin/api/event-planner")){
    const params=new URL(req.url,"http://localhost").searchParams,resource=params.get("resource");
    apiCalls.push({resource,lang:params.get("lang"),itemType:params.get("itemType"),eventId:params.get("eventId")});
    let body;
    if(resource==="status")body=currentConnected?{status:"connected",storageNamespace:currentNamespace,scopes:["m3p.f.pr.act","m3p.f.pr.ros","m3p.f.pr.inv"]}:{status:"disconnected",reason:"session-revoked"};
    else if(!currentConnected){res.writeHead(403,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"disconnected"}));return;}
    else if(resource==="events"&&failEvents){res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"provider-error",upstreamStatus:502,diagnostic:{endpoint:"/player/v1/events",httpStatus:502,providerCode:"event-list-unavailable",error:"provider-error",lang:params.get("lang"),page:1}}));return;}
    else if(resource==="events")body={status:"ok",data:[...privateById.values()].map(item=>item.id===enEvent.id&&params.get("lang")==="fr"?frEvent:item)};
    else if(resource==="roster")body={status:"ok",data:[{id:"CaptainAmerica",activeYellow:7,activeRed:0,gearTier:20,level:90,iso8:{active:"raider",raider:10}}]};
    else if(resource==="inventory")body={status:"ok",retrievedAt:new Date().toISOString(),upstream:{asOf:"inventory-test"},data:params.get("itemType")==="ISOITEM"?[{item:"ISO8-TIER-0-CURRENCY",quantity:0},{item:"ISO8-TIER-1-A-CURRENCY",quantity:125}]:[{item:"SC",quantity:0},{item:"CONSUMABLE_XPLVL80",quantity:24},{item:"UNMAPPED_ITEM",name:"English Technical Name",icon:art}]};
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
    const type=extension==="html"?"text/html; charset=utf-8":extension==="css"?"text/css; charset=utf-8":"text/javascript; charset=utf-8";
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
    else if(url.endsWith("msf-resource-catalog.json"))body={items:[
      {id:"SC",names:{fr:"Or"},group:"gold",priority:true,sortOrder:1,categoryLabelFr:"Monnaie"},
      {id:"HC",names:{fr:"Noyaux d’énergie"},group:"cores",priority:true,sortOrder:2,categoryLabelFr:"Monnaie"},
      {id:"CONSUMABLE_XPLVL80",names:{fr:"Module d’entraînement N4"},group:"training",priority:true,sortOrder:3,icon:"https://assets.marvelstrikeforce.com/imgs/ICON_CONSUMABLE_XPLVL80_4ae2e7af.png",categoryLabelFr:"Progression"},
      {id:"ISO8-TIER-0-CURRENCY",names:{fr:"Ions P1"},group:"iso8Ions",priority:true,sortOrder:4,categoryLabelFr:"Ions ISO-8"},
      {id:"ISO8-TIER-1-A-CURRENCY",names:{fr:"Ions P2 niveau 1"},group:"iso8Ions",priority:true,sortOrder:5,categoryLabelFr:"Ions ISO-8"}
    ]};
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
  await page.locator(".planner-event-card").first().waitFor({state:"attached"});
  assert.equal(await page.locator(".planner-event-card").count(),3,`${browserName} should use only public-calendar eligible current events`);
  assert.equal(await page.getByText("Passe de combat",{exact:true}).count(),0);
  assert.equal(await page.getByText("Jalon passé",{exact:true}).count(),0);
  assert.equal(await page.getByText("First S.T.R.I.K.E.",{exact:true}).count(),0);
  try{await page.locator("#selected-event h2").filter({hasText:"Événement de test Maddoxx"}).waitFor({timeout:8000});}catch(error){console.error("DETAIL_RENDER_DIAGNOSTIC",JSON.stringify({runtimeErrors,consoleErrors,apiCalls,selected:await page.locator("#selected-event").innerText().catch(()=>""),status:await page.locator("#selected-event [role=status]").innerText().catch(()=>""),eventCount:await page.locator("#event-count").innerText().catch(()=>""),events:await page.locator("#events-list").innerText().catch(()=>""),connection:await page.locator("#connection").innerText().catch(()=>""),url:page.url()}));throw error;}
  assert.equal(await page.locator("#event-list-view").isHidden(),true,`${browserName} direct eventId link opens the matching event fiche`);
  assert.deepEqual(apiCalls.filter(call=>call.resource==="detail").map(call=>call.eventId),["planner-test","planner-test"],`${browserName} direct link requests only the selected public-calendar event`);
  await page.locator(`#selected-event button[data-action="back-list"]`).click();
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner?eventId=future-test`,{waitUntil:"networkidle"});
  await page.getByText("Cet événement ne figure pas dans le calendrier LoSP actif ou est ignoré.",{exact:false}).waitFor();
  assert.equal(apiCalls.filter(call=>call.resource==="detail").length,2,`${browserName} filtered event deep links never fetch personal details`);
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner`,{waitUntil:"networkidle"});
  await page.locator(".planner-event-card").first().waitFor();
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  const selectButton=page.locator('button[data-action="select"][data-event-id="planner-test"]');
  await selectButton.scrollIntoViewIfNeeded();
  const savedScroll=await page.evaluate(()=>window.scrollY);
  const savedHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
  await selectButton.click();
  await page.locator("#selected-event [role=status]").waitFor();
  await page.locator("#selected-event h2").filter({hasText:"Événement de test Maddoxx"}).waitFor();
  await page.locator("#selected-event").getByText("Terminé confirmé").first().waitFor();
  await page.locator("#selected-event").getByText("Faisable gratuitement").first().waitFor();
  await page.getByRole("button",{name:"Planifier cet événement"}).click();
  await page.getByRole("heading",{name:"Événement planifié"}).waitFor();
  assert.equal(await page.locator("#plan-event-name").textContent(),"Événement de test Maddoxx");
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
  assert.equal(await page.locator(".planner-event-card").count(),3,`${browserName} skipped event restored`);
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
  await page.getByRole("tab",{name:"Mon stock"}).click();
  await page.getByRole("heading",{name:"Inventaire synchronisé Scopely"}).waitFor();await checkMobileWidths("Mon stock");await capture("mon-stock");
  await page.locator(".inventory-quantity").filter({hasText:"0"}).first().waitFor();
  assert.ok(await page.locator(".inventory-technical").count()>=4,`${browserName} item IDs are available only in expandable diagnostics`);
  await page.getByText("Non communiqué",{exact:true}).waitFor();
  assert.equal(await page.getByText("English Technical Name",{exact:true}).count(),0,`${browserName} raw English inventory names are not presented as French`);
  await page.getByText("Module d’entraînement N4",{exact:true}).waitFor();
  await page.getByText("Matrice indisponible : aucune définition publique archivée",{exact:false}).waitFor();
  await page.locator("#inventory-search").fill("libellé français");
  assert.equal(await page.locator("#synced-inventory .inventory-row").count(),1,`${browserName} inventory search uses the French fallback, not technical identifiers`);
  await page.locator("#inventory-search").fill("");
  await page.locator("#inventory-family").selectOption("ISOITEM");
  assert.equal(await page.locator("#synced-inventory .inventory-row").count(),2,`${browserName} inventory family filter works`);
  await page.locator("#inventory-family").selectOption("all");
  await page.locator("#stock-view").getByRole("button",{name:"Enregistrer la déclaration"}).waitFor();
  await page.getByRole("button",{name:"Actualiser l’inventaire"}).click();
  assert.ok(apiCalls.filter(call=>call.resource==="inventory").length>=4,`${browserName} refresh reads both inventory families`);
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  assert.ok((await page.locator("#tab-events").getAttribute("class")).includes("ev-stat"));
  assert.deepEqual(consoleErrors,[],`${browserName} console errors before simulated provider failure`);
  await page.getByRole("tab",{name:"Mon stock"}).click();
  const manualInput=page.locator("#stock-view input[data-stock-key]").first();
  await manualInput.fill("12345");
  await page.locator('#stock-view button[data-action="save-stock"]').first().click();
  await page.getByRole("tab",{name:"Événements"}).click();
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
  await page.getByRole("button",{name:"Autoriser LoSP avec Scopely"}).waitFor();
  assert.equal(apiCalls.filter(call=>call.resource==="events").length,eventsBeforeDisconnect,`${browserName} disconnect triggers no additional personal event requests`);
  await page.evaluate(async()=>fetch("/__test/profile?namespace="+"c".repeat(64)+"&connected=true"));
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.locator(".planner-event-card").first().waitFor();
  assert.ok(await page.evaluate(()=>Object.keys(localStorage).includes("losp-event-planner-v1:"+"a".repeat(64))),`${browserName} previous account preferences remain partitioned`);
  failEvents=true;
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.getByText("Diagnostic technique · propriétaire").waitFor();
  await page.locator(".planner-diagnostic summary").click();
  assert.equal(await page.getByText("/player/v1/events",{exact:true}).count(),1);
  await page.getByText("event-list-unavailable",{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator(".planner-diagnostic").textContent(),/private-test-token|Bearer/);
  assert.ok(apiCalls.some(call=>call.resource==="roster"));
  assert.ok(apiCalls.some(call=>call.resource==="inventory"&&call.itemType==="CONSUMABLE"&&call.lang==="fr"));
  assert.ok(apiCalls.filter(call=>call.resource==="detail").length>=2);
  assert.deepEqual(runtimeErrors,[],`${browserName} page errors`);
  assert.equal(consoleErrors.length,2,`${browserName} simulated provider responses`);
  assert.ok(consoleErrors.every(error=>error.includes("502 (Bad Gateway)")),`${browserName} unexpected console errors`);
  console.log(JSON.stringify({browser:browserName,version:browser.version(),result:"passed",eligibleCards:3,apiCalls:apiCalls.length,mobileViewport:width}));
  await context.close();
}finally{
  await browser.close();
  await new Promise(resolveClose=>server.close(resolveClose));
}
