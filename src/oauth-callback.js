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

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    });
    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: toBasicAuth(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });

    if (!tokenResponse.ok) return backToStatus("exchange-failed");

    const result = await tokenResponse.json();
    if (!result || typeof result.access_token !== "string" ||
        !result.access_token || String(result.token_type).toLowerCase() !== "bearer") {
      return backToStatus("exchange-failed");
    }

    // No scopes involving offline access are requested. Do not store or return
    // access_token, id_token or refresh_token, even if supplied by the server.
    return backToStatus("validated");
  } catch {
    // No sensitive token response, authorization code or credentials in logs.
    return backToStatus("exchange-failed");
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
