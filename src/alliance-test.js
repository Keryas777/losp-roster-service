import { API_KEY } from "./player-card.js";

const ORIGIN = "https://api.marvelstrikeforce.com";
const AGENT = "APIClient/1.0 (Server)";

function headersFor(token) {
  return {
    "x-api-key": API_KEY,
    "User-Agent": AGENT,
    Authorization: "Bearer " + token,
    Accept: "application/json"
  };
}

async function callApi(path, token, fetchImpl) {
  try {
    const response = await fetchImpl(ORIGIN + path, {
      method: "GET", headers: headersFor(token),
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10000)
    });
    if (response.status === 464) return { status: "no-access" };
    if (response.status === 401) return { status: "unauthorized" };
    if (response.status === 403) return { status: "forbidden" };
    if (response.status === 429) return { status: "rate-limited" };
    if (!response.ok) return { status: "http-error", httpCode: response.status };
    try {
      return { status: "ok", data: await response.json() };
    } catch {
      return { status: "invalid-json" };
    }
  } catch {
    return { status: "network-error" };
  }
}

/**
 * Explicit one-shot probe: exactly one members request, then at most one
 * roster request for a NON-SELF member with rosterShare === true.
 * This is NOT a bulk roster collector and must not persist data.
 */
export async function probeAllianceRoster(accessToken, fetchImpl = fetch) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "missing-token" };
  }
  const members = await callApi("/player/v1/alliance/members", accessToken, fetchImpl);
  if (members.status !== "ok") {
    return { status: "members-failed", reason: members.status, httpCode: members.httpCode };
  }
  const roster = members.data?.data;
  if (!Array.isArray(roster) || roster.length > 100 ||
      !roster.every(row => row && typeof row === "object" && !Array.isArray(row))) {
    return { status: "invalid-members" };
  }

  const sharedMembers = roster.filter(row =>
    row.isSelf !== true && row.card?.rosterShare === true);
  const candidate = sharedMembers.find(row =>
    typeof row.id === "string" && row.id.length > 0 &&
    row.id.length <= 256 && typeof row.card?.name === "string");

  const summary = {
    memberCount: roster.length,
    sharedCount: sharedMembers.length
  };
  if (!candidate) return {
    status: "no-shared-member", ...summary
  };

  // Member IDs are temporary and refreshed from this call each time.
  // Limit the response to the first page, one character: this is solely
  // an access test, not a snapshot of another player's complete roster.
  const result = await callApi(
    "/player/v1/roster/member/" + encodeURIComponent(candidate.id) +
    "?page=1&perPage=1",
    accessToken, fetchImpl
  );
  if (result.status !== "ok") return {
    status: "roster-failed", ...summary,
    candidateName: candidate.card.name.slice(0, 120),
    reason: result.status, httpCode: result.httpCode
  };
  if (!Array.isArray(result.data?.data)) return {
    status: "invalid-roster", ...summary,
    candidateName: candidate.card.name.slice(0, 120)
  };
  return {
    status: "roster-accessible", ...summary,
    candidateName: candidate.card.name.slice(0, 120),
    returnedCharacters: result.data.data.length
  };
}

// One page only: verify the explicit personal View Roster scope before
// independently testing alliance roster access (never bulk-download data).
export async function probeOwnRoster(accessToken, fetchImpl = fetch) {
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "missing-token" };
  }
  const result = await callApi("/player/v1/roster?page=1&perPage=1", accessToken, fetchImpl);
  if (result.status !== "ok") {
    return { status: result.status, httpCode: result.httpCode };
  }
  if (!Array.isArray(result.data?.data)) {
    return { status: "invalid-roster" };
  }
  return { status: "accessible", returnedCharacters: result.data.data.length };
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function safeCount(x) { return Number.isInteger(x) && x >= 0 ? String(x) : "?"; }
const explanations = {
  "no-access": "Scopely a répondu NO_ACCESS (464). Le partage et les permissions effectives sont à examiner.",
  unauthorized: "L'API a refusé l'authentification (401).",
  forbidden: "L'API a interdit l'accès (403).",
  "rate-limited": "L'API limite les requêtes (429).",
  "http-error": "Scopely a retourné un autre code HTTP.",
  "invalid-json": "La réponse API n'est pas du JSON valide.",
  "network-error": "L'appel API a échoué sur le réseau."
};

export function renderAllianceProbe(report) {
  const cspNonce = nonce();
  let detail;
  if (report.status === "members-failed") {
    detail = "<h2>Liste des membres inaccessible</h2><p>" +
      esc(explanations[report.reason] || "Erreur API.") +
      (Number.isInteger(report.httpCode) ? " (HTTP " + report.httpCode + ")" : "") +
      "</p>";
  } else if (report.status === "invalid-members") {
    detail = "<h2>Liste des membres inattendue</h2><p>Le format de réponse n'est pas reconnu.</p>";
  } else {
    detail = "<p>Membres de l'alliance du compte connecté : <strong>" +
      safeCount(report.memberCount) +
      "</strong></p><p>Coéquipiers partageant leur roster : <strong>" +
      safeCount(report.sharedCount) + "</strong></p>";
    if (report.status === "no-shared-member") {
      detail += "<h2>Aucun roster testé</h2><p>Aucun autre membre avec partage activé et identifiant valide n'a été trouvé.</p>";
    } else if (report.status === "roster-accessible") {
      detail += "<h2>Accès au roster confirmé</h2><p>Coéquipier testé : <strong>" +
        esc(report.candidateName) +
        "</strong></p><p>Scopely a répondu HTTP 200 : " +
        safeCount(report.returnedCharacters) +
        " personnage(s) renvoyé(s) sur la page d'essai (maximum demandé : 1).</p>";
    } else if (report.status === "roster-failed") {
      detail += "<h2>Lecture du roster refusée</h2><p>Coéquipier testé : <strong>" +
        esc(report.candidateName) + "</strong></p><p>" +
        esc(explanations[report.reason] || "Erreur API.") +
        (Number.isInteger(report.httpCode) ? " (HTTP " + report.httpCode + ")" : "") +
        "</p>";
    } else {
      detail += "<h2>Réponse roster inattendue</h2><p>Le format de réponse n'est pas reconnu.</p>";
    }
  }

  if (report.ownRoster) {
    const own = report.ownRoster;
    const ownDetail = own.status === "accessible"
      ? "Accès au roster personnel confirmé (HTTP 200). " +
        safeCount(own.returnedCharacters) + " personnage(s) renvoyé(s) sur la page test."
      : own.status === "invalid-roster"
        ? "Le format du roster personnel n'a pas pu être reconnu."
        : explanations[own.status] || "Le test de lecture du roster personnel n'a pas abouti.";
    detail = "<h2>Test 1 — Ton propre roster</h2><p>" + esc(ownDetail) +
      (Number.isInteger(own.httpCode) ? " (HTTP " + own.httpCode + ")" : "") +
      "</p><h2>Test 2 — Roster partagé d’un coéquipier</h2>" + detail;
  }

  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Test alliance — LoSP</title>' +
    '<script nonce="' + cspNonce + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + cspNonce + '">*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#f0f5ff;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:5vh auto;padding:22px}h1{font-size:clamp(1.6rem,5vw,2.3rem);line-height:1.2}h2{font-size:1.15rem}section{padding:18px;background:#172236;border:1px solid #33435e;border-radius:12px}p{color:#b8c5d9}strong{color:#fff}a{color:#83c5ff}</style>' +
    '</head><body><main><h1>Test d’accès aux rosters de l’alliance</h1><section>' +
    detail + '</section><p>Lecture ponctuelle sans stockage de tokens, d’identifiants ni de rosters. ' +
    'Un seul roster partagé a été interrogé au maximum. Le résultat disparaît au rechargement.</p>' +
    '<p><a href="/">Retour à l’accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
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
  headers.append("Set-Cookie", "__Host-losp_oauth_alliance_test=" + remove);
  headers.append("Set-Cookie", "__Host-losp_oauth_roster_scope_test=" + remove);
  return new Response(html, { status: 200, headers });
}
