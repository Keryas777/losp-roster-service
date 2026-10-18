import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";
import {handleAdmin} from "../src/admin-routes.js";
const filename=new URL("../public/admin-explorer.js",import.meta.url);
const cssPath=new URL("../public/admin-explorer.css",import.meta.url);

test("admin explorer runs as plain browser JavaScript without a frontend build",async()=>{
  const js=await readFile(filename,"utf8");
  assert.doesNotThrow(()=>new Script(js,{filename:"admin-explorer.js"}));
  assert.doesNotMatch(js,/<script|innerHTML|eval\(|new Function\(/);
  assert.match(js,/JSON\.stringify\(payload,null,2\)/);
  assert.match(js,/document\.createElement/);
  assert.match(js,/textContent/);
});

test("private admin UI stylesheet is mobile first and includes a wide-screen breakpoint",async()=>{
  const css=await readFile(cssPath,"utf8");
  assert.match(css,/max-width:100%/);
  assert.match(css,/@media\(min-width:720px\)/);
  assert.doesNotMatch(css,/@import/);
});

test("admin routes cannot serve an HTML page when not configured",async()=>{
  const res=await handleAdmin(new Request("https://example.com/admin"),{},async()=>{
    throw Error("No external request expected");
  });
  assert.equal(res.status,503);
  assert.doesNotMatch(await res.text(),/admin-explorer\.js|Comp[t]?es et alliances/);
});

test("MSF alliance color markup is removed only from admin display labels",async()=>{
  const js=await readFile(filename,"utf8");
  const start=js.indexOf("function displayAllianceName(");
  const end=js.indexOf("\nfunction jsonDetails(",start);
  assert.ok(start>=0 && end>start);
  const formatter=runInNewContext(js.slice(start,end)+"\ndisplayAllianceName");
  assert.equal(formatter("LoSP <#F8FF00>Ζευς"),"LoSP Ζευς");
  assert.equal(formatter("LoSP <#FFFFFF>LoSP <#E10D17>Kronos"),"LoSP Kronos");
  assert.equal(formatter("LoSP Dionysos"),"LoSP Dionysos");
  assert.equal(formatter("<#broken>LoSP"),"<#broken>LoSP");
});

test("MSF alliance colors are extracted from the last valid marker, for display only",async()=>{
  const js=await readFile(filename,"utf8");
  const start=js.indexOf("function displayAllianceName(");
  const end=js.indexOf("\nfunction jsonDetails(",start);
  assert.ok(start>=0 && end>start);
  const colors=runInNewContext(js.slice(start,end)+"\nallianceColor");
  const display=runInNewContext(js.slice(start,end)+"\nallianceDisplay");
  assert.equal(colors("LoSP <#F8FF00>Ζευς"),"#F8FF00");
  assert.equal(colors("LoSP <#93328E>Διονυσος"),"#93328E");
  assert.equal(colors("LoSP <#FFFFFF>LoSP <#E10D17>Kronos"),"#E10D17");
  assert.equal(colors("LoSP <#00D0FF>Poseidon"),"#00D0FF");
  assert.equal(colors("LoSP Athéna"),null);
  assert.equal(colors("LoSP <#bad>Zeus"),null);
  assert.equal(display("LoSP <#FFFFFF>LoSP <#E10D17>Kronos").label,"LoSP Kronos");
  assert.equal(display("LoSP <#F8FF00>Ζευς").color,"#F8FF00");
  assert.match(js,/name\.style\.color=value\.color/);
  assert.match(js,/sessionSelect\.style\.color=allianceColor/);
  assert.doesNotMatch(js,/innerHTML/);
});

test("admin stylesheet respects hidden inputs and constrains mobile controls",async()=>{
  const css=await readFile(cssPath,"utf8");
  assert.match(css,/\[hidden\]\{display:none!important\}/);
  assert.match(css,/label\{[^}]*min-width:0\}/);
  assert.match(css,/select,input\{width:100%;min-width:0\}/);
});
