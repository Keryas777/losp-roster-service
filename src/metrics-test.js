// Opt-in consistency check using one captain's OAuth session, up to 3 GETs.
// Display only own player statistics and aggregate consistency, never other member values.
import { API_KEY } from "./player-card.js";

const ORIGIN = "https://api.marvelstrikeforce.com";
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const countable = value => value === 0 || integer(value);

async function call(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ORIGIN + path, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY, "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + token, Accept: "application/json"
      },
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(9000)
    });
  } catch {
    return { status: "network-error" };
  }
  if (response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)) return { status: "redirect" };
  if (!response.ok) return { status: "http-error", http: response.status };
  try {
    const value = await response.json();
    return isObject(value) ? { status: "ok", data: value.data } : { status: "invalid-json" };
  } catch { return { status: "invalid-json" }; }
}

function sameNumber(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return "absent";
  if (!integer(a) || !integer(b)) return "type-invalide";
  return a === b ? "identique" : "différent";
}

export function compareMetricCards(alliance, members, own) {
  if (!isObject(alliance) || !Array.isArray(members) ||
      members.length === 0 || members.length > 30 ||
      !members.every(row => isObject(row) && isObject(row.card) &&
        typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256) ||
      members.filter(row => row.isSelf === true).length !== 1 ||
      new Set(members.map(row => row.id)).size !== members.length ||
      !isObject(own) || typeof own.name !== "string" || !own.name.trim()) {
    return { status: "invalid-data" };
  }

  const self = members.find(row => row.isSelf === true).card;
  const consistency = {
    memberCount: integer(alliance.count)
      ? (alliance.count === members.length ? "identique" : "différent") : "indisponible",
    totalTcp: "indisponible",
    averageTcp: "indisponible"
  };

  const allTcp = members.every(row => integer(row.card.tcp));
  if (integer(alliance.tcp) && allTcp) {
    const sum = members.reduce((total, row) => total + row.card.tcp, 0);
    consistency.totalTcp = Number.isSafeInteger(sum)
      ? (sum === alliance.tcp ? "identique" : "différent") : "type-invalide";
  }
  // The public API's avgTcp is integer-valued, so compare allowing integer
  // rounding/truncation only, not an invented arbitrary percentage threshold.
  if (integer(alliance.tcp) && integer(alliance.avgTcp) &&
      integer(alliance.count) && alliance.count > 0) {
    const expected = alliance.avgTcp * alliance.count;
    consistency.averageTcp = Number.isSafeInteger(expected)
      ? (Math.abs(expected - alliance.tcp) <= alliance.count
        ? "compatible-arrondi" : "différent") : "type-invalide";
  }

  const pairs = {
    tcp: sameNumber(self.tcp, own.tcp),
    stp: sameNumber(self.stp, own.stp),
    warMvp: sameNumber(self.warMvp, own.warMvp),
    charactersCollected: sameNumber(self.charactersCollected, own.charactersCollected),
    level: sameNumber(self.level?.completedTier, own.level?.completedTier)
  };

  // Own-only, explicit allowlist: intended for the captain to check against
  // the visible in-game profile, not to claim external ground truth.
  const ownValues = {
    level: own.level?.completedTier,
    tcp: own.tcp, stp: own.stp, warMvp: own.warMvp,
    charactersCollected: own.charactersCollected,
    bestArena: own.bestArena, latestArena: own.latestArena,
    latestBlitz: own.latestBlitz, blitzWins: own.blitzWins,
    daysInAlliance: self.daysInAlliance
  };
  for (const key of Object.keys(ownValues)) {
    if (!integer(ownValues[key])) ownValues[key] = null;
  }
  const strongestPower = integer(own.tcp) && integer(own.stp)
    ? (own.stp <= own.tcp ? "compatible" : "à-vérifier") : "indisponible";

  return { status: "ok", memberCount: members.length,
    consistency, comparisons: pairs, strongestPower, ownValues };
}

export async function probeMetricConsistency(token, fetchImpl = fetch) {
  if (typeof token !== "string" || !token) return { status: "missing-token" };
  // Read sequentially, stop on any failure including rate limits.
  const alliance = await call("/player/v1/alliance/card", token, fetchImpl);
  if (alliance.status !== "ok") {
    return { status: "alliance-failed", reason: alliance.status, http: alliance.http || null };
  }
  if (!isObject(alliance.data)) return { status: "invalid-alliance" };

  const members = await call("/player/v1/alliance/members", token, fetchImpl);
  if (members.status !== "ok") {
    return { status: "members-failed", reason: members.status, http: members.http || null };
  }
  if (!Array.isArray(members.data) || members.data.length < 1 ||
      members.data.length > 30 || !members.data.every(row => isObject(row) && isObject(row.card)) ||
      members.data.filter(row => row.isSelf === true).length !== 1) {
    return { status: "invalid-members" };
  }

  // Personal card belongs exclusively to the already consenting account.
  const player = await call("/player/v1/card", token, fetchImpl);
  if (player.status !== "ok") {
    return { status: "player-failed", reason: player.status, http: player.http || null };
  }
  return compareMetricCards(alliance.data, members.data, player.data);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function num(n) {
  return integer(n) ? new Intl.NumberFormat("fr-FR").format(n) : "Non renseigné";
}
function nonce() {
  const data = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function line(label, value) {
  return '<div class="line"><span>' + esc(label) +
    "</span><strong>" + esc(value) + "</strong></div>";
}

export function renderMetricConsistency(report) {
  const n = nonce();
  let rows;
  if (report.status === "ok") {
    rows = "<h2>Cohérence de l'alliance</h2>" +
      line("Membres sur la liste", num(report.memberCount)) +
      line("Effectif global / liste", report.consistency.memberCount) +
      line("Somme TCP des membres / TCP alliance", report.consistency.totalTcp) +
      line("TCP moyen / effectif / TCP alliance", report.consistency.averageTcp) +
      "<h2>Compte connecté : carte membre / carte personnelle</h2>";
    for (const field of ["tcp", "stp", "warMvp", "charactersCollected", "level"]) {
      rows += line(field, report.comparisons[field]);
    }
    rows += line("Meilleure équipe / TCP personnel", report.strongestPower) +
      "<h2>Valeurs personnelles à comparer avec MSF</h2>";
    for (const [key, title] of [
      ["level", "Niveau"], ["tcp", "TCP"], ["stp", "STP"],
      ["warMvp", "MVP de guerre (total)"],
      ["charactersCollected", "Personnages débloqués"],
      ["daysInAlliance", "Ancienneté alliance (jours)"],
      ["latestArena", "Dernier rang Arène"],
      ["bestArena", "Meilleur rang Arène historique"],
      ["latestBlitz", "Dernier rang Blitz"],
      ["blitzWins", "Victoires Blitz cumulées"]
    ]) rows += line(title, num(report.ownValues[key]));
  } else {
    rows = "<p>Diagnostic interrompu : " + esc(report.status) +
      (report.reason ? " (" + esc(report.reason) + ")" : "") +
      (Number.isInteger(report.http) ? " — HTTP " + report.http : "") + "</p>";
  }
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Cohérence statistiques — LoSP</title>' +
    '<script nonce="' + n +
    '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + n +
    '">*{box-sizing:border-box}body{background:#0b1220;color:#f0f5ff;margin:0;' +
    'font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:680px;' +
    'margin:3vh auto;padding:22px}h1{font-size:clamp(1.5rem,5vw,2.2rem)}' +
    'h2{font-size:1.15rem;margin-top:28px}.box{background:#172236;' +
    'border:1px solid #33435e;border-radius:12px;padding:18px}.line{display:flex;' +
    'gap:12px;justify-content:space-between;flex-wrap:wrap;padding:9px 0;' +
    'border-bottom:1px solid #33435e}span,p{color:#b8c5d9}strong{overflow-wrap:anywhere}' +
    'a{color:#83c5ff}</style></head><body><main><h1>Audit de cohérence des statistiques</h1>' +
    '<section class="box"><p>Statut : ' + esc(report.status) + '</p>' + rows + '</section>' +
    '<p>Les comparaisons indiquent une cohérence des données API, pas leur exactitude dans MSF.' +
    ' Les valeurs détaillées affichées appartiennent exclusivement au compte connecté.' +
    ' Aucun autre joueur, ID, token ou JSON brut n’est affiché ou enregistré.' +
    ' Trois appels API maximum, aucun stockage et rechargement volontairement expiré.</p>' +
    '<p><a href="/">Accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + n +
      "'; style-src 'nonce-" + n +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const clear = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of ["state", "verifier", "metrics_test"]) {
    headers.append("Set-Cookie", "__Host-losp_oauth_" + name + "=" + clear);
  }
  return new Response(html, { status: 200, headers });
}
