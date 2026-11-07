import test from "node:test";
import assert from "node:assert/strict";
import {handleGuestWebappOnboarding} from "../src/guest-webapp-onboarding.js";

const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const valid={key:"another-us-team",name:"Another US Team",
  color:"#ffffff",roleId:"1568752859137318999"};
const env={ROSTER_GITHUB_DISPATCH_TOKEN:"test-only"};
const request=(body=valid,origin=ORIGIN)=>new Request(ORIGIN+"/admin/api/guest-webapp-onboarding",{
  method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
  body:JSON.stringify(body)
});

test("Admin: dispatch validé, sans OAuth ni écriture R2",async()=>{
  let calls=0;
  const response=await handleGuestWebappOnboarding(request(),env,
    async (url,options)=>{
      calls++;
      assert.equal(url,"https://api.github.com/repos/Keryas777/msf/actions/workflows/register-guest-alliance.yml/dispatches");
      assert.equal(options.method,"POST");
      assert.equal(options.headers.Authorization,"Bearer test-only");
      assert.deepEqual(JSON.parse(options.body),{ref:"main",inputs:{
        alliance_key:valid.key,alliance_name:valid.name,
        discord_role_id:valid.roleId,alliance_color:"#FFFFFF"}});
      return new Response(null,{status:204});
    });
  assert.equal(calls,1);
  assert.equal(response.status,202);
  const body=await response.json();
  assert.equal(body.status,"queued");
  assert.match(body.workflow,/github\.com\/Keryas777\/msf\/actions\/workflows/);
});

test("Admin: saisies incorrectes, origine externe et secret absent refusés",async()=>{
  let calls=0;const fetcher=async()=>{calls++;return new Response(null,{status:204});};
  for(const data of [
    {...valid,key:"../escape"},
    {...valid,roleId:"abc"},
    {...valid,color:"white"},
    {...valid,name:"<script>"},
    {...valid,name:" Leading"},
    {...valid,other:"unexpected"}]){
    const res=await handleGuestWebappOnboarding(request(data),env,fetcher);
    assert.equal(res.status,400);
  }
  assert.equal((await handleGuestWebappOnboarding(request(valid,"https://evil.example"),env,fetcher)).status,403);
  assert.equal((await handleGuestWebappOnboarding(request(valid),{},fetcher)).status,503);
  assert.equal(calls,0);
});
test("Admin: échec GitHub ne prétend jamais avoir créé la PR",async()=>{
  const res=await handleGuestWebappOnboarding(request(),env,
    async()=>new Response(null,{status:404}));
  assert.equal(res.status,503);
  assert.equal((await res.json()).status,"github-dispatch-failed");
});
