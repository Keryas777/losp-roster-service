// Scopely's published OpenAPI beta 0.2.1 requires this public x-api-key.
// This is NOT the OAuth Client Secret; update it only when official docs change.
// https://developer.marvelstrikeforce.com/beta/msf-api.json
const API_KEY = "17wMKJLRxy3pYDCKG5ciP7VSU45OVumB2biCzzgw";
const PLAYER_CARD_URL = "https://api.marvelstrikeforce.com/player/v1/card";

export async function getPlayerCard(accessToken, fetchImpl = fetch) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { ok: false, status: "profile-unavailable" };
  }

  let response;
  try {
    response = await fetchImpl(PLAYER_CARD_URL, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        Authorization: "Bearer " + accessToken,
        Accept: "application/json"
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { ok: false, status: "profile-network" };
  }

  if (response.status >= 300 && response.status < 400 ||
      response.type === "opaqueredirect") {
    return { ok: false, status: "profile-unavailable" };
  }
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403 || status === 464) {
      return { ok: false, status: "profile-forbidden" };
    }
    if (status === 429) return { ok: false, status: "profile-rate-limit" };
    return { ok: false, status: "profile-unavailable" };
  }

  try {
    const payload = await response.json();
    const card = payload?.data;
    if (!card || typeof card !== "object" || Array.isArray(card) ||
        typeof card.name !== "string" || !card.name.trim()) {
      return { ok: false, status: "profile-invalid-response" };
    }
    // Do not persist or forward the entire response. Only show known fields.
    return { ok: true, card };
  } catch {
    return { ok: false, status: "profile-invalid-response" };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function numberOrUnavailable(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? new Intl.NumberFormat("fr-FR").format(value)
    : "Non renseigné";
}

function randomNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function showEphemeralPlayerCard(card) {
  const nonce = randomNonce();
  // Escape all user-controlled fields; do not allow provider HTML or URLs.
  const rows = [
    ["Commandant", escapeHtml(card.name.slice(0, 150))],
    ["Niveau atteint", numberOrUnavailable(card.level?.completedTier)],
    ["Puissance totale (TCP)", numberOrUnavailable(card.tcp)],
    ["Puissance de la meilleure équipe (STP)", numberOrUnavailable(card.stp)],
    ["Personnages débloqués", numberOrUnavailable(card.charactersCollected)],
    ["MVP de guerre", numberOrUnavailable(card.warMvp)]
  ];
  const cells = rows.map(([name, value]) =>
    '<div class="line"><dt>' + name + '</dt><dd>' + value + "</dd></div>"
  ).join("");

  // Remove code/state from the visible URL and browser history promptly.
  // Reloading intentionally shows a neutral "temporary page expired" status.
  const html = '<!doctype html><html lang="fr"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>Profil MSF — LoSP Roster Service</title>' +
    '<script nonce="' + nonce + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + nonce + '">' +
    '*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#f0f5ff;' +
    'font:16px/1.6 system-ui,-apple-system,sans-serif}' +
    'main{max-width:640px;margin:5vh auto;padding:22px}' +
    'h1{font-size:clamp(1.7rem,5vw,2.4rem);line-height:1.2}' +
    '.box{background:#172236;border:1px solid #33435e;border-radius:12px;padding:18px}' +
    'dl{margin:0}.line{padding:10px 0;border-bottom:1px solid #33435e}' +
    '.line:last-child{border:0}dt{font-size:.85rem;color:#b8c5d9}dd{margin:0;font-weight:600;' +
    'overflow-wrap:anywhere}p{color:#b8c5d9}a{color:#83c5ff}' +
    '</style></head><body><main>' +
    '<h1>Votre profil Marvel Strike Force</h1>' +
    '<p>Lecture réalisée à l’instant depuis l’API officielle Scopely.</p>' +
    '<section class="box"><dl>' + cells + '</dl></section>' +
    '<p>Test temporaire : aucun profil ni token n’a été enregistré par LoSP Roster Service. ' +
    'Cette page disparaîtra au rechargement.</p>' +
    '<p><a href="/">Retour à l’accueil</a></p>' +
    '</main></body></html>';

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'nonce-" + nonce +
      "'; style-src 'nonce-" + nonce +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const attributes = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  headers.append("Set-Cookie", "__Host-losp_oauth_state=" + attributes);
  headers.append("Set-Cookie", "__Host-losp_oauth_verifier=" + attributes);
  return new Response(html, { status: 200, headers });
}
