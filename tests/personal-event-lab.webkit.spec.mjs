import assert from "node:assert/strict";
import {createServer} from "node:http";
import {webcrypto} from "node:crypto";
import {createRequire} from "node:module";
import {handlePersonalEventLab} from "../src/personal-event-lab.js";

const require=createRequire(import.meta.url);
const {webkit}=require("playwright");
const APP_ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const ACCESS_DOMAIN="lab-test.cloudflareaccess.com";
const ACCESS_AUD="a".repeat(32);
const SESSION="s".repeat(43);
const b64=value=>Buffer.from(typeof value==="string"?value:JSON.stringify(value)).toString("base64url");

async function accessCredentials(){
  const pair=await webcrypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const jwk=await webcrypto.subtle.exportKey("jwk",pair.publicKey);
  jwk.kid="webkit-lab-test";jwk.alg="RS256";jwk.use="sig";
  const header=b64({alg:"RS256",kid:jwk.kid,typ:"JWT"});
  const payload=b64({iss:"https://"+ACCESS_DOMAIN,aud:[ACCESS_AUD],email:"owner@example.test",
    iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+300});
  const signature=await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,
    new TextEncoder().encode(header+"."+payload));
  return {jwk,jwt:header+"."+payload+"."+Buffer.from(signature).toString("base64url")};
}

const scenarios=[
  {id:"event-no-progress",name:"Sans progression personnelle",type:"milestone",
    expected:/Progression non fournie par Scopely/,
    response:{data:{id:"event-no-progress",name:"Sans progression personnelle",type:"milestone",
      milestone:{brackets:[{id:"default",objective:{tiers:{}}}],scoring:{cappedScorings:[]}}}}},
  {id:"event-zero",name:"Objectif à zéro",type:"milestone",expected:/Actuel 0 \/ cible 10 · 0%/,
    response:{data:{id:"event-zero",name:"Objectif à zéro",type:"milestone",
      milestone:{brackets:[{id:"default",objective:{progress:0,target:10}}]}}}},
  {id:"event-partial",name:"Épreuve d’été — l’Œil d’Æra",type:"milestone",expected:/Actuel 5 \/ cible 10 · 50%/,
    response:{data:{id:"event-partial",name:"Épreuve d’été — l’Œil d’Æra",type:"milestone",score:37,
      milestone:{brackets:[{id:"default",name:"Défis d’élite",objective:{progress:5,target:10}}]}}}},
  {id:"event-complete",name:"Objectif terminé",type:"milestone",expected:/Objectif terminé · completed/,
    response:{data:{id:"event-complete",name:"Objectif terminé",type:"milestone",
      milestone:{brackets:[{id:"default",name:"Objectif terminé",objective:{progress:10,target:10}}]}}}},
  {id:"event-tiers",name:"Paliers multiples",type:"milestone",expected:/Paliers terminés prouvés : 1, 2 · Réclamables : 3/,
    response:{data:{id:"event-tiers",name:"Paliers multiples",type:"milestone",
      milestone:{completedTier:2,tiers:[{tier:1,rewards:[]},{tier:2,rewards:[]},{tier:3,rewards:[]}],
        claimableTiers:[3],brackets:[{id:"default",objective:{progress:20,target:30}}],
        scoring:{cappedScorings:[
          {id:"shared-points",name:"Points partagés",soFar:7,cap:20},
          {id:"shared-points",name:"Points partagés",soFar:7,cap:20},
          {id:"unknown-points",soFar:null,cap:10}
        ]}}}}},
  {id:"event-incomplete",name:"Compteurs incomplets",type:"milestone",expected:/inconnu/,
    response:{data:{id:"event-incomplete",name:"Compteurs incomplets",type:"milestone",
      milestone:{brackets:[
        {id:"null",objective:{progress:null,target:5}},
        {id:"missing",objective:{target:5}},
        {id:"absent"}
      ],scoring:{cappedScorings:[{cap:10},{soFar:null,cap:5},{soFar:"0",cap:8}]}}}}},
  {id:"event-empty",name:"Réponse vide",type:"milestone",expected:/Progression non fournie par Scopely/,
    response:{data:{id:"event-empty",name:"Réponse vide",type:"milestone",
      milestone:{brackets:[],scoring:{cappedScorings:[]},tiers:[],claimableTiers:[]}}}},
  {id:"event-nested",name:"Structure imbriquée inhabituelle",type:"milestone",expected:/Actuel 3 \/ cible 7 · 43%/,
    // `milestones` et l'enveloppe data.data sont traités comme cas de robustesse,
    // pas comme structures Scopely confirmées.
    response:{data:{data:{id:"event-nested",name:"Structure imbriquée inhabituelle",type:"milestone",
      milestones:[{id:"nested",brackets:[{id:"default",objective:{progress:3,target:7}}],
        scoring:{cappedScorings:[{id:"nested-shared",soFar:2,cap:9},{id:"nested-shared",soFar:2,cap:9}]},
        completedTier:1,tiers:[{tier:1},{tier:2}],claimableTiers:[{tier:2}]}]}}}},
  {id:"event-raid",name:"Raid d’appréhension — l’Épreuve du Crépuscule",type:"raid",expected:/Actuel 0 \/ cible 500 · 0%/,
    // Raid progression fields are intentionally hypothetical fixture data.
    response:{data:{id:"event-raid",name:"Raid d’appréhension — l’Épreuve du Crépuscule",type:"raid",
      milestone:{type:"alliance",brackets:[{id:"default",objective:{progress:0,target:500}}],
        scoring:{cappedScorings:[{id:"raid-score",soFar:0,cap:1000}]}}}}},
  {id:"event-slow",name:"Détail retardé",type:"milestone",expected:/Actuel 4 \/ cible 8 · 50%/,
    response:{data:{id:"event-slow",name:"Détail retardé",type:"milestone",
      milestone:{brackets:[{id:"default",objective:{progress:4,target:8}}]}}}}
];

// The large-list case uses a clearly synthetic padding property solely to
// exercise the 170–175 KB transport/render path. It is not a claimed API field.
const listEvents=[...scenarios.map(({id,name,type})=>({id,name,type})),
  ...Array.from({length:120-scenarios.length},(_,i)=>({id:`catalog-${i+1}`,name:`Événement fictif ${i+1}`,type:i%5===0?"raid":"milestone"}))];
for(const event of listEvents)event.fixturePadding="x".repeat(1650);
const firstPage=listEvents.slice(0,100);
let firstPageBytes=Buffer.byteLength(JSON.stringify({meta:{page:1,perPage:100,perTotal:listEvents.length},data:firstPage}));
firstPage[0].fixturePadding="x".repeat(Math.max(0,firstPage[0].fixturePadding.length+173_564-firstPageBytes));
firstPageBytes=Buffer.byteLength(JSON.stringify({meta:{page:1,perPage:100,perTotal:listEvents.length},data:firstPage}));

const {jwk,jwt}=await accessCredentials();
const upstreamCalls=[],pageBytes=[];
let releaseSlow,slowStartedResolve;
const slowGate=new Promise(resolve=>releaseSlow=resolve);
const slowStarted=new Promise(resolve=>slowStartedResolve=resolve);
const env={PERSONAL_EVENT_LAB_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:"owner@example.test",
  MSF_ADMIN_ENABLED:"true",MSF_ADMIN_EMAILS:"owner@example.test",CF_ACCESS_TEAM_DOMAIN:ACCESS_DOMAIN,
  CF_ACCESS_AUD:ACCESS_AUD,CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"c".repeat(64),
  CAPTAIN_BUCKET:{get:async()=>null,put:async()=>{},delete:async()=>{}},
  CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({
    status:"active",accessToken:"fixture-token",scope:"m3p.f.pr.act m3p.f.pr.ros m3p.f.pr.inv offline"})})}};

async function fixtureFetch(input){
  const url=new URL(String(input));
  if(url.hostname===ACCESS_DOMAIN)return Response.json({keys:[jwk]});
  upstreamCalls.push(url.pathname);
  if(url.pathname==="/player/v1/events"){
    const page=Number(url.searchParams.get("page")||1);
    const events=listEvents.slice((page-1)*100,page*100);
    const body={meta:{page,perPage:100,perTotal:listEvents.length},data:events};
    const bytes=Buffer.byteLength(JSON.stringify(body));pageBytes.push(bytes);
    return Response.json(body);
  }
  const eventId=decodeURIComponent(url.pathname.split("/").at(-1));
  if(eventId==="event-slow")slowStartedResolve();
  if(eventId==="event-slow")await slowGate;
  const scenario=scenarios.find(row=>row.id===eventId);
  if(scenario)return Response.json(scenario.response);
  return new Response("not found",{status:404});
}

const server=createServer(async(incoming,outgoing)=>{
  try{
    const chunks=[];for await(const chunk of incoming)chunks.push(chunk);
    const headers=new Headers(incoming.headers);
    // Browsers correctly refuse __Host- cookies over plain HTTP. Inject this
    // fake captain session at the local test server boundary instead.
    headers.set("Cookie","__Host-losp_captain_session="+SESSION);
    if(incoming.url?.includes("/api/query"))headers.set("Origin",APP_ORIGIN);
    const request=new Request("http://127.0.0.1"+(incoming.url||"/"),{
      method:incoming.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})
    });
    const response=await handlePersonalEventLab(request,env,fixtureFetch);
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){outgoing.writeHead(500);outgoing.end(String(error?.stack||error));}
});

const browser=await webkit.launch({headless:true});
try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();
  const context=await browser.newContext({extraHTTPHeaders:{"Cf-Access-Jwt-Assertion":jwt}});
  const page=await context.newPage();
  const runtimeErrors=[],consoleErrors=[],failedScripts=[],scriptResponses=[];
  page.on("pageerror",error=>runtimeErrors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")consoleErrors.push(message.text());});
  page.on("response",response=>{
    if(/personal-event-lab\/(client|progress-analysis)\.js/.test(response.url())){
      scriptResponses.push({url:response.url(),status:response.status()});
      if(!response.ok())failedScripts.push(response.url()+" HTTP "+response.status());
    }
  });
  page.on("requestfailed",request=>{
    if(/personal-event-lab\/(client|progress-analysis)\.js/.test(request.url()))failedScripts.push(request.url()+" "+request.failure()?.errorText);
  });
  await page.addInitScript(()=>{
    window.__labUnhandled=[];
    window.addEventListener("unhandledrejection",event=>window.__labUnhandled.push(String(event.reason?.message||event.reason)));
    window.addEventListener("error",event=>{
      if(event.filename?.includes("personal-event-lab"))window.__labUnhandled.push(event.message||"script-error");
    });
  });
  await page.goto("http://127.0.0.1:"+address.port+"/admin/personal-event-lab",{waitUntil:"networkidle"});
  const panel=page.locator("#progress-analysis");
  assert.equal(await panel.count(),1,"one analysis panel in served HTML");
  assert.equal(await page.locator('script[src="/admin/personal-event-lab/client.js"]').count(),1);
  assert.equal(await page.locator('script[src="/admin/personal-event-lab/progress-analysis.js"]').count(),1);
  await page.waitForFunction(()=>typeof window.__personalEventLabRenderProgress==="function");
  assert.equal(scriptResponses.length,2,"both actual Worker-served scripts returned a response");
  assert.ok(scriptResponses.every(response=>response.status===200));
  assert.match(await page.locator("#connection").innerText(),/Connecté/);

  await page.locator("#query").click();
  await page.waitForFunction(()=>document.querySelector("#events-select")?.options.length===121);
  assert.ok(firstPageBytes>=170_000&&firstPageBytes<=175_000,`synthetic first page size was ${firstPageBytes} bytes`);
  assert.equal(pageBytes.length,2,"the 120-event list is paginated over two responses");
  assert.equal(upstreamCalls.length,2,"the events list made two expected mocked calls");
  assert.ok((await page.locator("#response").innerText()).length>170_000,"large list is visible in raw response section");

  const select=page.locator("#events-select");
  for(const scenario of scenarios.slice(0,-1)){
    const before=upstreamCalls.length;
    await select.selectOption(scenario.id);
    await page.waitForFunction(id=>document.querySelector("#progress-analysis")?.innerText.includes(id),scenario.id);
    assert.equal(upstreamCalls.length,before,`selecting ${scenario.id} must be local`);
    assert.equal(await panel.getAttribute("data-analysis-error"),null,`caught analysis error for ${scenario.id}`);
    assert.doesNotMatch(await panel.innerText(),/Erreur locale pendant l’analyse/);
    await page.locator("#query").click();
    await page.waitForFunction(id=>document.querySelector("#response")?.innerText.includes(id),scenario.id);
    await page.waitForFunction(({id,expectation})=>{
      const root=document.querySelector("#progress-analysis");
      return root?.innerText.includes(id)&&root.innerText.match(new RegExp(expectation));
    },{id:scenario.id,expectation:scenario.expected.source});
    const text=await panel.innerText();
    assert.match(text,scenario.expected,scenario.id);
    assert.equal(await panel.getAttribute("data-analysis-error"),null,`analysis error flag for ${scenario.id}`);
    assert.doesNotMatch(text,/Erreur locale pendant l’analyse/);
    if(scenario.id==="event-tiers"){
      assert.equal(await panel.locator(".progress-card").count(),2,"duplicate capped scoring identity appears once");
      assert.equal(await panel.getByText(/Points partagés/).count(),1);
    }
    assert.equal(upstreamCalls.length,before+1,`one detail request for ${scenario.id}`);
  }

  // Change the selected event while a detail request is still in flight.
  // The arriving detail must be analyzed against its own returned event ID,
  // never filtered using the newer selection.
  await select.selectOption("event-slow");
  const beforeSlow=upstreamCalls.length;
  await page.locator("#query").click();
  await slowStarted;
  await select.selectOption("event-zero");
  assert.equal(upstreamCalls.length,beforeSlow+1,"selection changes do not start a request");
  releaseSlow();
  await page.waitForFunction(()=>document.querySelector("#response")?.innerText.includes("event-slow"));
  await page.locator("#progress-analysis").getByRole("heading",{name:/Détail retardé/}).waitFor();
  const delayedText=await panel.innerText();
  assert.match(delayedText,/Actuel 4 \/ cible 8 · 50%/);
  assert.doesNotMatch(delayedText,/Objectif à zéro/);
  assert.equal(await panel.getAttribute("data-analysis-error"),null);

  assert.equal(await panel.count(),1);
  assert.deepEqual(runtimeErrors,[],"no unhandled WebKit page errors");
  assert.deepEqual(consoleErrors,[],"no WebKit console errors");
  assert.deepEqual(failedScripts,[],"both served scripts load successfully");
  assert.deepEqual(await page.evaluate(()=>window.__labUnhandled),[],"no script errors or unhandled rejections");
  console.log(JSON.stringify({browser:"WebKit",version:browser.version(),result:"passed",
    detailScenarios:scenarios.length,listEvents:listEvents.length,listPageBytes:pageBytes,
    upstreamCalls:upstreamCalls.length,progressionCases:scenarios.slice(0,-1).length,
    delayedDetail:"passed",progressText:delayedText}));
  await context.close();
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
