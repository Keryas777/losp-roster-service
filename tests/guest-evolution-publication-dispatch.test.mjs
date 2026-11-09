import test from "node:test";
import assert from "node:assert/strict";
import {dispatchGuestEvolutionPublication}
  from "../src/guest-evolution-publication-dispatch.js";

test("missing GitHub token disables dispatch without a request",async()=>{
  let called=false;
  const result=await dispatchGuestEvolutionPublication({},async()=>{called=true;});
  assert.deepEqual(result,{status:"not-configured"});
  assert.equal(called,false);
});
test("dispatch wakes only the workflow and contains no archive or player data",async()=>{
  let request;
  const result=await dispatchGuestEvolutionPublication({
    ROSTER_GITHUB_DISPATCH_TOKEN:"test-secret"
  },async(url,options)=>{
    request={url,options};
    return new Response(null,{status:204});
  });
  assert.deepEqual(result,{status:"dispatched"});
  assert.match(request.url,/publish-guest-evolution\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(request.options.body),{ref:"main"});
  assert.equal(request.options.headers.Authorization,"Bearer test-secret");
  assert.doesNotMatch(request.options.body,/fingerprint|player|roster/i);
});
test("GitHub failure is reported without making approval handling fail",async()=>{
  const result=await dispatchGuestEvolutionPublication({ROSTER_GITHUB_DISPATCH_TOKEN:"x"},
    async()=>{throw Error("network unavailable");});
  assert.deepEqual(result,{status:"failed"});
});
