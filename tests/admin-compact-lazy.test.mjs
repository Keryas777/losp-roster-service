import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";

const get=path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("four compact tabs preserve every admin tool, including active orphan audit",async()=>{
  const [layout,html,css]=await Promise.all([
    get("public/admin-navigation.js"),get("src/admin-routes.js"),
    get("public/admin-explorer.css")
  ]);
  assert.doesNotThrow(()=>new Script(layout));
  const targetGroups={
    overview:["refresh","check-refresh","season-ranks-refresh"],
    rosters:["check-coverage","roster-preflight","roster-r2-refresh"],
    archives:["game-archive-status","game-r2-inventory-start","game-orphan-start",
      "game-inspect-start","game-schema-start"],
    advanced:["msf-secondary-probe","pid-check","load","output"]
  };
  for(const id of Object.keys(targetGroups)){
    assert.match(layout,new RegExp('id:"'+id+'"'));
    for(const target of targetGroups[id]){
      assert.ok(layout.includes('"'+target+'"'),"navigation target missing "+target);
      assert.ok(html.includes('id="'+target+'"'),"admin element missing "+target);
    }
  }
  assert.match(layout,/section\.id==="output"/);
  assert.match(layout,/section\.hidden=/);
  assert.match(layout,/replaceState/);
  assert.match(css,/\.admin-nav-ready \.admin-tabs/);
  assert.match(css,/-webkit-overflow-scrolling:touch/);
  assert.match(html,/admin-navigation\.js/);
  assert.ok(html.indexOf("admin-navigation.js")<html.indexOf("admin-explorer.js"));
  assert.doesNotMatch(layout,/fetch\(|XMLHttpRequest|localStorage|sessionStorage|innerHTML/);
});

test("all optional admin reports are refreshed by explicit controls, never page load",async()=>{
  const cases=[
    ["public/admin-roster-preflight.js","showRosterAutoStatus","roster-auto-refresh"],
    ["public/admin-game-archive.js","status","game-archive-refresh"],
    ["public/admin-season-ranks.js","call(false)","season-ranks-refresh"],
    ["public/admin-game-schema-audit.js","load()","game-schema-refresh"],
    ["public/admin-game-orphan-audit.js","load(\"GET\")","game-orphan-refresh"]
  ];
  for(const [path,fn,button] of cases){
    const js=await get(path);
    assert.ok(js.includes(button),path+" does not bind manual refresh");
    assert.doesNotMatch(js,new RegExp("^[ \\t]*void "+fn.replace(/[()]/g,x=>"\\\\ "+x).trim()+";", "m"),
      "unexpected top-level auto fetch in "+path);
  }
  const preflight=await get("public/admin-roster-preflight.js");
  assert.doesNotMatch(preflight,/^void showRosterAutoStatus\(\);/m);
  const game=await get("public/admin-game-archive.js");
  assert.doesNotMatch(game,/^  void status\(\)\.catch/m);
  const ranks=await get("public/admin-season-ranks.js");
  assert.doesNotMatch(ranks,/^ void call\(false\);/m);
  const schema=await get("public/admin-game-schema-audit.js");
  assert.doesNotMatch(schema,/^  void load\(\);/m);
  const orphan=await get("public/admin-game-orphan-audit.js");
  assert.doesNotMatch(orphan,/^  void load\("GET"\);/m);
  assert.match(await get("src/admin-routes.js"),/id="game-archive-refresh"/);
  assert.match(await get("src/admin-routes.js"),/id="roster-auto-refresh"/);
});

class FakeNode {
  constructor(tag="div"){
    this.tagName=tag.toUpperCase();
    this.style={color:"",setProperty(){},removeProperty(){}};
    this.classList={add(){},toggle(){}};
    this.value="";this.hidden=false;this.children=[];
    this.textContent="";this.onclick=null;this.disabled=false;
  }
  appendChild(child){this.children.push(child);return child;}
  replaceChildren(...children){this.children=[...children];}
  addEventListener(name,fn){this["listener_"+name]=fn;}
  setAttribute(){}
}

test("loading /admin performs zero Scopely/session requests until user action",async()=>{
  const js=await get("public/admin-explorer.js");
  const nodes=new Map();
  const getNode=id=>{
    if(!nodes.has(id))nodes.set(id,new FakeNode(id));
    return nodes.get(id);
  };
  const urls=[];
  const fakeFetch=async url=>{
    urls.push(url);
    if(url==="/admin/api/catalog")
      return {ok:true,status:200,json:async()=>({resources:[
        {id:"alliance-members",label:"Membres",path:"/player/v1/alliance/members"}
      ]})};
    if(url==="/admin/api/refresh-cron")
      return {ok:true,status:200,json:async()=>({status:"not-yet-observed"})};
    if(url==="/admin/api/sessions")
      return {ok:true,status:200,json:async()=>({sessions:[],nextCursor:null})};
    throw Error("Unexpected implicit API request: "+url);
  };
  const sandbox={document:{
    getElementById:getNode,createElement:tag=>new FakeNode(tag)
  },fetch:fakeFetch,console,URLSearchParams,Date};
  assert.doesNotThrow(()=>new Script(js));
  runInNewContext(js,sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(urls,["/admin/api/catalog"]);
  assert.match(getNode("status").textContent,/Aucun compte interrogé/);

  // OAuth monitoring has a safe R2-only endpoint, and must not refresh all
  // 9 grants / 18 official profile+alliance GETs behind the user's back.
  await getNode("check-refresh").onclick();
  assert.deepEqual(urls,["/admin/api/catalog","/admin/api/refresh-cron"]);
  await getNode("refresh").onclick();
  assert.deepEqual(urls,["/admin/api/catalog","/admin/api/refresh-cron",
    "/admin/api/sessions"]);
});

test("previous user actions remain wired and provider requests stay opt-in",async()=>{
  const html=await get("src/admin-routes.js");
  const explorer=await get("public/admin-explorer.js");
  assert.match(html,/Charger \/ actualiser les comptes \(API MSF\)/);
  assert.match(html,/Aucun compte interrogé à l’ouverture/);
  assert.match(explorer,/el\("refresh"\)\.onclick=\(\)=>loadSessions\(true\)/);
  assert.match(explorer,/el\("check-coverage"\)\.onclick=loadCoverage/);
  assert.match(explorer,/el\("load"\)\.onclick=loadResource/);
  assert.match(explorer,/el\("more"\)\.onclick=\(\)=>loadSessions\(false\)/);
  assert.doesNotMatch(explorer,/localStorage|sessionStorage|innerHTML/);
});
