import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync(new URL("../public/admin-roster-preflight.js",
  import.meta.url),"utf8");
const first=source.indexOf("async function loadConnectedAlliances(");
const last=source.indexOf("async function loadRosterPreflight()",first);
assert.ok(first>0&&last>first);
const isolated=source.slice(first,last);

function element(tag){
  return {tag,children:[],listeners:{},style:{},value:"",disabled:false,
    attrs:{},content:"",
    set textContent(value){this.content=String(value);this.children=[];},
    get textContent(){return this.content+
      this.children.map(child=>child.textContent).join("");},
    appendChild(child){this.children.push(child);},
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.content="";this.children=children;},
    setAttribute(name,value){this.attrs[name]=value;},
    addEventListener(name,listener){this.listeners[name]=listener;}
  };
}

function fixture(alliances){
  const nodes={
    "roster-connected-refresh":element("button"),
    "roster-connected-list":element("div"),
    "roster-connected-status":element("p")
  };
  const document={createElement:element};
  const fetch=async()=>({ok:true,json:async()=>({
    status:"ok",alliances,connectedSessions:alliances.length,
    unresolvedSessions:0
  })});
  const rosterEl=id=>nodes[id];
  const rosterLine=(parent,text,tag="p")=>{
    const child=element(tag);
    child.textContent=text;
    parent.appendChild(child);
    return child;
  };
  const load=new Function("document","fetch","rosterEl","rosterLine",
    isolated+";return loadConnectedAlliances;")(
    document,fetch,rosterEl,rosterLine);
  return {load,get items(){return nodes["roster-connected-list"].children;}};
}

test("Scopely colors MARINES entirely and separates white END from orange GAME",async()=>{
  const f=fixture([
    {name:"<color=red>MΛЯIΠΣƧ</color>",fingerprint:"a",captainConnections:1,
      guestApproved:true,approved:false,guestAllianceKey:"marines"},
    {name:"END<color=#f60>GAME R-évolution",fingerprint:"b",
      captainConnections:1,guestApproved:true,approved:false,
      guestAllianceKey:"endgame-revolution-orange"}
  ]);
  await f.load();
  const summaries=f.items.filter(el=>el.tag==="p"&&el.textContent.includes("OAuth"));
  assert.equal(summaries.length,2);
  assert.match(summaries[0].textContent,/^MΛЯIΠΣƧ — 1 connexion/);
  assert.equal(summaries[0].children[0].style.color,"red");
  assert.match(summaries[1].textContent,/^ENDGAME R-évolution — 1 connexion/);
  assert.equal(summaries[1].children[0].textContent,"END");
  assert.equal(summaries[1].children[0].style.color,"#fff");
  assert.equal(summaries[1].children[1].textContent,"GAME R-évolution");
  assert.equal(summaries[1].children[1].style.color,"#f60");
  assert.ok(f.items.filter(el=>el.tag==="button")
    .some(el=>el.textContent==="Révoquer la collecte invitée — ENDGAME R-évolution"));
  assert.ok(f.items.every(el=>!el.textContent.includes("<color=")));
});

test("red ENDGAME uses its own Scopely color and safe text-only buttons",async()=>{
  const f=fixture([
    {name:"END<color=red>GAME R-évolution</color>",
      fingerprint:"c",captainConnections:1,guestApproved:false,approved:false},
    {name:"LoSP <#00D0FF>Poséidon",
      fingerprint:"d",captainConnections:1,guestApproved:false,approved:true}
  ]);
  await f.load();
  const summaries=f.items.filter(el=>el.tag==="p"&&el.textContent.includes("OAuth"));
  assert.equal(summaries[0].children[0].style.color,"#fff");
  assert.equal(summaries[0].children[1].style.color,"red");
  assert.equal(summaries[0].children[2].textContent," — 1 connexion(s) OAuth — roster personnel uniquement");
  assert.equal(summaries[1].textContent.startsWith("LoSP Poséidon"),true);
  assert.equal(summaries[1].children[1].style.color,"#00D0FF");
  const controls=f.items.filter(el=>el.tag==="button");
  assert.ok(controls.some(el=>el.textContent===
    "Autoriser la collecte invitée — ENDGAME R-évolution"));
  assert.ok(controls.some(el=>el.textContent===
    "Inclure ENDGAME R-évolution dans les collectes LoSP"));
  assert.ok(f.items.every(el=>!el.textContent.includes("</color>")));
});

test("unsupported markup stays inert as text, never executable HTML",async()=>{
  const f=fixture([{name:"Test <img src=x onerror=alert(1)>",
    fingerprint:"e",captainConnections:1,guestApproved:false,approved:true}]);
  await f.load();
  const summary=f.items.find(el=>el.tag==="p"&&el.textContent.includes("OAuth"));
  assert.match(summary.textContent,/Test <img src=x onerror=alert\(1\)>/);
  assert.equal(summary.children[0].tag,"span");
});
