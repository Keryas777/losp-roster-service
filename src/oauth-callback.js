import { probeAllianceProfiles, renderAllianceProfiles } from "./profiles-test.js";
import { probeCoverage, renderCoverage } from "./coverage-test.js";
import { probeCardTypes, renderCardTypes } from "./card-types-test.js";
import { probeInventory, renderInventoryProbe } from "./inventory-test.js";
import { probeAllianceRoster, probeOwnRoster, renderAllianceProbe } from "./alliance-test.js";
import { getPlayerCard, showEphemeralPlayerCard } from "./player-card.js";

// First OAuth callback validation: tokens are deliberately not persisted.
// This allows an end-to-end authorization test without a token database.
const APP_ORIGIN = "https://losp-roster-service.deliriousfan7.workers.dev";
const REDIRECT_URI = APP_ORIGIN + "/oauth/callback";
const TOKEN_URL = "https://hydra-public.prod.m3.scopelypv.com/oauth2/token";
const COOKIE_STATE = "__Host-losp_oauth_state";
const COOKIE_VERIFIER = "__Host-losp_oauth_verifier";
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readCookie(header, name) {
  const values = header.split(";").map(part => part.trim())
    .filter(part => part.startsWith(name + "="))
    .map(part => part.slice(name.length + 1));
  return values.length === 1 && CODE_PATTERN.test(values[0]) ? values[0] : null;
}

function equalStates(left, right) {
  if (!left || !right || left.length !== 43 || right.length !== 43 ||
      !CODE_PATTERN.test(left) || !CODE_PATTERN.test(right)) return false;
  let diff = 0;
  for (let i = 0; i < 43; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function clearOAuthCookies(headers) {
  const attributes = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  headers.append("Set-Cookie", COOKIE_STATE + "=" + attributes);
  headers.append("Set-Cookie", COOKIE_VERIFIER + "=" + attributes);
}

function backToStatus(result, status = 303) {
  const headers = new Headers({
    Location: APP_ORIGIN + "/oauth/status?result=" + result,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex"
  });
  clearOAuthCookies(headers);
  return new Response(null, { status, headers });
}

// Only these OAuth protocol error identifiers can reach the status page.
// Never reflect provider error descriptions, token payloads or arbitrary URLs.
const SAFE_PROVIDER_ERRORS = new Set([
  "invalid_client", "invalid_grant", "invalid_request", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "server_error",
  "temporarily_unavailable"
]);

async function classifyTokenFailure(response) {
  try {
    const parsed = await response.json();
    const error = parsed && parsed.error;
    if (typeof error === "string" && SAFE_PROVIDER_ERRORS.has(error)) {
      return "exchange-" + error.replaceAll("_", "-");
    }
  } catch {
    // Provider's error body may not be JSON; never echo it.
  }
  if (response.status === 400) return "exchange-http-400";
  if (response.status === 401 || response.status === 403) return "exchange-http-auth";
  if (response.status === 429) return "exchange-rate-limit";
  if (response.status >= 500) return "exchange-server";
  return "exchange-rejected";
}

function toBasicAuth(clientId, clientSecret) {
  const raw = new TextEncoder().encode(clientId + ":" + clientSecret);
  return "Basic " + btoa(String.fromCharCode(...raw));
}

export async function handleCallback(request, env, fetchImpl = fetch) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" }
    });
  }

  const url = new URL(request.url);
  if (url.origin !== APP_ORIGIN) return new Response("Not Found", { status: 404 });

  const cookies = request.headers.get("Cookie") || "";
  const expectedState = readCookie(cookies, COOKIE_STATE);
  const verifier = readCookie(cookies, COOKIE_VERIFIER);
  const suppliedState = url.searchParams.get("state");
  const allianceMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_alliance_test"), expectedState);
  const rosterScopeMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_roster_scope_test"), expectedState);
  const inventoryMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_inventory_test"), expectedState);
  const profilesMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_profiles_test"), expectedState);
  const coverageMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_coverage_test"), expectedState);
  const cardTypesMode = equalStates(
    readCookie(cookies, "__Host-losp_oauth_card_types_test"), expectedState);

  // Check CSRF even when Scopely returned a denied-consent error.
  if (!equalStates(expectedState, suppliedState) || !verifier) {
    return backToStatus("invalid");
  }

  if (url.searchParams.has("error")) return backToStatus("denied");

  const code = url.searchParams.get("code");
  if (!code || code.length > 8192) return backToStatus("invalid");

  const clientId = env?.SCOPELY_CLIENT_ID;
  const clientSecret = env?.SCOPELY_CLIENT_SECRET;
  if (typeof clientId !== "string" || !clientId ||
      typeof clientSecret !== "string" || !clientSecret) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    });
    clearOAuthCookies(headers);
    return new Response("OAuth server configuration is incomplete", {
      status: 503, headers
    });
  }

  // Separate local request construction errors from outbound fetch failures.
  // Return only fixed categories: no secrets, codes, URLs or raw exceptions.
  let tokenRequest;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    });
    tokenRequest = {
      method: "POST",
      headers: {
        Authorization: toBasicAuth(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      // Do not follow a redirect with Basic credentials or the OAuth code.
      // Inspecting 3xx separately also avoids misclassifying it as a fetch failure.
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    };
  } catch {
    return backToStatus("exchange-local-error");
  }

  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(TOKEN_URL, tokenRequest);
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return backToStatus("exchange-timeout");
    }
    if (error instanceof TypeError || (error && error.name === "TypeError")) {
      return backToStatus("exchange-fetch-type-error");
    }
    return backToStatus("exchange-fetch-error");
  }

  try {
    // A redirect from a token endpoint is not an OAuth success.
    // Do not follow it and do not display any Location header.
    if ((tokenResponse.status >= 300 && tokenResponse.status < 400) ||
        tokenResponse.type === "opaqueredirect") {
      return backToStatus("exchange-redirect");
    }
    if (!tokenResponse.ok) return backToStatus(await classifyTokenFailure(tokenResponse));

    let result;
    try {
      result = await tokenResponse.json();
    } catch {
      return backToStatus("exchange-unexpected-response");
    }
    if (!result || typeof result.access_token !== "string" ||
        !result.access_token || String(result.token_type).toLowerCase() !== "bearer") {
      return backToStatus("exchange-unexpected-response");
    }

    // A single authorized GET; never persist or return any OAuth token.
    // The token remains in this request's memory only.
    if (cardTypesMode && !coverageMode && !profilesMode && !allianceMode &&
        !rosterScopeMode && !inventoryMode) {
      return renderCardTypes(await probeCardTypes(result.access_token, fetchImpl));
    }
    if (coverageMode && !profilesMode && !allianceMode && !rosterScopeMode && !inventoryMode) {
      return renderCoverage(await probeCoverage(result.access_token, fetchImpl));
    }
    if (profilesMode && !allianceMode && !rosterScopeMode && !inventoryMode) {
      return renderAllianceProfiles(await probeAllianceProfiles(result.access_token, fetchImpl));
    }
    if (inventoryMode && !allianceMode && !rosterScopeMode) {
      // Temporary inventory check; the response is reduced to a safe count.
      return renderInventoryProbe(await probeInventory(result.access_token, fetchImpl));
    }
    if (allianceMode) {
      // This extra request occurs only for the explicit roster-scope test.
      const ownRoster = rosterScopeMode
        ? await probeOwnRoster(result.access_token, fetchImpl) : null;
      const report = await probeAllianceRoster(result.access_token, fetchImpl);
      return renderAllianceProbe(ownRoster ? { ...report, ownRoster } : report);
    }
    const profile = await getPlayerCard(result.access_token, fetchImpl);
    if (!profile.ok) return backToStatus(profile.status);
    return showEphemeralPlayerCard(profile.card);
  } catch {
    // No provider response data is ever reflected.
    return backToStatus("exchange-processing-error");
  }
}

export function handleOAuthStatus(request) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" }
    });
  }
  const url = new URL(request.url);
  if (url.origin !== APP_ORIGIN) return new Response("Not Found", { status: 404 });

  const messages = {
    validated: [
      "Autorisation Scopely vérifiée",
      "Le code OAuth a été échangé avec succès. Pour ce premier test, aucun token n'a été conservé et votre compte n'est pas encore lié durablement."
    ],
    "profile-expired": [
      "Page temporaire expirée",
      "Le profil n’est pas enregistré. Pour le consulter à nouveau, recommencez depuis /login."
    ],
    "profile-unavailable": [
      "Profil Scopely indisponible",
      "L’API n’a pas renvoyé le profil attendu. Aucun token n’a été conservé."
    ],
    "profile-unauthorized": [
      "Authentification API refusée (401)",
      "Scopely n’a pas reconnu les informations d’authentification de l’appel au profil. Aucun token n’a été conservé."
    ],
    "profile-forbidden": [
      "Accès au profil interdit (403)",
      "Scopely a refusé l’accès au profil malgré la connexion OAuth. Aucun token n’a été conservé."
    ],
    "profile-no-access": [
      "Aucun accès au profil (464)",
      "L’API Scopely a répondu NO_ACCESS. Aucun token n’a été conservé."
    ],
    "profile-rate-limit": [
      "Limite d’appels API atteinte",
      "Scopely limite temporairement les accès au profil. Réessayez plus tard."
    ],
    "profile-network": [
      "Erreur de communication avec l’API",
      "Le Worker n’a pas pu récupérer la carte joueur. Aucun token n’a été conservé."
    ],
    "profile-invalid-response": [
      "Réponse profil inattendue",
      "Scopely a répondu, mais les données n’ont pas le format attendu."
    ],
    denied: [
      "Autorisation refusée ou annulée",
      "Aucune connexion n'a été enregistrée."
    ],
    invalid: [
      "Vérification de sécurité non valide",
      "La demande a expiré ou ne correspond plus à la session de départ. Recommencez depuis /login."
    ],
    "exchange-failed": [
      "Échange OAuth non abouti",
      "Le service n'a conservé aucun token. Réessayez plus tard."
    ],
    "exchange-invalid-client": [
      "Identifiants OAuth refusés",
      "Scopely n'a pas authentifié notre application. Vérifier la configuration des secrets Client ID et Client Secret côté Cloudflare."
    ],
    "exchange-invalid-grant": [
      "Code d'autorisation refusé",
      "Le code est expiré, déjà utilisé ou ne correspond pas au callback ou au vérificateur PKCE. Recommencez depuis /login."
    ],
    "exchange-invalid-request": [
      "Requête OAuth incorrecte",
      "Scopely refuse un paramètre de notre demande d'échange. Aucun token n'a été conservé."
    ],
    "exchange-unauthorized-client": [
      "Application non autorisée",
      "L'application Scopely n'est pas autorisée à utiliser cet échange OAuth."
    ],
    "exchange-unsupported-grant-type": [
      "Type d'autorisation refusé",
      "Scopely ne reconnaît pas le mode authorization_code demandé."
    ],
    "exchange-invalid-scope": [
      "Autorisation OAuth incompatible",
      "Un scope demandé n'est pas accepté par Scopely."
    ],
    "exchange-server-error": [
      "Erreur du serveur Scopely",
      "L'échange n'a pas abouti à cause d'une erreur côté fournisseur."
    ],
    "exchange-temporarily-unavailable": [
      "Scopely temporairement indisponible",
      "Réessayez plus tard."
    ],
    "exchange-http-400": [
      "Requête OAuth rejetée (HTTP 400)",
      "Scopely a rejeté la demande sans code d'erreur OAuth exploitable."
    ],
    "exchange-http-auth": [
      "Échange OAuth rejeté (HTTP 401/403)",
      "Scopely a refusé l'échange ou l'identification de l'application."
    ],
    "exchange-rate-limit": [
      "Limite d'appels atteinte",
      "Scopely a temporairement limité les requêtes OAuth."
    ],
    "exchange-server": [
      "Serveur OAuth indisponible",
      "Scopely a retourné une erreur serveur."
    ],
    "exchange-rejected": [
      "Échange OAuth rejeté",
      "Scopely a refusé l'échange ; aucun token n'a été conservé."
    ],
    "exchange-unexpected-response": [
      "Réponse OAuth inattendue",
      "Le serveur a répondu, mais le format du token n'a pas pu être validé."
    ],
    "exchange-network": [
      "Erreur réseau OAuth",
      "Le Worker n'a pas pu terminer la requête vers Scopely."
    ],
    "exchange-local-error": [
      "Préparation OAuth impossible",
      "Une exception est survenue avant l'envoi de la requête vers Scopely."
    ],
    "exchange-timeout": [
      "Délai OAuth dépassé",
      "La requête vers Scopely n'a pas abouti dans le délai imparti."
    ],
    "exchange-fetch-type-error": [
      "Échec technique du fetch OAuth",
      "Le Worker a rencontré une erreur de requête ou de transport avant de recevoir une réponse HTTP."
    ],
    "exchange-fetch-error": [
      "Requête OAuth interrompue",
      "Le Worker n'a pas reçu de réponse HTTP exploitable de Scopely."
    ],
    "exchange-redirect": [
      "Redirection inattendue de Scopely",
      "L'endpoint de tokens a tenté une redirection. Le Worker ne l'a pas suivie pour protéger les identifiants."
    ],
    "exchange-processing-error": [
      "Traitement de la réponse OAuth impossible",
      "Une erreur est survenue après l'envoi de la requête. Aucune donnée OAuth n'a été conservée."
    ]
  };
  const [title, message] = messages[url.searchParams.get("result")] || messages.invalid;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LoSP Roster Service — OAuth</title><style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#0b1220;color:#f0f5ff;margin:0}main{max-width:600px;margin:12vh auto;padding:24px}a{color:#83c5ff}p{color:#b8c5d9}</style></head><body><main><h1>${title}</h1><p>${message}</p><p><a href="/">Retour à l'accueil</a></p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    }
  });
}
