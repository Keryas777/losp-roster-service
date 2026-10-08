// One-shot diagnostic of the authenticated player's own inventory.
// No persistent storage, no full-inventory download and no raw item data in HTML.
import { API_KEY } from "./player-card.js";

const INVENTORY_URL = "https://api.marvelstrikeforce.com/player/v1/inventory?page=1&perPage=1";

export async function probeInventory(accessToken, fetchImpl = fetch) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "missing-token" };
  }
  let response;
  try {
    response = await fetchImpl(INVENTORY_URL, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + accessToken,
        Accept: "application/json"
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { status: "network-error" };
  }

  if (response.status >= 300 && response.status < 400 ||
      response.type === "opaqueredirect") {
    return { status: "redirect-rejected" };
  }
  const known = new Map([
    [401, "unauthorized"], [403, "forbidden"], [464, "no-access"],
    [429, "rate-limited"], [472, "too-large"]
  ]);
  if (!response.ok) {
    return { status: known.get(response.status) || "http-error" };
  }

  try {
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || payload.data.length > 1 ||
        !payload.data.every(row => row && typeof row === "object" && !Array.isArray(row))) {
      return { status: "unexpected-response" };
    }
    // Intentionally return only a count. No item IDs, names, quantities or
    // metadata are sent to the browser, logs or a storage service.
    return { status: "accessible", returnedItems: payload.data.length };
  } catch {
    return { status: "unexpected-response" };
  }
}

const labels = {
  "missing-token": ["Test impossible", "Le token OAuth est absent."],
  unauthorized: ["Authentification refusée (401)", "Scopely n'a pas accepté l'authentification de cette requête."],
  forbidden: ["Accès interdit (403)", "Scopely n'autorise pas la lecture de cet inventaire avec les permissions obtenues."],
  "no-access": ["Accès refusé (464)", "L'API a répondu NO_ACCESS."],
  "rate-limited": ["Limitation temporaire (429)", "L'API limite temporairement les requêtes."],
  "too-large": ["Réponse trop volumineuse (472)", "Scopely a refusé la taille de la réponse."],
  "redirect-rejected": ["Redirection API inattendue", "La requête n'a pas suivi la redirection, par sécurité."],
  "http-error": ["Erreur API", "Scopely n'a pas retourné une réponse HTTP de succès."],
  "network-error": ["Erreur réseau", "La requête vers Scopely n'a pas abouti."],
  "unexpected-response": ["Format de réponse inattendu", "L'API a répondu, mais les données ne correspondent pas au format attendu."]
};

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function renderInventoryProbe(report) {
  const cspNonce = nonce();
  const success = report?.status === "accessible";
  const title = success ? "Accès à l'inventaire confirmé" :
    (labels[report?.status] || labels["http-error"])[0];
  const message = success
    ? "Scopely a répondu HTTP 200. " + report.returnedItems +
      " objet(s) renvoyé(s) sur la première page (maximum demandé : 1)."
    : (labels[report?.status] || labels["http-error"])[1];
  // title/message are fixed text or a validated count from our own code.
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Test inventaire MSF — LoSP</title>' +
    '<script nonce="' + cspNonce +
    '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + cspNonce + '">' +
    '*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#f0f5ff;' +
    'font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:640px;' +
    'margin:5vh auto;padding:22px}h1{font-size:clamp(1.7rem,5vw,2.4rem)}' +
    '.box{background:#172236;border:1px solid #33435e;border-radius:12px;padding:18px}' +
    'p{color:#b8c5d9}a{color:#83c5ff}</style></head><body><main>' +
    '<h1>Test d’accès à l’inventaire MSF</h1><section class="box"><h2>' +
    title + '</h2><p>' + message + '</p></section>' +
    '<p>Test ponctuel du compte connecté : aucun inventaire, objet, token ou ' +
    'identifiant n’a été enregistré. La page disparaîtra au rechargement.</p>' +
    '<p><a href="/">Retour à l’accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" +
      cspNonce + "'; style-src 'nonce-" + cspNonce +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const remove = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  headers.append("Set-Cookie", "__Host-losp_oauth_state=" + remove);
  headers.append("Set-Cookie", "__Host-losp_oauth_verifier=" + remove);
  headers.append("Set-Cookie", "__Host-losp_oauth_inventory_test=" + remove);
  return new Response(html, { status: 200, headers });
}
