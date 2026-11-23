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

const {jwk,jwt}=await accessCredentials();
const upstreamCalls=[];
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
  if(url.pathname==="/player/v1/events")return Response.json({meta:{page:1,perPage:100,perTotal:1},data:[
    {id:"event-fixture",name:"Événement de test"}
  ]});
  if(url.pathname==="/player/v1/events/event-fixture")return Response.json({data:{id:"event-fixture",
    name:"Détail de test",score:125,milestone:{brackets:[{id:"bracket",name:"Objectif test",
      objective:{progress:5,target:10}}]}}});
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
  const context=await browser.newContext({extraHTTPHeaders:{
    "Cf-Access-Jwt-Assertion":jwt
  }});
  const page=await context.newPage();
  const runtimeErrors=[],failedScripts=[],scriptResponses=[];
  page.on("pageerror",error=>runtimeErrors.push(error.message));
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
  assert.equal(await page.locator("#progress-analysis").count(),1,"one progress panel in served HTML");
  assert.equal(await page.locator('script[src="/admin/personal-event-lab/client.js"]').count(),1);
  assert.equal(await page.locator('script[src="/admin/personal-event-lab/progress-analysis.js"]').count(),1);
  await page.waitForFunction(()=>typeof window.__personalEventLabRenderProgress==="function");
  assert.equal(scriptResponses.length,2,"both actual Worker-served scripts returned a response");
  assert.ok(scriptResponses.every(response=>response.status===200));
  assert.match(await page.locator("#connection").innerText(),/Connecté/);

  await page.locator("#query").click();
  await page.waitForFunction(()=>document.querySelector("#events-select")?.options.length===2);
  assert.equal(upstreamCalls.length,1,"list request makes one upstream call");
  await page.locator("#events-select").selectOption("event-fixture");
  await page.locator("#progress-analysis").getByRole("heading",{name:/Événement de test/}).waitFor();
  assert.equal(upstreamCalls.length,1,"selecting an event runs analysis locally");

  await page.locator("#query").click();
  await page.locator("#progress-analysis").getByRole("heading",{name:/Détail de test/}).waitFor();
  await page.locator("#progress-analysis").getByText(/Actuel 5 \/ cible 10/).waitFor();
  assert.deepEqual(upstreamCalls,["/player/v1/events","/player/v1/events/event-fixture"]);
  assert.equal(await page.locator("#progress-analysis").count(),1);
  assert.deepEqual(runtimeErrors,[],"no unhandled WebKit page errors");
  assert.deepEqual(failedScripts,[],"both served scripts load");
  assert.deepEqual(await page.evaluate(()=>window.__labUnhandled),[],"no script errors or unhandled rejections");
  console.log(JSON.stringify({browser:"WebKit",version:browser.version(),result:"passed",
    upstreamCalls:upstreamCalls.length,progressText:await page.locator("#progress-analysis").innerText()}));
  await context.close();
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
