// Optional one-shot diagnostic: 2 GETs, 1 shared alliance member, types only.
// Neither OAuth tokens nor raw player values/keys are returned or persisted.
import { API_KEY } from "./player-card.js";

const API_ORIGIN = "https://api.marvelstrikeforce.com";
const CARD_FIELDS = new Set([
  "name", "icon", "frame", "level", "tcp", "stp", "warMvp",
  "charactersCollected", "charactersAtMaxStarRank", "bestArena",
  "latestArena", "latestBlitz", "blitzWins", "rosterShare",
  "application", "aid", "ad", "qualifications"
]);
// This single, documented legacy field is not a LoSP feature.
const LEGACY_FIELD = "wwPoints";
const isObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function jsonKind(value, exists = true) {
  if (!exists) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unexpected";
}

export function inspectCardTypes(card) {
  if (!isObject(card) || typeof card.name !== "string" || !card.name.trim()) {
    return { status: "invalid-card" };
  }
  let unknownCount = 0;
  for (const key of Object.keys(card)) {
    if (!CARD_FIELDS.has(key) && key !== LEGACY_FIELD) unknownCount++;
  }
  return {
    status: "ok",
    rosterShare: jsonKind(card.rosterShare, Object.hasOwn(card, "rosterShare")),
    aid: jsonKind(card.aid, Object.hasOwn(card, "aid")),
    legacyField: Object.hasOwn(card, LEGACY_FIELD)
      ? jsonKind(card[LEGACY_FIELD]) : "absent",
    unknownCount
  };
}

async function requestApi(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(API_ORIGIN + path, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(9000)
    });
  } catch {
    return { status: "network-error" };
  }
  if (response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)) {
    return { status: "redirect" };
  }
  if (!response.ok) return { status: "http-error", http: response.status };
  try {
    const parsed = await response.json();
    return isObject(parsed) ? { status: "ok", data: parsed.data, http: response.status }
      : { status: "invalid-envelope" };
  } catch {
    return { status: "invalid-json" };
  }
}

export async function probeCardTypes(token, fetchImpl = fetch) {
  if (typeof token !== "string" || !token) return { status: "missing-token" };

  const members = await requestApi("/player/v1/alliance/members", token, fetchImpl);
  if (members.status !== "ok") {
    return { status: "members-failed", reason: members.status, http: members.http || null };
  }
  const list = members.data;
  if (!Array.isArray(list) || list.length < 2 || list.length > 30 ||
      !list.every(row => isObject(row) && isObject(row.card)) ||
      list.filter(row => row.isSelf === true).length !== 1) {
    return { status: "invalid-members" };
  }

  // Select one consenting alliance teammate, never self or a user-supplied ID.
  const candidate = list.find(row =>
    row.isSelf !== true && row.card.rosterShare === true &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256);
  if (!candidate) return { status: "no-shared-member" };

  const player = await requestApi(
    "/player/v1/card/member/" + encodeURIComponent(candidate.id),
    token, fetchImpl
  );
  if (player.status !== "ok") {
    return { status: "player-failed", reason: player.status, http: player.http || null };
  }
  return inspectCardTypes(player.data);
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function esc(text) {
  return String(text).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function renderCardTypes(report) {
  const n = nonce();
  // Report contains only fixed labels, fixed type names, HTTP status and count.
  let rows = "";
  if (report.status === "ok") {
    for (const [label, value] of [
      ["rosterShare — type JSON", report.rosterShare],
      ["aid — type JSON", report.aid],
      ["wwPoints (historique, exclu) — type JSON", report.legacyField],
      ["Autres propriétés inconnues (nom masqué)", report.unknownCount]
    ]) {
      rows += '<div class="line"><span>' + esc(label) + "</span><strong>" +
        esc(value) + "</strong></div>";
    }
  } else {
    rows = "<p>Diagnostic incomplet : " + esc(report.status) +
      (report.reason ? " (" + esc(report.reason) + ")" : "") +
      (Number.isInteger(report.http) ? " — HTTP " + report.http : "") + "</p>";
  }
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Types PlayerCard — LoSP</title>' +
    '<script nonce="' + n + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + n + '">*{box-sizing:border-box}body{margin:0;background:#0b1220;' +
    'color:#f0f5ff;font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:640px;' +
    'margin:5vh auto;padding:22px}h1{font-size:clamp(1.6rem,5vw,2.2rem)}.box{background:#172236;' +
    'border:1px solid #33435e;border-radius:12px;padding:18px}.line{display:flex;' +
    'justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #33435e;' +
    'flex-wrap:wrap}span,p{color:#b8c5d9}strong{overflow-wrap:anywhere}a{color:#83c5ff}' +
    '</style></head><body><main><h1>Types des champs PlayerCard</h1>' +
    '<section class="box"><p>Statut : ' + esc(report.status) + "</p>" + rows +
    '</section><p>Deux appels Scopely maximum, sur un seul coéquipier partageant. ' +
    'Aucune valeur, identifiant privé, clé inconnue, token ou réponse brute affichés ou conservés. ' +
    'Un type JSON ne confirme pas la validité métier.</p><p><a href="/">Retour</a></p>' +
    "</main></body></html>";
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + n +
      "'; style-src 'nonce-" + n +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const clear = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of ["state", "verifier", "card_types_test"]) {
    headers.append("Set-Cookie", "__Host-losp_oauth_" + name + "=" + clear);
  }
  return new Response(html, { status: 200, headers });
}
