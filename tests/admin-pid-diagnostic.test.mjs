import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script,runInNewContext} from "node:vm";
const jsFile=new URL("../public/admin-pid-diagnostic.js",import.meta.url);
const routesFile=new URL("../src/admin-routes.js",import.meta.url);

async function inspect(){
  const js=await readFile(jsFile,"utf8");
  const start=js.indexOf("const PID_SCHEMA_FIELDS=");
  const end=js.indexOf("\nfunction pidText(",start);
  assert.ok(start>=0 && end>start);
  const pure=js.slice(start,end);
  const analyzer=runInNewContext(pure+"\nanalyzePidCard");
  return {js,analyzer};
}

test("PID diagnosis stays vanilla JS, no token or PID persistence",async()=>{
  const js=await readFile(jsFile,"utf8");
  assert.doesNotThrow(()=>new Script(js));
  assert.doesNotMatch(js,/innerHTML|localStorage|sessionStorage|console\.|indexedDB/);
  assert.match(js,/credentials:"same-origin"/);
  assert.match(js,/cache:"no-store"/);
  assert.match(js,/resource=player-card&session=/);
  assert.doesNotMatch(js,/url\s*\+\s*raw|url\.searchParams\.set\(["']pid/);
  const routes=await readFile(routesFile,"utf8");
  assert.match(routes,/Diagnostic du PID joueur/);
  assert.match(routes,/admin-pid-diagnostic\.js/);
  assert.match(routes,/id="pid-expected"/);
});

test("analyzer detects verified numeric PID values including undocumented card fields",async()=>{
  const {analyzer}=await inspect();
  const card={
    name:"TestPlayer",tcp:400123123,aid:100,rosterShare:"shared",
    pid:12345678,account:{playerId:"12345678",note:"test"},
    nested:[{uid:"77777777"}],extraField:{secret:"PRIVATE_TOKEN"}
  };
  const result=analyzer(card,"12345678");
  assert.equal(result.name,"TestPlayer");
  assert.deepEqual([...result.matches],["data.pid","data.account.playerId"]);
  assert.deepEqual([...result.unknownFields],["pid","account","nested","extraField"]);
  assert.equal(result.candidates.length,3);
  assert.ok(result.candidates.some(c=>c.field==="data.pid"&&c.value==="12345678"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
});

test("without a known in-game PID, numeric candidate fields are only hypotheses",async()=>{
  const {analyzer}=await inspect();
  const card={name:"TestPlayer",tcp:431716516,aid:1027,xxExtra:"abc",foo:{id:"12345678"}};
  const result=analyzer(card);
  assert.equal(result.matches.length,0);
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].field,"data.foo.id");
  const unrelated=analyzer(card,"50072723");
  assert.equal(unrelated.matches.length,0);
  assert.equal(analyzer(null,"12345678").error,"invalid-card");
});

test("very large nested cards are bounded and unknown values never dumped",async()=>{
  const {analyzer}=await inspect();
  const card={name:"VeryLarge"};
  for(let i=0;i<900;i++)card["f"+i]={anything:"private-information-"+i};
  const result=analyzer(card);
  assert.ok(result.examined<=401);
  assert.ok(result.unknownFields.length<=30);
  assert.doesNotMatch(JSON.stringify(result),/private-information/);
});

test("PID checker compares the selected member rather than the connected account, with no PID sent upstream",async()=>{
  const js=await readFile(jsFile,"utf8"),visited=[];
  function createElement(tag){
    return {tag,children:[],value:"",textContent:"",
      appendChild(child){this.children.push(child);},
      replaceChildren(){this.children=[];},
      addEventListener(){}};
  }
  const ids=Object.fromEntries(["pid-check","pid-load-members","pid-status",
    "pid-members-status","pid-choice-status","pid-result","pid-target","session","pid-expected"]
    .map(id=>[id,createElement("div")]));
  ids.session.value="a".repeat(64);
  ids["pid-expected"].value="50072723";
  const document={createElement,getElementById:id=>ids[id]};
  const fetch=async(url)=>{
    visited.push(url);
    if(url.includes("resource=alliance-members")){
      return {ok:true,json:async()=>({resource:"alliance-members",payload:{data:[
        {id:"self",isSelf:true,card:{name:"Keryas I"}},
        {id:"current-member:3",isSelf:false,card:{name:"iZi",rosterShare:true}}
      ]}})};
    }
    if(url.includes("pid-member-card")){
      return {ok:true,json:async()=>({resource:"member-card",
        payload:{data:{name:"iZi",socialState:"offline"}}})};
    }
    throw Error("Unexpected endpoint: "+url);
  };
  const {loadPidMembers,runPidDiagnostic,updatePidTarget}=runInNewContext(
    js+"\n({loadPidMembers,runPidDiagnostic,updatePidTarget})",{document,fetch});
  await loadPidMembers();
  assert.equal(ids["pid-target"].children.length,3);
  assert.equal(ids["pid-target"].children[0].textContent,"Choisir un joueur…");
  assert.equal(ids["pid-target"].children[1].textContent,"Compte connecté (choix explicite)");
  assert.equal(ids["pid-target"].children[2].textContent,"iZi");
  assert.equal(ids["pid-target"].value,"");
  assert.equal(ids["pid-check"].disabled,true);
  await runPidDiagnostic();
  assert.match(ids["pid-status"].textContent,/Choisis d'abord explicitement un joueur/);
  assert.equal(visited.length,1); // Member-list fetch only; no accidental self-card lookup.
  ids["pid-target"].value="current-member:3";
  updatePidTarget();
  assert.equal(ids["pid-check"].disabled,false);
  assert.match(ids["pid-choice-status"].textContent,/iZi/);
  await runPidDiagnostic();
  assert.equal(ids["pid-result"].children[0].textContent,"Profil réellement lu : iZi");
  assert.match(ids["pid-result"].children[1].textContent,/membre sélectionné : iZi/);
  assert.equal(visited.length,2);
  assert.match(visited[1],/pid-member-card\?session=/);
  assert.match(visited[1],/member=current-member%3A3/);
  assert.ok(visited.every(url=>!url.includes("50072723")));
  assert.match(ids["pid-status"].textContent,/Diagnostic terminé/);
  // A session change invalidates the volatile membership selection.
  ids.session.value="b".repeat(64);
  await runPidDiagnostic();
  assert.match(ids["pid-status"].textContent,/Liste des membres périmée/);
  assert.equal(visited.length,2);
});

test("PID member investigation makes mismatched profile names a hard stop",async()=>{
  const js=await readFile(jsFile,"utf8");
  assert.match(js,/cleanPidName\(scan.name\)!==memberName/);
  assert.match(js,/pseudo du membre a changé/);
  assert.match(js,/pidMemberSession!==selected/);
  assert.match(js,/session.*addEventListener\("change",resetPidMembers\)/);
  const page=await readFile(routesFile,"utf8");
  assert.match(page,/id="pid-target"/);
  assert.match(page,/id="pid-load-members"/);
  assert.match(page,/id="pid-check"[^>]*disabled/);
  assert.match(page,/Joueur à analyser \(choix obligatoire\)/);
  assert.match(js,/pid-target"\)\.addEventListener\("change",updatePidTarget\)/);
  assert.match(js,/connected\.value="__self__"/);
  assert.match(page,/admin\/api\/pid-member-card/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML|console\./);
});
