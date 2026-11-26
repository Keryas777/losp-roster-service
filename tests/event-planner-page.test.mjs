import {accessJwt,accessFetch,ACCESS_OWNER} from "./event-planner/access-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {handleEventPlannerPage} from "../src/event-planner-page.js";
import {readFile,readdir} from "node:fs/promises";
import {dirname,join,normalize,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const PLANNER_ASSET_ROOT=resolve(fileURLToPath(new URL("../public/event-planner/",import.meta.url)));
async function javascriptAssets(directory=PLANNER_ASSET_ROOT){
  const entries=await readdir(directory,{withFileTypes:true});
  const nested=await Promise.all(entries.map(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?javascriptAssets(path):entry.isFile()&&entry.name.endsWith(".js")
      ?Promise.resolve([path]):Promise.resolve([]);
  }));
  return nested.flat();
}


const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const OWNER_JWT=await accessJwt(ACCESS_OWNER);
const SESSION="s".repeat(43);
function envFor(status="active"){
  let assetCalls=0;
  return {assetCalls:()=>assetCalls,env:{EVENT_PLANNER_ENABLED:"true",PERSONAL_EVENT_LAB_ADMIN_EMAIL:ACCESS_OWNER,
    MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:"planner-test.cloudflareaccess.com",CF_ACCESS_AUD:"a".repeat(32),
    MSF_ADMIN_EMAILS:ACCESS_OWNER,CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
    CAPTAIN_BUCKET:{get:async()=>null,put:async()=>{},delete:async()=>{}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName:key=>key,get:()=>({fetch:async()=>Response.json({status})})},
    ASSETS:{fetch:async request=>{assetCalls++;return new Response("<!doctype html><h1>Planner asset</h1><script type=module src=\"/admin/events-planner/app.js\"></script>",{headers:{"Content-Type":"text/html"}});}}}};
}

test("planner shell requires owner Access and an existing captain session before serving assets",async()=>{
  const f=envFor("active");
  const anonymous=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner"),f.env,accessFetch());
  assert.equal(anonymous.status,403);assert.equal(f.assetCalls(),0);
  const noCaptain=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner",{
    headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT}}),f.env,accessFetch());
  assert.equal(noCaptain.status,200);
  const noCaptainText=await noCaptain.text();assert.match(noCaptainText,/Aucun compte MSF n’est connecté/);assert.doesNotMatch(noCaptainText,/Scopely|OAuth|jeton/i);
  assert.match(noCaptainText,/admin\/login\/captain\?returnTo=events-planner/);
  assert.equal(f.assetCalls(),0);
  assert.equal(noCaptain.headers.get("Cache-Control"),"private, no-store, max-age=0");
});

test("connected same-origin session receives the page with private no-store headers",async()=>{
  const f=envFor("active");
  const response=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner",{headers:{"Cf-Access-Jwt-Assertion":OWNER_JWT,Cookie:"__Host-losp_captain_session="+SESSION}}),f.env,accessFetch());
  assert.equal(response.status,200);assert.match(await response.text(),/Planner asset/);
  assert.equal(f.assetCalls(),1);assert.equal(response.headers.get("X-Robots-Tag"),"noindex");
  assert.match(response.headers.get("Content-Security-Policy"),/connect-src 'self' https:\/\/keryas777\.github\.io/);
  assert.match(response.headers.get("Content-Security-Policy"),/style-src 'self' https:\/\/keryas777\.github\.io/);
  assert.match(response.headers.get("Content-Security-Policy"),/img-src 'self' https:\/\/assets\.marvelstrikeforce\.com https:\/\/keryas777\.github\.io/);
});

test("planner asset path traversal and unsupported files are denied",async()=>{
  const f=envFor("active"),headers={"Cf-Access-Jwt-Assertion":OWNER_JWT,Cookie:"__Host-losp_captain_session="+SESSION};
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner/../../captain-vault.js",{headers}),f.env,accessFetch())).status,404);
  assert.equal((await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner/private.json",{headers}),f.env,accessFetch())).status,404);
  assert.equal(f.assetCalls(),0);
});


test("every shipped planner JavaScript module is served through the authenticated Worker route",async()=>{
  const modules=(await javascriptAssets()).map(path=>path.slice(PLANNER_ASSET_ROOT.length+1)).sort();
  assert.ok(modules.includes("app.js"),"planner entry module exists");
  const entryHtml=await readFile(join(PLANNER_ASSET_ROOT,"index.html"),"utf8");
  const entryMatch=entryHtml.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i);
  assert.ok(entryMatch,"planner HTML declares its module entry");
  assert.ok(entryMatch[1].endsWith("/app.js"),"planner HTML points to the app module");

  for(const modulePath of modules){
    const code=await readFile(join(PLANNER_ASSET_ROOT,modulePath),"utf8");
    const imports=code.matchAll(/^\s*(?:import|export)\s+[^;\n]*?\s+from\s*["']([^"']+)["']/gm);
    for(const match of imports){
      if(!match[1].startsWith("."))continue;
      const dependency=normalize(join(dirname(modulePath),match[1]));
      assert.ok(modules.includes(dependency),modulePath+" imports missing module "+dependency);
    }
  }

  const f=envFor("active"),headers={"Cf-Access-Jwt-Assertion":OWNER_JWT,
    Cookie:"__Host-losp_captain_session="+SESSION};
  f.env.ASSETS={fetch:async request=>{
    const pathname=new URL(request.url).pathname;
    if(!pathname.startsWith("/event-planner/"))return new Response("Not Found",{status:404});
    const asset=pathname.slice("/event-planner/".length);
    const file=resolve(PLANNER_ASSET_ROOT,asset);
    if(!file.startsWith(PLANNER_ASSET_ROOT+"/"))return new Response("Not Found",{status:404});
    try{
      const body=await readFile(file),type=asset.endsWith(".js")?"text/javascript; charset=utf-8":
        asset.endsWith(".css")?"text/css; charset=utf-8":asset.endsWith(".json")?"application/json; charset=utf-8":"text/html; charset=utf-8";
      return new Response(body,{headers:{"Content-Type":type}});
    }catch{return new Response("Not Found",{status:404});}
  }};

  const paths=["index.html","styles.css",...modules,"data/msf-resource-catalog.json"];
  for(const asset of paths){
    const response=await handleEventPlannerPage(new Request(ORIGIN+"/admin/events-planner/"+asset,{headers}),f.env,accessFetch());
    assert.equal(response.status,200,"Worker planner route serves "+asset);
    assert.ok((await response.arrayBuffer()).byteLength>0,"Worker route returns bytes for "+asset);
  }
});
