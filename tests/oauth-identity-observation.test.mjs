import test from "node:test";
import assert from "node:assert/strict";
import {observeIdToken,attachOAuthObservationCookie,readOAuthObservationCookie,
  clearOAuthObservationCookie} from "../src/oauth-identity-observation.js";

const env={CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64)};
const SESSION="a".repeat(43);
const b64=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt=(header,claims)=>`${b64(header)}.${b64(claims)}.synthetic-signature`;

test("missing and malformed ID tokens are observed without token material",()=>{
  assert.deepEqual(observeIdToken(undefined),{
    source:"oauth-response",idTokenReceived:"no",format:"not-applicable",
    identityAvailable:"no",issuerPresent:false,subjectPresent:false,algorithm:null,
    algorithmCandidateAllowed:false,signingKeys:"not-checked",cryptographicallyVerified:false,
    issuerAudienceTimeValid:false,stability:"not-verifiable",reason:"id-token-not-returned"
  });
  for(const token of ["not-a-jwt","a.b","a.b.c.d",jwt({alg:"none"},{iss:"issuer",sub:"private-subject"})]){
    const observed=observeIdToken(token);
    assert.equal(observed.cryptographicallyVerified,false);
    assert.doesNotMatch(JSON.stringify(observed),/private-subject|issuer\.invalid/);
  }
});

test("JWT-shaped claims and allowed algorithm are detected but never treated as verified",()=>{
  const observed=observeIdToken(jwt({alg:"RS256",kid:"private-key-id"},
    {iss:"https://issuer.invalid",sub:"private-subject",aud:"private-client"}));
  assert.equal(observed.idTokenReceived,"yes");
  assert.equal(observed.issuerPresent,true);assert.equal(observed.subjectPresent,true);
  assert.equal(observed.identityAvailable,"claims-present-unverified");
  assert.equal(observed.algorithm,"RS256");assert.equal(observed.algorithmCandidateAllowed,true);
  assert.equal(observed.signingKeys,"not-checked");assert.equal(observed.cryptographicallyVerified,false);
  assert.equal(observed.issuerAudienceTimeValid,false);assert.equal(observed.stability,"not-verifiable");
  assert.doesNotMatch(JSON.stringify(observed),/private-subject|issuer\.invalid|private-client|private-key-id/);
});

test("signature, issuer, audience, time and cross-session identity are not accepted without trusted OIDC keys",()=>{
  const cases=[
    {iss:"https://expected.invalid",sub:"same-account",aud:"client",exp:Date.now()/1000+3600},
    {iss:"https://wrong.invalid",sub:"same-account",aud:"other-client",exp:1},
    {iss:"https://expected.invalid",sub:"different-account",aud:"client",exp:1}
  ];
  const outputs=cases.map(claims=>observeIdToken(jwt({alg:"RS256",kid:"untrusted-kid"},claims)));
  for(const output of outputs){
    assert.equal(output.cryptographicallyVerified,false);
    assert.equal(output.issuerAudienceTimeValid,false);
    assert.equal(output.signingKeys,"not-checked");
    assert.equal(output.stability,"not-verifiable");
    assert.equal(output.reason,"trusted-issuer-and-key-source-not-configured");
  }
  assert.doesNotMatch(JSON.stringify(outputs),/expected\.invalid|wrong\.invalid|same-account|different-account|other-client|untrusted-kid/);
  assert.equal(observeIdToken(jwt({alg:"HS256"},{iss:"issuer",sub:"account"})).reason,
    "algorithm-not-in-candidate-allowlist");
});

test("the short-lived observation cookie is HMAC-protected and carries only fixed metadata",async()=>{
  const observation=observeIdToken(jwt({alg:"PS256"},{iss:"issuer",sub:"private-subject"}));
  const response=await attachOAuthObservationCookie(new Response(null,{status:303}),observation,env,SESSION);
  const setCookie=response.headers.getSetCookie().find(value=>value.startsWith("__Host-losp_oidc_observation="));
  assert.match(setCookie,/Max-Age=900; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  const value=setCookie.split(";",1)[0].split("=")[1];
  const request=new Request("https://losp-roster-service.deliriousfan7.workers.dev/admin/api/event-planner",{
    headers:{Cookie:"__Host-losp_oidc_observation="+value+"; __Host-losp_captain_session="+SESSION}});
  const read=await readOAuthObservationCookie(request,env);
  assert.equal(read.algorithm,"PS256");assert.equal(read.subjectPresent,true);
  assert.doesNotMatch(JSON.stringify(read),/private-subject|issuer\.invalid|private-key-id/);
  const tampered=value.slice(0,-1)+(value.endsWith("a")?"b":"a");
  const bad=await readOAuthObservationCookie(new Request(request.url,{headers:{Cookie:
    "__Host-losp_oidc_observation="+tampered+"; __Host-losp_captain_session="+SESSION}}),env);
  assert.equal(bad,null);
  const other=await readOAuthObservationCookie(new Request(request.url,{headers:{Cookie:
    "__Host-losp_oidc_observation="+value+"; __Host-losp_captain_session="+"b".repeat(43)}}),env);
  assert.equal(other,null);
  const cleared=clearOAuthObservationCookie(new Response(null));
  assert.match(cleared.headers.getSetCookie().at(-1),/__Host-losp_oidc_observation=; Max-Age=0/);
});
