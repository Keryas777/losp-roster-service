// Explicit diagnostic: one alliance card, one member list, up to 24 member cards.
// Never persist or expose member IDs, token, raw cards, or personal stats.
import { API_KEY } from "./player-card.js";

const ROOT = "https://api.marvelstrikeforce.com";
const PROFILE_FIELDS = [
  "name", "icon", "frame", "level", "tcp", "stp", "warMvp",
  "charactersCollected", "charactersAtMaxStarRank",
  "bestArena", "latestArena", "latestBlitz", "blitzWins", "rosterShare"
];
// Exclude obsolete World Warrior and optional recruiting/application data.

async function api(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ROOT + path, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY, "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + token, Accept: "application/json"
      },
      cache: "no-store", redirect: "manual",
      signal: AbortSignal.timeout(9000)
    });
  } catch { return { status: "network-error" }; }
  if (response.status >= 300 && response.status < 400 ||
      response.type === "opaqueredirect") return { status: "redirect" };
  if (response.status === 401) return { status: "401" };
  if (response.status === 403) return { status: "403" };
  if (response.status === 404) return { status: "404" };
  if (response.status === 429) return { status: "429" };
  if (response.status === 464) return { status: "464" };
  if (!response.ok) return { status: "http-error" };
  try { return { status: "ok", data: await response.json() }; }
  catch { return { status: "invalid-json" }; }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function present(value) { return value !== undefined && value !== null; }
function countFields(card, counts) {
  for (const field of PROFILE_FIELDS) {
    if (present(card[field])) counts[field] = (counts[field] || 0) + 1;
  }
}
function cleanCard(data) {
  const card = data?.data;
  return object(card) && typeof card.name === "string" && card.name.trim()
    ? card : null;
}

function allianceSummary(card) {
  if (!object(card) || typeof card.name !== "string" || !card.name.trim()) return null;
  // Fixed, allowlisted fields only. Never return arbitrary free-text descriptions or URLs.
  const numeric = field => Number.isSafeInteger(card[field]) && card[field] >= 0
    ? card[field] : null;
  return {
    name: card.name.slice(0, 90),
    count: numeric("count"), tcp: numeric("tcp"), avgTcp: numeric("avgTcp"),
    warRank: numeric("warRank"), raidRank: numeric("raidRank"),
    warTrophies: numeric("warTrophies"),
    league: typeof card.warLeague?.name === "string"
      ? card.warLeague.name.slice(0, 65) : null
  };
}

export async function probeAllianceProfiles(token, fetchImpl = fetch) {
  if (typeof token !== "string" || !token) return { status: "missing-token" };
  const cardResult = await api("/player/v1/alliance/card", token, fetchImpl);
  const card = cardResult.status === "ok" ? allianceSummary(cardResult.data?.data) : null;
  const alliance = card ? { status: "accessible", ...card } :
    { status: cardResult.status === "ok" ? "invalid-data" : cardResult.status };

  const membersResult = await api("/player/v1/alliance/members", token, fetchImpl);
  if (membersResult.status !== "ok") return {
    status: "members-failed", alliance, membersStatus: membersResult.status
  };
  const rows = membersResult.data?.data;
  if (!Array.isArray(rows) || rows.length > 30 ||
      !rows.every(row => object(row) && object(row.card))) {
    return { status: "invalid-members", alliance };
  }

  // Member handles are temporary. Only use IDs from the fresh authenticated list.
  const seen = new Set();
  const eligible = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 256 ||
        seen.has(row.id)) continue;
    seen.add(row.id);
    eligible.push({ id: row.id, isSelf: row.isSelf === true });
  }
  if (!eligible.length) return {
    status: "no-identifiers", alliance, memberCount: rows.length
  };
  const ordered = [...eligible.filter(row => !row.isSelf),
    ...eligible.filter(row => row.isSelf)].slice(0, 24);
  const fieldCounts = {};
  let checked = 0, available = 0;
  const errors = {};
  const record = result => {
    checked++;
    const card = result.status === "ok" ? cleanCard(result.data) : null;
    if (card) { available++; countFields(card, fieldCounts); return "ok"; }
    const reason = result.status === "ok" ? "invalid-data" : result.status;
    errors[reason] = (errors[reason] || 0) + 1;
    return reason;
  };

  // Test one OTHER member before potentially making 23 additional calls.
  const first = record(await api(
    "/player/v1/card/member/" + encodeURIComponent(ordered[0].id), token, fetchImpl
  ));
  if (first !== "ok") return {
    status: "first-member-refused", alliance, memberCount: rows.length,
    checked, available, firstStatus: first, errors, fieldCounts
  };

  // Concurrency capped to 3 to limit load on Scopely.
  for (let start = 1; start < ordered.length; start += 3) {
    const batch = ordered.slice(start, start + 3);
    const outcomes = await Promise.all(batch.map(row =>
      api("/player/v1/card/member/" + encodeURIComponent(row.id), token, fetchImpl)));
    const statuses = outcomes.map(record);
    if (statuses.some(status => status === "429" || status === "401")) break;
  }
  return {
    status: checked === eligible.length ? "complete" : "partial",
    alliance, memberCount: rows.length, eligibleCount: eligible.length,
    checked, available, errors, fieldCounts
  };
}

const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) { return String(v).replace(/[&<>"']/g, x => escapes[x]); }
function num(n) { return Number.isSafeInteger(n) && n >= 0 ?
  new Intl.NumberFormat("fr-FR").format(n) : "Non renseigné"; }
function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/g, "");
}
const reasonText = {
  "401":"Authentification refusée (401)",
  "403":"Accès interdit (403)", "404":"Fiche introuvable (404)",
  "429":"Limite d'appels atteinte (429)", "464":"Accès refusé (464)",
  "http-error":"Erreur HTTP", "network-error":"Erreur réseau",
  "redirect":"Redirection inattendue", "invalid-json":"Réponse JSON invalide",
  "invalid-data":"Format inattendu"
};
function explain(status) { return reasonText[status] || "Test impossible"; }
function tr(label, value) {
  return "<div class=line><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
}
export function renderAllianceProfiles(report) {
  const cspNonce = nonce();
  const alliance = report.alliance || {status:"not-tested"};
  let detail = "<h2>Fiche de l'alliance</h2>";
  if (alliance.status === "accessible") {
    detail += tr("Alliance", alliance.name) +
      tr("Membres déclarés",num(alliance.count)) +
      tr("Ligue de guerre",alliance.league || "Non renseignée") +
      tr("Classement saison de guerre (warRank)",num(alliance.warRank)) +
      tr("Classement saison de raid (raidRank)",num(alliance.raidRank)) +
      tr("Trophées de guerre",num(alliance.warTrophies)) +
      tr("TCP total",num(alliance.tcp)) +
      tr("TCP moyen",num(alliance.avgTcp));
  } else detail += "<p>" + esc(explain(alliance.status)) + "</p>";
  detail += "<h2>Fiches individuelles</h2>";
  if (Number.isInteger(report.memberCount)) {
    detail += tr("Membres recensés",num(report.memberCount));
  }
  if (Number.isInteger(report.checked)) {
    detail += tr("Fiches testées",num(report.checked)) +
      tr("Fiches accessibles",num(report.available));
  }
  if (report.status === "first-member-refused") {
    detail += "<p>Arrêt préventif après le premier membre : " +
      esc(explain(report.firstStatus)) + ". Les autres profils n'ont pas été interrogés.</p>";
  } else if (report.status === "complete") {
    detail += "<p>Toutes les fiches avec identifiant valide ont été testées (maximum 24).</p>";
  } else if (report.status !== "complete") {
    detail += "<p>Test partiel : " + esc(explain(report.membersStatus || report.status)) + ".</p>";
  }
  if (object(report.errors) && Object.keys(report.errors).length) {
    const entries = Object.entries(report.errors).filter(([key,val]) =>
      Object.hasOwn(reasonText,key) && Number.isInteger(val) && val > 0);
    detail += "<h3>Refus / erreurs</h3>" +
      entries.map(([key, val]) => tr(explain(key),num(val))).join("");
  }
  if (Number.isInteger(report.available) && report.available > 0 && object(report.fieldCounts)) {
    detail += "<h3>Champs présents dans les fiches accessibles</h3>";
    for (const field of PROFILE_FIELDS) {
      detail += tr(field, num(report.fieldCounts[field] || 0) + " / " + num(report.available));
    }
  }
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Audit profils alliance — LoSP</title>' +
    '<script nonce="' + cspNonce +
    '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + cspNonce +
    '">*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#f0f5ff;' +
    'font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:640px;margin:5vh auto;' +
    'padding:22px}h1{font-size:clamp(1.7rem,5vw,2.3rem);line-height:1.2}h2{font-size:1.2rem;' +
    'margin-top:30px}h3{font-size:1rem}.box{background:#172236;border:1px solid #33435e;' +
    'border-radius:12px;padding:18px}.line{display:flex;gap:12px;justify-content:space-between;' +
    'padding:9px 0;border-bottom:1px solid #33435e;flex-wrap:wrap}span,p{color:#b8c5d9}' +
    'strong{overflow-wrap:anywhere}a{color:#83c5ff}</style></head><body><main>' +
    '<h1>Diagnostic des profils de l’alliance</h1><section class=box>' + detail +
    '</section><p>Consultation ponctuelle depuis un seul compte autorisé. Aucun token,' +
    ' identifiant de membre ou profil complet n’est enregistré ni transmis au navigateur.' +
    ' Le résultat disparaît au rechargement.</p><p><a href="/">Retour à l’accueil</a></p>' +
    '</main></body></html>';
  const headers = new Headers({
    "Content-Type":"text/html; charset=utf-8",
    "Cache-Control":"no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex, nofollow, noarchive",
    "X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY",
    "Content-Security-Policy":"default-src 'none'; script-src 'nonce-" + cspNonce +
      "'; style-src 'nonce-" + cspNonce +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const clear = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of ["state","verifier","profiles_test"]) {
    headers.append("Set-Cookie","__Host-losp_oauth_" + name + "=" + clear);
  }
  return new Response(html,{status:200,headers});
}
