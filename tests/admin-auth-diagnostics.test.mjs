import {test} from "node:test";
import assert from "node:assert/strict";
import {createSign,generateKeyPairSync} from "node:crypto";
import {adminReady,authenticateAdmin,diagnoseAdminAuth} from "../src/admin-auth.js";
import {handleAdmin} from "../src/admin-routes.js";

const base="https://losp-roster-service.deliriousfan7.workers.dev/admin";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const pub=publicKey.export({format:"jwk"});
const domain="diagnostics-losp.cloudflareaccess.com",aud="ab".repeat(32);
const env={MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:domain,
  CF_ACCESS_AUD:aud,MSF_ADMIN_EMAILS:"captain@example.test"};
const enc=v=>Buffer.from(JSON.stringify(v)).toString("base64url");
const now=Math.floor(Date.now()/1000);
function jwt(changes={}){
  const p1=enc({alg:"RS256",kid:"fixture",typ:"JWT"});
  const p2=enc({iss:"https://"+domain,aud:[aud],email:"captain@example.test",
    iat:now-15,exp:now+600,nbf:now-15,...changes});
  const toSign=p1+"."+p2;
  const sig=createSign("RSA-SHA256").update(toSign).end().sign(privateKey).toString("base64url");
  return toSign+"."+sig;
}
const jwks=async()=>Response.json({keys:[{...pub,kid:"fixture",alg:"RS256"}]});
const request=(token,asCookie=false)=>new Request(base,{headers:
  token?(asCookie?{Cookie:"CF_Authorization="+token}:{"Cf-Access-Jwt-Assertion":token}):{}});

test("domain format remains valid after diagnostics refactor",()=>{
  assert.equal(adminReady(env),true);
  assert.equal(adminReady({...env,CF_ACCESS_TEAM_DOMAIN:"not-a-team"}),false);
});

test("normal refusal remains generic, with diagnostics absent",async()=>{
  const r=await handleAdmin(request(null),env,jwks);
  assert.equal(r.status,403);
  assert.equal(await r.text(),"Accès administrateur refusé");
});

test("diagnostic mode shows safe fixed status but no token, email or secrets",async()=>{
  const opts={...env,MSF_ADMIN_DIAGNOSTICS_ENABLED:"true"};
  const denied=await handleAdmin(request(null),opts,jwks);
  assert.equal(denied.status,403);
  assert.equal(await denied.text(),"Accès administrateur refusé (diagnostic : jwt-missing)");
  for(const [claims,expected] of [
    [{aud:["wrong"]},"jwt-audience-mismatch"],
    [{email:"other@example.test"},"jwt-email-not-allowed"],
    [{iss:"https://wrong.cloudflareaccess.com"},"jwt-issuer-mismatch"],
    [{exp:now-1},"jwt-time-invalid"],
  ]){
    const res=await handleAdmin(request(jwt(claims)),opts,jwks);
    assert.equal(res.status,403);
    const body=await res.text();
    assert.ok(body.includes(expected));
    assert.ok(!body.includes("captain@example.test"));
    assert.ok(!body.includes(aud));
    assert.ok(!body.includes("eyJ"));
  }
});

test("signed header and cookie work, bad signature remains denied",async()=>{
  assert.equal(await authenticateAdmin(request(jwt()),env,jwks),true);
  assert.equal(await diagnoseAdminAuth(request(jwt(),true),env,jwks),"ok");
  const original=jwt();
  const parts=original.split(".");
  const forged=parts[0]+"."+parts[1]+"."+(parts[2][0]==="a"?"b":"a")+parts[2].slice(1);
  assert.notEqual(await diagnoseAdminAuth(request(forged),env,jwks),"ok");
  assert.equal((await handleAdmin(request(jwt()),env,jwks)).status,200);
});

test("JWKS fetch errors fail closed and show no upstream data",async()=>{
  const other={...env,CF_ACCESS_TEAM_DOMAIN:"other-team.cloudflareaccess.com"};
  const token=jwt({iss:"https://other-team.cloudflareaccess.com"});
  assert.equal(await diagnoseAdminAuth(request(token),other,async()=>new Response("",{status:500})),
    "jwks-unavailable");
});

test("JWKS failures distinguish HTTP, redirects, invalid JSON, network and timeouts safely",async()=>{
  const originalEnv={...env,CF_ACCESS_TEAM_DOMAIN:"fresh-losp.cloudflareaccess.com"};
  const signed=jwt({iss:"https://fresh-losp.cloudflareaccess.com"});
  const checks=[
    [async()=>new Response("Forbidden",{status:403}),"jwks-http-403"],
    [async()=>new Response("Not found",{status:404}),"jwks-http-404"],
    [async()=>new Response("",{status:302,headers:{Location:"https://invalid.example/login"}}),"jwks-redirect"],
    [async()=>new Response("<html>not json</html>",{status:200}),"jwks-invalid-json"],
    [async()=>{throw new TypeError("private transport detail");},"jwks-network-error"],
    [async()=>{const e=new Error("timeout");e.name="TimeoutError";throw e;},"jwks-timeout"]
  ];
  for(const [mock,status] of checks){
    const result=await diagnoseAdminAuth(request(signed),originalEnv,mock);
    assert.equal(result,status);
    assert.equal(await authenticateAdmin(request(signed),originalEnv,mock),false);
  }
});

test("JWKS fetch is constrained to the configured team and does not follow redirects",async()=>{
  const newEnv={...env,CF_ACCESS_TEAM_DOMAIN:"isolated-losp.cloudflareaccess.com"};
  const signed=jwt({iss:"https://isolated-losp.cloudflareaccess.com"});
  let checked=false;
  const result=await diagnoseAdminAuth(request(signed),newEnv,async(url,options)=>{
    checked=true;
    assert.equal(url,"https://isolated-losp.cloudflareaccess.com/cdn-cgi/access/certs");
    assert.equal(options.method,"GET");
    assert.equal(options.redirect,"manual");
    assert.equal(options.headers.Accept,"application/json");
    return new Response("",{status:502});
  });
  assert.equal(checked,true);
  assert.equal(result,"jwks-http-502");
});

test("diagnostics must never enable admin without a valid signed JWT",async()=>{
  const opts={...env,MSF_ADMIN_DIAGNOSTICS_ENABLED:"true"};
  const res=await handleAdmin(request("not.a.jwt"),opts,jwks);
  assert.equal(res.status,403);
  assert.ok((await res.text()).startsWith("Accès administrateur refusé"));
});
