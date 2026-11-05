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
  return {tag,children:[],listeners:{},textContent:"",value:"",
    disabled:false,attrs:{},
    setAttribute(name,value){this.attrs[name]=value;},
    addEventListener(name,listener){this.listeners[name]=listener;},
    append(...nodes){this.children.push(...nodes);},
    appendChild(node){this.children.push(node);},
    replaceChildren(...nodes){this.children=nodes;}};
}
const FP="b".repeat(64);
function fixture({stale=false,postFails=false}={}){
  let linked="",writes=0;
  const nodes={
    "roster-connected-refresh":element("button"),
    "roster-connected-list":element("div"),
    "roster-connected-status":element("p")
  };
  const document={createElement:element};
  const fetch=async(url,opts)=>{
    if(url==="/admin/api/connected-alliances"){
      const alliance={fingerprint:FP,name:"MARINES",captainConnections:1,
        guestApproved:true,approved:false,
        ...(linked?{guestAllianceKey:linked}:{})};
      return {ok:true,json:async()=>({status:"ok",alliances:[alliance],
        connectedSessions:1,unresolvedSessions:0})};
    }
    if(url==="/admin/api/guest-alliance-approval"){
      writes++;
      const body=JSON.parse(opts.body);
      assert.equal(body.fingerprint,FP);
      assert.equal(body.action,"bind");
      assert.equal(body.allianceKey,"marines");
      if(postFails)return {ok:false,json:async()=>({error:"test-denied"})};
      if(!stale)linked=body.allianceKey;
      return {ok:true,json:async()=>({status:"bound"})};
    }
    throw Error("Unexpected request: "+url);
  };
  const rosterEl=id=>nodes[id];
  const rosterLine=(parent,text,tag="p")=>{
    const child=element(tag);child.textContent=text;parent.appendChild(child);
    return child;
  };
  const load=new Function("document","fetch","rosterEl","rosterLine",
    isolated+";return loadConnectedAlliances;")(
    document,fetch,rosterEl,rosterLine);
  const find=tag=>nodes["roster-connected-list"].children.find(
    el=>el.tag===tag);
  const bindButton=()=>nodes["roster-connected-list"].children.find(
    el=>el.tag==="button"&&el.textContent==="Associer à la WebApp");
  const feedback=()=>nodes["roster-connected-list"].children
    .filter(el=>el.tag==="p").map(el=>el.textContent)
    .find(t=>t.includes("Association"))||"";
  return {load,find,bindButton,feedback,get writes(){return writes}};
}

test("after WebApp binding, R2-confirmed success remains in the refreshed card",async()=>{
  const f=fixture();
  await f.load();
  f.find("label").children[0].value="marines";
  await f.bindButton().listeners.click();
  assert.equal(f.writes,1);
  assert.equal(f.find("label").children[0].value,"marines");
  assert.match(f.feedback(),/Association confirmée : marines.*R2/);
  await f.load(); // separate refresh always reads the persisted binding
  assert.equal(f.find("label").children[0].value,"marines");
});
test("stale post response never claims a link is saved in R2",async()=>{
  const f=fixture({stale:true});
  await f.load();
  f.find("label").children[0].value="marines";
  await f.bindButton().listeners.click();
  assert.match(f.feedback(),/Association non confirmée/);
  assert.equal(f.find("label").children[0].value,"");
});
test("failed binding keeps a visible error without re-rendering away the message",async()=>{
  const f=fixture({postFails:true});
  await f.load();
  f.find("label").children[0].value="marines";
  await f.bindButton().listeners.click();
  assert.match(f.feedback(),/Association impossible : test-denied/);
  assert.equal(f.bindButton().disabled,false);
});
