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
  assert.match(js,/sessionSelect\.style\.color=color\|\|""/);
  assert.doesNotMatch(js,/innerHTML/);
});

test("admin stylesheet respects hidden inputs and constrains mobile controls",async()=>{
  const css=await readFile(cssPath,"utf8");
  assert.match(css,/\[hidden\]\{display:none!important\}/);
  assert.match(css,/label\{[^}]*min-width:0\}/);
  assert.match(css,/select,input\{width:100%;min-width:0\}/);
});

test("alliance identity tokens theme rows and account selector with a subtle tint",async()=>{
  const js=await readFile(filename,"utf8");
  const css=await readFile(cssPath,"utf8");
  assert.match(js,/function applyAllianceTheme\(element,color\)/);
  assert.match(js,/applyAllianceTheme\(r,value\.color\)/);
  assert.match(js,/applyAllianceTheme\(sessionSelect,color\)/);
  assert.match(js,/element\.style\.setProperty\("--alliance-color",color\)/);
  assert.match(js,/element\.style\.setProperty\("--alliance-surface",color\+"18"\)/);
  assert.match(js,/element\.style\.setProperty\("--alliance-outline",color\+"80"\)/);
  assert.match(css,/tr\.alliance-themed/);
  assert.match(css,/td:first-child\{box-shadow:inset 3px 0 var\(--alliance-color\)\}/);
  assert.match(css,/select\.alliance-themed/);
});

test("member list uses official nicknames, shows missing shares first, never presents volatile IDs as player names",async()=>{
  const js=await readFile(filename,"utf8");
  const start=js.indexOf("function displayPlayerName(");
  const end=js.indexOf("\nfunction jsonDetails(",start);
  assert.ok(start>=0 && end>start);
  const code=js.slice(start,end);
  const nickname=runInNewContext(code+"\ndisplayPlayerName");
  const choices=runInNewContext(code+"\nsharedMemberChoices");
  assert.equal(nickname("<#00D0FF>Jaxx"),"Jaxx");
  assert.equal(nickname(" Keryas IV "),"Keryas IV");
  assert.equal(nickname(""),"Pseudo indisponible");
  const members=[
    {id:"aid:v1",rank:"member",isSelf:false,card:{name:"Jaxx",rosterShare:false}},
    {id:"aid:v2",rank:"member",isSelf:false,card:{name:"Coéquipier",rosterShare:true}},
    {id:"aid:v3",rank:"leader",isSelf:true,card:{name:"Capitaine",rosterShare:true}}
  ];
  assert.equal(JSON.stringify(choices(members)),JSON.stringify([{id:"aid:v2",name:"Coéquipier"}]));
  assert.equal(choices(members.map(m=>({...m,id:m.id.replace(":v",":vNEXT")})))[0].name,"Coéquipier");
  assert.equal(choices(members.map(m=>({...m,id:m.id.replace(":v",":vNEXT")})))[0].id,"aid:vNEXT2");

  const node=(tag,text,parent,cls)=>{
    const item={tag,text,cls,children:[]};
    if(parent)parent.children.push(item);
    return item;
  };
  const rendered=[];
  const sandbox={
    node, jsonDetails:()=>{}, button:(label,fn,parent)=>{
      rendered.push({label,parent});return node("button",label,parent);
    },
    sessionSelect:{value:"current"},memberChoiceSession:"current"
  };
  const render=runInNewContext(code+"\nrenderAllianceMembers",sandbox);
  const root={children:[]};
  render(members,root);
  assert.equal(root.children[1].text,"Partage désactivé : Jaxx");
  const cards=root.children[2].children;
  assert.equal(cards[0].children[0].text,"Jaxx");
  assert.equal(cards[0].children[2].text,"Partage désactivé");
  assert.equal(cards[1].children[0].text,"Coéquipier");
  assert.equal(rendered.length,1);
  assert.equal(rendered[0].label,"Voir son roster");
  assert.ok(!cards.some(card=>card.children.some(v=>typeof v.text==="string"&&v.text.startsWith("aid:"))));
});

test("admin HTML uses current-member nickname picker instead of an ID text field",async()=>{
  // Front-end wiring remains in the authenticated admin source.
  const route=await readFile(new URL("../src/admin-routes.js",import.meta.url),"utf8");
  const js=await readFile(filename,"utf8");
  const css=await readFile(cssPath,"utf8");
  assert.ok(route.includes('<select id="member"></select>'));
  assert.ok(!route.includes('<input id="member"'));
  assert.match(js,/memberChoiceSession!==currentSession/);
  assert.match(js,/sessionSelect\.addEventListener\("change",resetMemberOptions\)/);
  assert.match(js,/response\.resource==="alliance-members"/);
  assert.match(css,/\.members-grid/);
  assert.match(css,/\.member-unshared/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML/);
});
