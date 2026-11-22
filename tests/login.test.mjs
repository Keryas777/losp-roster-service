import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker,{startLogin} from "../src/index.js";

const origin = "https://losp-roster-service.deliriousfan7.workers.dev";
const env = { SCOPELY_CLIENT_ID: "test-client-id" };
const call = (path, options = {}, bindings = env) =>
  worker.fetch(new Request(origin + path, options), bindings);

function cookiesFrom(response) {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  return Object.fromEntries(cookies.map(cookie => {
    const [pair] = cookie.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    assert.match(cookie, /; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.doesNotMatch(cookie, /; Domain=/i);
    return [name, value];
  }));
}

test("GET /login constructs Scopely OAuth 2.0 authorization code URL with PKCE", async () => {
  const response = await call("/login");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-robots-tag"), "noindex");

  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin, "https://hydra-public.prod.m3.scopelypv.com");
  assert.equal(target.pathname, "/oauth2/auth");
  assert.equal(target.searchParams.get("response_type"), "code");
  assert.equal(target.searchParams.get("client_id"), env.SCOPELY_CLIENT_ID);
  assert.equal(target.searchParams.get("redirect_uri"), origin + "/oauth/callback");
  assert.equal(target.searchParams.get("scope"), "openid m3p.f.pr.pro");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.has("client_secret"), false);

  const cookies = cookiesFrom(response);
  const state = cookies["__Host-losp_oauth_state"];
  const verifier = cookies["__Host-losp_oauth_verifier"];
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(target.searchParams.get("state"), state);
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(target.searchParams.get("code_challenge"), expectedChallenge);
});

test("each login generates unique state and verifier", async () => {
  const a = cookiesFrom(await call("/login"));
  const b = cookiesFrom(await call("/login"));
  assert.notEqual(a["__Host-losp_oauth_state"], b["__Host-losp_oauth_state"]);
  assert.notEqual(a["__Host-losp_oauth_verifier"], b["__Host-losp_oauth_verifier"]);
});

test("personal events OAuth requests only profile, event access and offline scopes", async () => {
  const bindings={...env,CAPTAIN_SESSIONS_ENABLED:"true",CAPTAIN_ENCRYPTION_KEY_HEX:"a".repeat(64),
    CAPTAIN_BUCKET:{put(){},get(){},delete(){}},CAPTAIN_REFRESH_COORDINATOR:{idFromName(){}}};
  const response = await call("/login/events",{},bindings);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.searchParams.get("scope"),
    "openid m3p.f.pr.pro m3p.f.pr.act offline");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  const marker = cookies.find(value => value.startsWith("__Host-losp_oauth_personal_events="));
  assert.ok(marker);
  assert.ok(marker.includes("=" + target.searchParams.get("state") + ";"));
  assert.match(marker,/HttpOnly; SameSite=Lax/);
  const unavailable=await call("/login/events");
  assert.equal(unavailable.status,503);
});

test("login refuses non-production hosts", async () => {
  const response = await worker.fetch(
    new Request("https://preview.example.workers.dev/login"), env
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
});

test("login fails closed when no Client ID is configured", async () => {
  const response = await call("/login", {}, {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("login accepts GET only", async () => {
  const response = await call("/login", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("health, home and unknown routes retain existing Worker behavior", async () => {
  const health = await call("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok", service: "losp-roster-service", version: "0.1.2"
  });
  const home = await call("/");
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), origin + "/index.html");
  const notFound = await call("/missing");
  assert.equal(notFound.status, 404);
});

test("lab OAuth targets only its fixed staging callback and requests only personal read scopes",async()=>{
  const labOrigin="https://losp-personal-event-lab.deliriousfan7.workers.dev";
  const labEnv={SCOPELY_CLIENT_ID:"lab-client",PERSONAL_EVENT_LAB_MODE:"true",
    LOSP_APP_ORIGIN:labOrigin,CAPTAIN_SESSIONS_ENABLED:"true",
    CAPTAIN_ENCRYPTION_KEY_HEX:"ab".repeat(32),
    CAPTAIN_BUCKET:{put(){},get(){},delete(){}},
    CAPTAIN_REFRESH_COORDINATOR:{idFromName(){},get(){}}};
  const response=await startLogin(new Request(labOrigin+"/login/events-lab"),labEnv,
    new URL(labOrigin+"/login/events-lab"));
  assert.equal(response.status,302);
  const authorize=new URL(response.headers.get("location"));
  assert.equal(authorize.searchParams.get("redirect_uri"),labOrigin+"/oauth/callback");
  assert.equal(authorize.searchParams.get("scope"),
    "openid m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act offline");
  assert.ok(response.headers.getSetCookie().some(cookie=>cookie.startsWith("__Host-losp_oauth_personal_events_lab=")));
});
