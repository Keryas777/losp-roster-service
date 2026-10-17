import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
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
