import assert from "node:assert/strict";
import {createRequire} from "node:module";

const require=createRequire(import.meta.url);
const {chromium,webkit}=require("playwright");
const browserName=process.env.BROWSER||"webkit";
const browserType=browserName==="chromium"?chromium:webkit;
const pagesOrigin="https://keryas777.github.io";
const pagesUrl=pagesOrigin+"/msf/planner-auth-proof.html";
const workerOrigin="https://losp-roster-service.deliriousfan7.workers.dev";
const apiUrl=workerOrigin+"/admin/api/planner-auth-proof";
const ticket="synthetic-one-time-owner-ticket";
const cookieName="__Host-losp_captain_session";
let topLevelCookie=null,directFetchCookie=null,apiTicketHeader=null,preflight=false;
const browser=await browserType.launch({headless:true});
try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  await context.route(pagesOrigin+"/msf/planner-auth-proof.html",route=>route.fulfill({status:200,contentType:"text/html",body:`<!doctype html><html><body>
    <button id="open" type="button">Ouvrir le service sécurisé</button>
    <script>
      const workerOrigin=${JSON.stringify(workerOrigin)},apiUrl=${JSON.stringify(apiUrl)},pagesOrigin=${JSON.stringify(pagesOrigin)};
      window.__proof={};
      document.getElementById("open").addEventListener("click",()=>{window.__proof.openAttempted=true;window.__proof.openReturned=Boolean(window.open(workerOrigin+"/admin/planner-ticket-proof","maddoxx-proof","popup"));});
      window.addEventListener("message",async event=>{
        if(event.origin!==workerOrigin||event.data?.type!=="planner-ticket-proof")return;
        const received=event.data.ticket;
        window.__proof.ticketFromExpectedOrigin=true;
        window.__proof.ticketInUrl=location.href.includes(received);
        window.__proof.ticketInLocalStorage=Object.values(localStorage).some(value=>String(value).includes(received));
        try{
          const response=await fetch(apiUrl,{credentials:"include",headers:{"X-LoSP-Planner-Ticket":received}});
          window.__proof.ticketRequestStatus=response.status;
          window.__proof.ticketResponse=await response.json();
        }catch(error){window.__proof.ticketError=String(error);}
      });
      fetch(apiUrl,{credentials:"include"}).then(response=>{window.__proof.directStatus=response.status;return response.json();})
        .then(value=>window.__proof.directResponse=value).catch(error=>window.__proof.directError=String(error));
    </script></body></html>`}));
  await context.route(workerOrigin+"/**",async route=>{
    const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();
    if(url.pathname==="/admin/planner-cookie-bootstrap"){
      return route.fulfill({status:200,contentType:"text/html",headers:{"Set-Cookie":cookieName+"=SYNTHETIC_CAPTAIN_SESSION_ONLY; Path=/; Secure; HttpOnly; SameSite=Lax"},body:"<!doctype html><title>Cookie bootstrap</title>"});
    }
    if(url.pathname==="/admin/planner-ticket-proof"){
      topLevelCookie=headers.cookie||null;
      if(topLevelCookie?.includes(cookieName+"=")){
        return route.fulfill({status:200,contentType:"text/html",body:`<!doctype html><html><body><script>
          window.opener.postMessage({type:"planner-ticket-proof",ticket:${JSON.stringify(ticket)}},${JSON.stringify(pagesOrigin)});
        </script>Session propriétaire de démonstration</body></html>`});
      }
      return route.fulfill({status:403,body:"denied"});
    }
    if(request.method()==="OPTIONS"){
      preflight=true;
      return route.fulfill({status:204,headers:{
        "Access-Control-Allow-Origin":pagesOrigin,"Access-Control-Allow-Credentials":"true",
        "Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"X-LoSP-Planner-Ticket",
        "Access-Control-Max-Age":"60","Vary":"Origin"
      }});
    }
    if(url.pathname==="/admin/api/planner-auth-proof"){
      const cors={"Access-Control-Allow-Origin":pagesOrigin,"Access-Control-Allow-Credentials":"true","Vary":"Origin","Content-Type":"application/json"};
      directFetchCookie=headers.cookie||null;
      apiTicketHeader=headers["x-losp-planner-ticket"]||null;
      if(apiTicketHeader===ticket)return route.fulfill({status:200,headers:cors,body:JSON.stringify({authorized:true,kind:"synthetic-ticket"})});
      return route.fulfill({status:401,headers:cors,body:JSON.stringify({authorized:false,reason:"no-owner-ticket"})});
    }
    return route.fulfill({status:404,body:"not found"});
  });
  const bootstrap=await context.newPage();await bootstrap.goto(workerOrigin+"/admin/planner-cookie-bootstrap",{waitUntil:"load"});
  await context.addCookies([{name:cookieName,value:"SYNTHETIC_CAPTAIN_SESSION_ONLY",url:workerOrigin,secure:true,httpOnly:true,sameSite:"Lax"}]);await bootstrap.close();
  const page=await context.newPage();await page.goto(pagesUrl,{waitUntil:"load"});
  await page.waitForFunction(()=>window.__proof?.directStatus!==undefined||window.__proof?.directError!==undefined);
  assert.equal(directFetchCookie,null,`${browserName}: SameSite=Lax captain cookie is absent from the cross-site fetch`);
  const popupOpened=context.waitForEvent("page",{timeout:10000}).catch(()=>null);
  await page.locator("#open").waitFor({state:"visible"});await page.locator("#open").click();
  const popup=await popupOpened;
  if(!popup)throw new Error(`${browserName}: named ticket window did not open; opener state ${JSON.stringify(await page.evaluate(()=>window.__proof))}`);
  await popup.waitForLoadState("load");
  assert.equal(await popup.evaluate(()=>Boolean(window.opener)),true,`${browserName}: opener is explicitly retained for the one-time-ticket proof`);
  assert.ok(topLevelCookie?.includes(cookieName+"="),`${browserName}: first-party Worker navigation receives its host-only session cookie`);
  await page.waitForFunction(()=>window.__proof?.ticketRequestStatus!==undefined||window.__proof?.ticketError!==undefined);
  assert.equal(await page.evaluate(()=>window.__proof.ticketRequestStatus),200,`${browserName}: exact-origin ticket API request succeeds (${JSON.stringify(await page.evaluate(()=>window.__proof))})`);
  assert.equal(apiTicketHeader,ticket);
  assert.equal(await page.evaluate(()=>window.__proof.ticketRequestStatus),200);
  assert.equal(await page.evaluate(()=>window.__proof.ticketFromExpectedOrigin),true);
  assert.equal(await page.evaluate(()=>window.__proof.ticketInUrl),false);
  assert.equal(await page.evaluate(()=>window.__proof.ticketInLocalStorage),false);
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
  console.log(JSON.stringify({browser:browserName,version:browser.version(),result:"passed",directFetchCookie:"absent",topLevelWorkerCookie:"present",syntheticTicket:"memory-only-header",personalApiCalls:0}));
  await context.close();
}finally{await browser.close();}
