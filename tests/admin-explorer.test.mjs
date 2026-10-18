import {test} from "node:test";
import assert from "node:assert/strict";
import {createSign,generateKeyPairSync,webcrypto} from "node:crypto";
import {adminReady,authenticateAdmin} from "../src/admin-auth.js";
import {adminCatalog,adminSessionList,adminResource,adminCoverage,API_RESOURCES} from "../src/admin-data-api.js";
import {handleAdmin} from "../src/admin-routes.js";
import worker from "../src/index.js";

const origin="https://losp-roster-service.deliriousfan7.workers.dev";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});
const domain="losp-test.cloudflareaccess.com",aud="a".repeat(64);
const envAccess={MSF_ADMIN_ENABLED:"true",CF_ACCESS_TEAM_DOMAIN:domain,
  CF_ACCESS_AUD:aud,MSF_ADMIN_EMAILS:"admin@example.test"};
const b64=x=>Buffer.from(typeof x==="string"?x:JSON.stringify(x)).toString("base64url");
function assertion(claims={},override={}){
  const header=b64({alg:"RS256",kid:"test-key",typ:"JWT"});
  const payload=b64({iss:"https://"+domain,aud:[aud],email:"admin@example.test",
    iat:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+600,...claims});
  const signed=header+"."+payload;
  const sig=createSign("RSA-SHA256").update(signed).end().sign(privateKey).toString("base64url");
  return signed+"."+(override.signature||sig);
}
const certs=async()=>Response.json({keys:[{...jwk,kid:"test-key",alg:"RS256"}]});
const adminRequest=(p,jwt)=>new Request(origin+p,{headers:
  jwt?{"Cf-Access-Jwt-Assertion":jwt}:{}});
const sid="b".repeat(64),prefix="oauth-captains/v1/";
function apiEnv(){
  const env={...envAccess,CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"cd".repeat(32)};
  env.CAPTAIN_BUCKET={
    get:async()=>null,delete:async()=>{},put:async()=>{},
    list:async()=>({objects:[{key:prefix+sid}],truncated:false})
  };
  env.CAPTAIN_REFRESH_COORDINATOR={
    idFromName:key=>key,
    get:()=>({fetch:async()=>Response.json({status:"active",accessToken:"PRIVATE_ACCESS_TOKEN"})})
  };
  return env;
}
const dataFetch=async(url,options={})=>{
  assert.match(options.headers.Authorization,/Bearer PRIVATE_ACCESS_TOKEN/);
  if(url.endsWith("/player/v1/card"))return Response.json({data:{name:"Captain Alpha",secretNote:"not-public"},meta:{source:"MSF"}});
  if(url.endsWith("/player/v1/alliance/card"))return Response.json({data:{id:"aid001:rev3",name:"Zeus"},meta:{source:"MSF"}});
  if(url.includes("/alliance/members"))return Response.json({data:[
    {id:"self",isSelf:true,card:{name:"Captain Alpha",rosterShare:true}},
    {id:"member-1",isSelf:false,card:{name:"Teammate",rosterShare:true}},
    {id:"member-2",isSelf:false,card:{name:"Not shared",rosterShare:false}}
  ],meta:{member_version:"rev3"}});
  if(url.includes("/roster/member/member-1"))return Response.json({data:[
    {id:"Darkstar",gear:21,stats:{hp:2500000,power:12345},newField:{keep:true}}
  ],meta:{page:1,perPage:20,perTotal:1,newMeta:"retained"}});
  if(url.includes("/inventory"))return Response.json({data:[
    {itemId:"ITEM_1",count:152,extra:{futureScopelyField:["kept","intact"]}}
  ],meta:{page:1,perTotal:1}});
  return Response.json({data:[{id:"Character",gear:22}],meta:{new:"field"}});
};

test("global admin is disabled without explicitly configured Zero Trust Access",async()=>{
  assert.equal(adminReady({}),false);
  assert.equal(adminReady({...envAccess,MSF_ADMIN_ENABLED:"false"}),false);
  assert.equal(adminReady({...envAccess,MSF_ADMIN_ENABLED:"true"}),true);
  const result=await worker.fetch(new Request(origin+"/admin"),{});
  assert.equal(result.status,503);
});

test("captain cookie alone and untrusted email header never authenticate as admin",async()=>{
  const headers={Cookie:"__Host-losp_captain_session="+"x".repeat(43),
    "Cf-Access-Authenticated-User-Email":"admin@example.test"};
  const result=await handleAdmin(new Request(origin+"/admin",{headers}),envAccess,certs);
  assert.equal(result.status,403);
});

test("signed Access RS256 JWT is validated against domain/audience/email/expiry",async()=>{
  assert.equal(await authenticateAdmin(adminRequest("/admin",assertion()),envAccess,certs),true);
  for(const claims of [
    {email:"intruder@example.test"},{aud:["different"]},
    {iss:"https://evil.cloudflareaccess.com"},
    {exp:Math.floor(Date.now()/1000)-1},
    {nbf:Math.floor(Date.now()/1000)+9999}
  ]){
    assert.equal(await authenticateAdmin(adminRequest("/admin",assertion(claims)),envAccess,certs),false);
  }
  assert.equal(await authenticateAdmin(adminRequest("/admin",assertion({},{
    signature:"garbage"})),envAccess,certs),false);
});

test("a cryptographically valid CF_Authorization cookie authenticates only its permitted owner",async()=>{
  const cookie="CF_Authorization="+assertion();
  assert.equal(await authenticateAdmin(new Request(origin+"/admin",{headers:{
    Cookie:"unrelated=1; "+cookie+"; other=2"
  }}),envAccess,certs),true);
  const result=await handleAdmin(new Request(origin+"/admin",{headers:{Cookie:cookie}}),envAccess,certs);
  assert.equal(result.status,200);
});

test("invalid, forged, duplicate and unauthorized Access cookies are all denied",async()=>{
  const cases=[
    "CF_Authorization=not-a-jwt",
    "CF_Authorization="+assertion({}, {signature:"forged"}),
    "CF_Authorization="+assertion({email:"other@example.test"}),
    "CF_Authorization="+assertion({aud:["other-audience"]}),
    "CF_Authorization="+assertion()+"; CF_Authorization="+assertion()
  ];
  for(const cookie of cases){
    const res=await handleAdmin(new Request(origin+"/admin",{headers:{Cookie:cookie}}),envAccess,certs);
    assert.equal(res.status,403);
    assert.equal(await res.text(),"Accès administrateur refusé");
  }
});

test("invalid explicit Access assertion cannot be bypassed by a valid cookie",async()=>{
  assert.equal(await authenticateAdmin(new Request(origin+"/admin",{headers:{
    "Cf-Access-Jwt-Assertion":"invalid",
    Cookie:"CF_Authorization="+assertion()
  }}),envAccess,certs),false);
});

test("valid admin sees a no-store page, access to unknown paths is denied",async()=>{
  const valid=adminRequest("/admin",assertion());
  const page=await handleAdmin(valid,envAccess,certs);
  assert.equal(page.status,200);
  assert.match(page.headers.get("content-security-policy"),/script-src 'self'/);
  assert.match(page.headers.get("cache-control"),/no-store/);
  assert.match(await page.text(),/administration|Administration/);
  assert.equal((await handleAdmin(adminRequest("/admin/api/forbidden",assertion()),envAccess,certs)).status,404);
});

test("read-only resource list exposes official routes, not custom arbitrary requests",async()=>{
  const r=await adminCatalog();
  const c=await r.json();
  assert.equal(c.resources.length,API_RESOURCES.length);
  assert.ok(!c.resources.some(item=>/post|put|delete/i.test(item.id)));
  assert.ok(c.resources.some(item=>item.id==="personal-inventory"));
  assert.ok(c.resources.some(item=>item.id==="alliance-roster"));
});

test("admin sessions list reads independently authorized accounts without exposing tokens",async()=>{
  const env=apiEnv();
  const res=await adminSessionList(env,dataFetch,new URL(origin+"/admin/api/sessions"));
  const payload=await res.json();
  assert.equal(res.status,200);
  assert.equal(payload.sessions.length,1);
  assert.equal(payload.sessions[0].allianceId,"aid001");
  assert.equal(payload.sessions[0].playerName,"Captain Alpha");
  assert.equal(payload.sessions[0].id,sid);
  assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_ACCESS_TOKEN|secretNote/);
});

test("returns complete provider payload and unknown future fields without truncating them",async()=>{
  const env=apiEnv(),res=await adminResource(adminRequest("/admin/api/data?session="+sid+
    "&resource=personal-inventory&page=1&perPage=20"),env,dataFetch);
  assert.equal(res.status,200);
  assert.match(res.headers.get("cache-control"),/no-store/);
  const body=await res.json();
  assert.equal(body.payload.data[0].extra.futureScopelyField[1],"intact");
  assert.equal(body.payload.meta.perTotal,1);
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE_ACCESS_TOKEN/);
});

test("unshared or absent member roster is forbidden before making the roster request",async()=>{
  const env=apiEnv();const paths=[];
  for(const member of ["member-2","outsider","self"]){
    const res=await adminResource(adminRequest("/admin/api/data?session="+sid+
      "&resource=alliance-roster&member="+member),env,async(url,opt)=>{
        paths.push(url);assert.ok(!url.includes("/roster/member/"));
        return dataFetch(url,opt);
      });
    assert.equal(res.status,403);
  }
  assert.equal(paths.length,3);
});

test("shared member roster includes all nested stats and metadata",async()=>{
  const env=apiEnv(),res=await adminResource(adminRequest("/admin/api/data?session="+sid+
    "&resource=alliance-roster&member=member-1&page=1&perPage=20"),env,dataFetch);
  const obj=await res.json();
  assert.equal(res.status,200);
  assert.equal(obj.payload.data[0].stats.hp,2500000);
  assert.equal(obj.payload.data[0].newField.keep,true);
  assert.equal(obj.payload.meta.newMeta,"retained");
});

test("rejects arbitrary URLs, invalid pagination and unsafe member identifiers",async()=>{
  const env=apiEnv();
  for(const path of [
    "/admin/api/data?session="+sid+"&resource=https://example.com/private",
    "/admin/api/data?session="+sid+"&resource=personal-roster&page=-1",
    "/admin/api/data?session="+sid+"&resource=personal-roster&perPage=1000",
    "/admin/api/data?session="+sid+"&resource=alliance-roster&member=../member"
  ]){
    const res=await adminResource(adminRequest(path),env,dataFetch);
    assert.equal(res.status,400);
  }
});

test("API routes with only OAuth captain login never grant admin access",async()=>{
  const env=apiEnv();
  const res=await worker.fetch(new Request(origin+"/admin/api/sessions",{headers:{
    Cookie:"__Host-losp_captain_session="+"x".repeat(43)
  }}),env);
  assert.equal(res.status,403);
});

test("admin coverage reads current alliance counts through stored grants, no R2 writes",async()=>{
  const env=apiEnv();
  env.CAPTAIN_COVERAGE_ENABLED="false";
  env.CAPTAIN_BUCKET.put=async()=>{throw Error("Admin scan must not store game data");};
  const fetchImpl=async(url,opts)=>url.endsWith("/cdn-cgi/access/certs")?
    certs():dataFetch(url,opts);
  const result=await handleAdmin(adminRequest("/admin/api/coverage",assertion()),env,fetchImpl);
  assert.equal(result.status,200);
  assert.match(result.headers.get("cache-control"),/no-store/);
  const payload=await result.json();
  assert.equal(payload.mode,"private-discovery-only");
  assert.equal(payload.complete,true);
  assert.equal(payload.scannedSessions,1);
  assert.equal(payload.alliances.length,1);
  assert.equal(payload.alliances[0].memberCount,3);
  assert.equal(payload.alliances[0].sharedCount,2);
  assert.equal(payload.alliances[0].notSharedCount,1);
  assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_ACCESS_TOKEN|Captain Alpha|Teammate|Not shared/);
});

test("admin coverage cannot be accessed with a captain cookie or forged Access header",async()=>{
  const env=apiEnv();
  let calls=0;
  const provider=async()=>{calls++;throw Error("No provider data for unauthorized client");};
  const request=new Request(origin+"/admin/api/coverage",{headers:{
    Cookie:"__Host-losp_captain_session="+"x".repeat(43),
    "Cf-Access-Authenticated-User-Email":"admin@example.test"
  }});
  assert.equal((await handleAdmin(request,env,provider)).status,403);
  assert.equal(calls,0);
  const missing=await adminCoverage({...env,CAPTAIN_BUCKET:null},provider);
  assert.equal(missing.status,503);
});
