import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
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
    {cap:100,soFar:0,methods:[{description:"Spend Gold",points:1}]}
  ]},brackets:[{id:"default",objective:{progress:{points:10,completedTier:1,claimableTiers:[]},tiers:{
    1:{goal:10,rewards:{allOf:[]}},2:{goal:20,rewards:{allOf:[]}}
  }}}]}};
const frEvent={...enEvent,name:"Événement de test Maddoxx"};
const apiCalls=[];
let failEvents=false;
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  if(pathname.startsWith("/admin/api/event-planner")){
    const params=new URL(req.url,"http://localhost").searchParams,resource=params.get("resource");
    apiCalls.push({resource,lang:params.get("lang"),itemType:params.get("itemType")});
    let body;
    if(resource==="status")body={status:"connected",scopes:["m3p.f.pr.act","m3p.f.pr.ros","m3p.f.pr.inv"]};
    else if(resource==="events"&&failEvents){res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"provider-error",upstreamStatus:502,diagnostic:{endpoint:"/player/v1/events",httpStatus:502,providerCode:"event-list-unavailable",error:"provider-error",lang:params.get("lang"),page:1}}));return;}
    else if(resource==="events")body={status:"ok",data:[params.get("lang")==="fr"?frEvent:enEvent]};
    else if(resource==="roster")body={status:"ok",data:[{id:"CaptainAmerica",activeYellow:7,activeRed:0,gearTier:20,level:90,iso8:{active:"raider",raider:10}}]};
    else if(resource==="inventory")body={status:"ok",data:[{item:params.get("itemType")==="ISOITEM"?"ISO8-TIER-0-CURRENCY":"SC",quantity:0}]};
    else if(resource==="detail")body={status:"ok",data:params.get("lang")==="fr"?frEvent:enEvent};
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
    if(url.endsWith("msf-characters.json"))body=[{id:"CaptainAmerica",nameKey:"Captain America",nameEn:"Captain America",nameFr:"Captain America",portraitUrl:null,player_Character:true}];
    else if(url.endsWith("dd-character-traits.json"))body={characters:{CaptainAmerica:["Avenger"]}};
    else body={characters:{}};
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body),headers:{"Access-Control-Allow-Origin":"*"}});
  });
  await page.route("https://keryas777.github.io/msf/style.css*",route=>route.fulfill({status:200,contentType:"text/css",body:":root{--text:#eee;--muted:#aaa;--muted2:#888;--border:#444;--panel:#181818;--panel2:#222;--shadow:none;--toggle-on-bg:#292929}"}));
  await page.route("https://keryas777.github.io/msf/evenements.css*",route=>route.fulfill({status:200,contentType:"text/css",body:".ev-page{display:flex;flex-direction:column;width:100%;max-width:800px}.ev-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.ev-stat{display:flex;flex-direction:column}.ev-card{display:flex}.ev-cover{position:relative;flex:0 0 100px;min-height:135px}.ev-card-copy{flex:1;min-width:0}.ev-card h3{overflow-wrap:anywhere}.ev-section{display:flex;flex-direction:column}"}));
  await page.route("https://keryas777.github.io/msf/HeaderObjectifs.webp",route=>route.fulfill({status:200,contentType:"image/gif",body:Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=","base64")}));
  await page.goto(`http://127.0.0.1:${address.port}/admin/events-planner`,{waitUntil:"networkidle"});
  await page.locator("#selected-event h2").filter({hasText:"Événement de test Maddoxx"}).waitFor();
  await page.locator("#selected-event").getByText("Terminé confirmé").first().waitFor();
  await page.locator("#selected-event").getByText("Faisable gratuitement").first().waitFor();
  await page.getByRole("tab",{name:"Objectifs"}).click();
  await page.getByRole("heading",{name:"Terminés confirmés"}).waitFor();
  await page.getByRole("tab",{name:"Planifier"}).click();
  await page.getByRole("heading",{name:"Projection gratuite"}).waitFor();
  await page.getByRole("tab",{name:"Mon stock"}).click();
  await page.getByRole("heading",{name:"or",exact:true}).waitFor();
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  assert.ok(width.scroll<=width.client+1,`horizontal overflow on ${browserName}: ${JSON.stringify(width)}`);
  assert.ok((await page.locator("#tab-events").getAttribute("class")).includes("ev-stat"));
  failEvents=true;
  await page.getByRole("tab",{name:"Événements"}).click();
  await page.getByRole("button",{name:"Actualiser"}).click();
  await page.getByText("Diagnostic technique · propriétaire").waitFor();
  assert.equal(await page.getByText("/player/v1/events",{exact:true}).count(),1);
  await page.getByText("event-list-unavailable",{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator(".planner-diagnostic").textContent(),/private-test-token|Bearer/);
  assert.ok(apiCalls.some(call=>call.resource==="roster"));
  assert.ok(apiCalls.some(call=>call.resource==="inventory"&&call.itemType==="CONSUMABLE"));
  assert.ok(apiCalls.filter(call=>call.resource==="detail").length>=2);
  assert.deepEqual(runtimeErrors,[],`${browserName} page errors`);
  assert.deepEqual(consoleErrors,[],`${browserName} console errors`);
  console.log(JSON.stringify({browser:browserName,version:browser.version(),result:"passed",apiCalls:apiCalls.length,mobileViewport:width}));
  await context.close();
}finally{
  await browser.close();
  await new Promise(resolveClose=>server.close(resolveClose));
}
