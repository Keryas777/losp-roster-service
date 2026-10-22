import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";

class Element {
  constructor(tag="div",id=""){
    this.tagName=tag.toUpperCase();this.id=id;this.children=[];
    this.parent=null;this.dataset={};this.hidden=false;this.open=false;
    this.textContent="";this.attributes={};this.listeners={};
    this.classes=new Set();
    this.classList={add:name=>this.classes.add(name),
      toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};
  }
  get firstChild(){return this.children[0]||null;}
  appendChild(child){
    child.remove();this.children.push(child);child.parent=this;return child;
  }
  append(...nodes){for(const node of nodes)this.appendChild(node);}
  remove(){
    if(this.parent){
      const i=this.parent.children.indexOf(this);
      if(i>=0)this.parent.children.splice(i,1);
      this.parent=null;
    }
  }
  before(node){this.beforeNode=node;}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,callback){this.listeners[k]=callback;}
  querySelector(selector){
    if(selector===":scope > h2")return this.children.find(e=>e.tagName==="H2")||null;
    for(const value of selector.split(",")){
      const id=value.trim().match(/^#([A-Za-z0-9_-]+)$/)?.[1];
      if(id){
        const found=this.findId(id);
        if(found)return found;
      }
    }
    return null;
  }
  findId(id){
    if(this.id===id)return this;
    for(const child of this.children){
      const found=child.findId(id);if(found)return found;
    }
    return null;
  }
  details(){return this.children.find(x=>x.tagName==="DETAILS");}
}
function section(id,name){
  const e=new Element("section");
  const h=new Element("h2");h.textContent=name;
  const button=new Element("button",id);
  e.append(h,button);
  return e;
}
test("all admin panels start closed, no first-panel autoselection on tab changes",async()=>{
  const script=await readFile(new URL("../public/admin-navigation.js",import.meta.url),"utf8");
  const panels=[
    section("refresh","Comptes"),
    section("check-refresh","OAuth"),
    section("season-ranks-refresh","Classements"),
    section("game-archive-status","Collecte"),
    section("game-orphan-start","Audit orphelins")
  ];
  const main=new Element("main");
  main.append(...panels);
  const document={querySelector:s=>s==="main"?main:null,
    createElement:s=>new Element(s),body:new Element("body")};
  const listeners={},window={
    location:{hash:""},history:{replaceState(){}},
    addEventListener:(event,fn)=>listeners[event]=fn
  };
  runInNewContext(script,{document,window});
  assert.ok(main.beforeNode,"tab bar present");
  for(const p of panels){
    assert.ok(p.details(),"section transformed to collapsible details");
    assert.equal(p.details().open,false,"no panel may open automatically");
  }
  const tabs=main.beforeNode.children;
  const archives=tabs.find(x=>x.textContent==="Archives R2");
  const overview=tabs.find(x=>x.textContent==="Vue d’ensemble");
  assert.ok(archives&&overview);
  archives.listeners.click();
  assert.equal(panels[3].details().open,false);
  assert.equal(panels[4].details().open,false);
  // User chooses ONLY the second archive section.
  panels[4].details().open=true;
  overview.listeners.click();
  archives.listeners.click();
  assert.equal(panels[3].details().open,false);
  assert.equal(panels[4].details().open,true);
  assert.equal(panels[0].details().open,false);
});
