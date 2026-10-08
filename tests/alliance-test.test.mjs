import { test } from "node:test";
import assert from "node:assert/strict";
import { probeAllianceRoster, renderAllianceProbe } from "../src/alliance-test.js";
import { handleCallback } from "../src/oauth-callback.js";
import worker from "../src/index.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const token = "PRIVATE_ACCESS_TOKEN";
const member = (id, name, shared, isSelf=false) =>
  ({id,card:{name,rosterShare:shared},isSelf});
const members = [
  member("self-id","Keryas I",true,true),
  member("other-id","Test <script>PRIVATE_XSS</script>",true),
  member("private-id","Non partagé",false)
];
const json = obj => Response.json(obj);

test("opt-in login requests only alliance profile, retains existing login",async()=>{
  const env={SCOPELY_CLIENT_ID:"client-test"};
  const regular=await worker.fetch(new Request(origin+"/login"),env);
  const extra=await worker.fetch(new Request(origin+"/login/alliance-test"),env);
  assert.equal(regular.status,302);
  assert.equal(extra.status,302);
  assert.equal(new URL(regular.headers.get("location")).searchParams.get("scope"),
    "openid m3p.f.pr.pro");
  assert.equal(new URL(extra.headers.get("location")).searchParams.get("scope"),
    "openid m3p.f.pr.pro m3p.f.ar.pro");
  assert.equal(regular.headers.getSetCookie().length,2);
  assert.equal(extra.headers.getSetCookie().length,3);
  const marker=extra.headers.getSetCookie().find(c=>c.startsWith("__Host-losp_oauth_alliance_test="));
  assert.match(marker, /Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const state=new URL(extra.headers.get("location")).searchParams.get("state");
  assert.ok(marker.includes("="+state+";"));
  assert.equal(new URL(extra.headers.get("location")).searchParams.has("client_secret"),false);
});

test("one consent allows exactly one other shared member roster probe",async()=>{
  const requested=[];
  const result=await probeAllianceRoster(token,async(url,opts)=>{
    requested.push(url);
    assert.equal(opts.headers.Authorization,"Bearer "+token);
    assert.equal(opts.headers["User-Agent"],"APIClient/1.0 (Server)");
    assert.ok(opts.headers["x-api-key"]);
    assert.equal(opts.redirect,"manual");
    assert.equal(opts.cache,"no-store");
    if(requested.length===1)return json({data:members});
    return json({data:[{id:"CHARACTER_PRIVATE_DATA"}],meta:{perTotal:382}});
  });
  assert.deepEqual(requested,[
    "https://api.marvelstrikeforce.com/player/v1/alliance/members",
    "https://api.marvelstrikeforce.com/player/v1/roster/member/other-id?page=1&perPage=1"
  ]);
  assert.deepEqual(result,{status:"roster-accessible",memberCount:3,sharedCount:1,
    candidateName:"Test <script>PRIVATE_XSS</script>",returnedCharacters:1});
  const rendered=renderAllianceProbe(result);
  assert.equal(rendered.status,200);
  assert.equal(rendered.headers.getSetCookie().length,3);
  assert.match(rendered.headers.get("cache-control"),/no-store/);
  assert.match(rendered.headers.get("content-security-policy"),/script-src 'nonce-/);
  const body=await rendered.text();
  assert.match(body,/Accès au roster confirmé/);
  assert.match(body,/Test &lt;script&gt;PRIVATE_XSS&lt;\/script&gt;/);
  assert.doesNotMatch(body,/<script>PRIVATE_XSS/);
  assert.doesNotMatch(body,/CHARACTER_PRIVATE_DATA|other-id|PRIVATE_ACCESS_TOKEN|Bearer /);
  assert.match(body,/history.replaceState/);
});

test("no shares and no other members make no roster request", async()=>{
  let calls=0;
  const result=await probeAllianceRoster(token,async()=>{
    calls++;
    return json({data:[member("me","Me",true,true),member("x","Private",false)]});
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{status:"no-shared-member",memberCount:2,sharedCount:0});
});
test("a missing member ID does not trigger a roster request",async()=>{
  let calls=0;
  const result=await probeAllianceRoster(token,async()=>{
    calls++;
    return json({data:[member("","Ghost",true)]});
  });
  assert.equal(calls,1);
  assert.equal(result.status,"no-shared-member");
});
test("NO_ACCESS on roster is a safe response and is not retried", async()=>{
  const urls=[];
  const result=await probeAllianceRoster(token,async url=>{
    urls.push(url);
    return urls.length===1?json({data:members}):new Response("",{status:464});
  });
  assert.equal(urls.length,2);
  assert.equal(result.status,"roster-failed");
  assert.equal(result.reason,"no-access");
  const html=await renderAllianceProbe(result).text();
  assert.match(html,/NO_ACCESS \(464\)/);
  assert.doesNotMatch(html,/other-id|PRIVATE_ACCESS_TOKEN/);
});

test("members 401/403/464 are reported without accessing roster",async()=>{
  for(const [status,reason] of [[401,"unauthorized"],[403,"forbidden"],[464,"no-access"]]){
    let calls=0;
    const r=await probeAllianceRoster(token,async()=>{
      calls++;return new Response("PRIVATE_BODY",{status});
    });
    assert.equal(calls,1);
    assert.equal(r.status,"members-failed");
    assert.equal(r.reason,reason);
    assert.doesNotMatch(await renderAllianceProbe(r).text(),/PRIVATE_BODY|PRIVATE_ACCESS_TOKEN/);
  }
});

test("unknown response shape refuses access and does not expose raw data",async()=>{
  let calls=0;
  const result=await probeAllianceRoster(token,async()=>{
    calls++;return json({data:{name:"PRIVATE_OTHER_PERSON"}});
  });
  assert.equal(calls,1);
  assert.equal(result.status,"invalid-members");
  assert.doesNotMatch(await renderAllianceProbe(result).text(),/PRIVATE_OTHER_PERSON/);
});

test("URL-encoded temporary member IDs cannot alter the roster path",async()=>{
  const calls=[];
  await probeAllianceRoster(token,async url=>{
    calls.push(url);
    return calls.length===1?json({data:[member("a/b?x=y","Other",true)]}):json({data:[]});
  });
  assert.equal(calls[1],"https://api.marvelstrikeforce.com/player/v1/roster/member/a%2Fb%3Fx%3Dy?page=1&perPage=1");
});

test("callback only executes probe with state-bound mode cookie",async()=>{
  const state="a".repeat(43),verifier="b".repeat(43);
  const basic="__Host-losp_oauth_state="+state+"; __Host-losp_oauth_verifier="+verifier;
  const env={SCOPELY_CLIENT_ID:"test-client-id",SCOPELY_CLIENT_SECRET:"test-secret"};
  for(const [marker,expected] of [
    ["; __Host-losp_oauth_alliance_test="+state,"alliance"],
    ["; __Host-losp_oauth_alliance_test="+"z".repeat(43),"normal"]
  ]){
    const paths=[];
    const response=await handleCallback(new Request(origin+"/oauth/callback?state="+state+"&code=code",{
      headers:{Cookie:basic+marker}
    }),env,async(url)=>{
      paths.push(url);
      if(url.includes("/oauth2/token"))return json({access_token:token,token_type:"Bearer"});
      if(url.endsWith("/player/v1/alliance/members"))return json({data:members});
      if(url.includes("/roster/member/"))return json({data:[{id:"DUMMY"}]});
      if(url.endsWith("/player/v1/card"))return json({data:{name:"Own profile"}});
      throw Error("Unexpected URL");
    });
    assert.equal(response.status,200);
    assert.equal(paths.length,expected==="alliance"?3:2);
    const page=await response.text();
    if(expected==="alliance") assert.match(page,/Test d’accès aux rosters/);
    else assert.match(page,/Own profile/);
    assert.doesNotMatch(page,/PRIVATE_ACCESS_TOKEN|code=code/);
  }
});
