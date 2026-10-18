import { API_KEY } from "./player-card.js";

// Opt-in, one-shot collection engine. No storage, export or public JSON.
const ROOT = "https://api.marvelstrikeforce.com";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES_PER_MEMBER = 10;
const MAX_CHARACTERS_PER_MEMBER = 800;
const MAX_REQUESTS = 35; // Under the Workers free-tier subrequest budget.
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_ALLIANCE_MEMBERS = 100;
const MAX_PILOT_MEMBERS = 3;

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const validId = v => typeof v === "string" && v.length > 0 && v.length <= 256;
const nonNegativeInt = v => Number.isSafeInteger(v) && v >= 0;

function statusFor(code) {
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 429) return "rate-limited";
  if (code === 464) return "no-access";
  if (code === 472) return "response-too-large";
  if ([500, 502, 503, 504, 552, 553].includes(code)) return "service-unavailable";
  return "provider-error";
}

function headerFor(token) {
  return {
    Authorization: "Bearer " + token,
    "x-api-key": API_KEY,
    "User-Agent": "APIClient/1.0 (Server)",
    Accept: "application/json"
  };
}

async function request(path, token, budget, fetchImpl) {
  if (budget.used >= MAX_REQUESTS) return { status: "request-budget" };
  budget.used++;
  let response;
  try {
    response = await fetchImpl(ROOT + path, {
      method: "GET",
      headers: headerFor(token),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { status: "network-error" };
  }
  if (!response.ok) return { status: statusFor(response.status) };
  if ((Number(response.headers.get("content-length")) || 0) > MAX_RESPONSE_BYTES) {
    return { status: "response-too-large" };
  }
  let payload;
  try {
    // JSON must be parsed in memory, never forwarded to browser/logs.
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) return { status: "response-too-large" };
    payload = JSON.parse(body);
  } catch {
    return { status: "invalid-json" };
  }
  return object(payload) ? { status: "ok", payload } : { status: "invalid-data" };
}

async function collectMember(memberId, token, budget, fetchImpl, withInfo = false) {
  let perPage = DEFAULT_PAGE_SIZE;
  let records = [];
  let seenIds = new Set();
  let expectedTotal = null;
  let observedAsOf = null;
  let pages = 0;
  let downsizes = 0;

  for (let page = 1; page <= MAX_PAGES_PER_MEMBER; page++) {
    const path = "/player/v1/roster/member/" + encodeURIComponent(memberId) +
      "?page=" + page + "&perPage=" + perPage + "&statsFormat=csv" +
      (withInfo ? "&lang=fr&charInfo=full" : "");
    const response = await request(path, token, budget, fetchImpl);
    if (response.status === "response-too-large" && downsizes < 3 && perPage > 10) {
      perPage = Math.max(10, Math.floor(perPage / 2));
      records = [];
      seenIds = new Set();
      expectedTotal = null;
      observedAsOf = null;
      pages = 0;
      downsizes++;
      page = 0; // restart from first page after changing the page size
      continue;
    }
    if (response.status !== "ok") return { status: response.status };
    const data = response.payload.data;
    const meta = response.payload.meta;
    if (!Array.isArray(data) || !object(meta)) return { status: "invalid-data" };
    if (!data.every(item => object(item) && validId(item.id))) {
      return { status: "invalid-character" };
    }
    if (meta.page !== undefined && meta.page !== page) return { status: "invalid-pagination" };
    if (meta.perPage !== undefined && meta.perPage !== perPage) {
      return { status: "invalid-pagination" };
    }
    if (meta.perTotal !== undefined && !nonNegativeInt(meta.perTotal)) {
      return { status: "invalid-pagination" };
    }
    if (expectedTotal !== null && meta.perTotal !== undefined && meta.perTotal !== expectedTotal) {
      return { status: "changed-during-read" };
    }
    if (expectedTotal === null && meta.perTotal !== undefined) expectedTotal = meta.perTotal;
    if (typeof meta.asOf === "string") {
      if (observedAsOf !== null && observedAsOf !== meta.asOf) {
        return { status: "changed-during-read" };
      }
      observedAsOf = meta.asOf;
    }
    if (data.length > perPage) return { status: "invalid-pagination" };
    for (const item of data) {
      if (seenIds.has(item.id)) return { status: "duplicate-character" };
      seenIds.add(item.id);
      records.push(item);
    }
    pages++;
    if (records.length > MAX_CHARACTERS_PER_MEMBER ||
        (expectedTotal !== null && records.length > expectedTotal)) {
      return { status: "invalid-pagination" };
    }
    if (expectedTotal !== null && records.length === expectedTotal) {
      return { status: "ok", roster: records, pages };
    }
    // Without reliable perTotal, the first short/empty page closes pagination.
    if (expectedTotal === null && data.length < perPage) {
      return { status: "ok", roster: records, pages };
    }
    if (data.length === 0) return { status: "invalid-pagination" };
  }
  return { status: "page-budget" };
}

/**
 * Full page-by-page reads for a bounded subset of explicitly shared alliance rosters.
 * Not a background sync. Raw rosters remain internal and must not enter public output.
 * The internal collection supports future private storage only after separate approval.
 */
export async function collectAllianceRosterSample(token, fetchImpl = fetch, options = {}) {
  if (typeof token !== "string" || !token) return { status: "missing-token" };
  const maxMembers = options.maxMembers === undefined ? MAX_PILOT_MEMBERS : options.maxMembers;
  const withInfo = options.charInfo === true;
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > MAX_ALLIANCE_MEMBERS) {
    return { status: "invalid-configuration" };
  }
  const budget = { used: 0 };
  const response = await request("/player/v1/alliance/members", token, budget, fetchImpl);
  if (response.status !== "ok") return { status: response.status, requests: budget.used };
  const members = response.payload.data;
  if (!Array.isArray(members) || members.length > MAX_ALLIANCE_MEMBERS ||
      !members.every(object)) return { status: "invalid-members", requests: budget.used };

  const seenMembers = new Set();
  const candidates = [];
  for (const member of members) {
    if (!validId(member.id) || seenMembers.has(member.id)) {
      return { status: "invalid-members", requests: budget.used };
    }
    seenMembers.add(member.id);
    if (member.isSelf !== true && member.card?.rosterShare === true) candidates.push(member);
  }
  // Persistent captain sessions are account-bound, not alliance-bound.
  // Fail closed if Scopely cannot unambiguously identify the authorized
  // player in the CURRENT members list. Legacy one-shot probes are unchanged.
  if(options.requireCurrentMembership === true &&
     members.filter(member=>member.isSelf===true).length !== 1){
    return {status:"current-membership-unverified",requests:budget.used};
  }
  const selected = candidates.slice(0, maxMembers);
  const rosters = [];
  const summary = {
    memberCount: members.length,
    sharedCount: candidates.length,
    selectedCount: selected.length,
    completedCount: 0,
    characterCount: 0,
    pages: 0
  };
  for (const candidate of selected) {
    const result = await collectMember(candidate.id, token, budget, fetchImpl, withInfo);
    if (result.status !== "ok") {
      // Fail closed: discard all partial rosters and never return their contents.
      return { status: result.status, ...summary, requests: budget.used };
    }
    // Kept exclusively in this invocation's memory for future privately approved storage.
    rosters.push({ memberId: candidate.id, name: candidate.card.name, chars: result.roster });
    summary.completedCount++;
    summary.characterCount += result.roster.length;
    summary.pages += result.pages;
  }
  if(options.requireStableMembership===true){
    // A memberId is volatile when the alliance roster version changes.
    // Re-read membership *after* every collected page and reject changes
    // of roster sharing or membership: no partial records may escape.
    const check=await request("/player/v1/alliance/members",token,budget,fetchImpl);
    if(check.status!=="ok")return {status:check.status,requests:budget.used};
    const current=check.payload.data;
    if(!Array.isArray(current)||current.length!==members.length||
       current.filter(m=>m?.isSelf===true).length!==1)
      return {status:"changed-during-read",requests:budget.used};
    const freshById=new Map();
    for(const m of current){
      if(!object(m)||!validId(m.id)||freshById.has(m.id))
        return {status:"changed-during-read",requests:budget.used};
      freshById.set(m.id,m);
    }
    if(members.some(m=>!freshById.has(m.id))||
       selected.some(m=>freshById.get(m.id)?.card?.rosterShare!==true))
      return {status:"changed-during-read",requests:budget.used};
  }
  return { status: "complete", ...summary, requests: budget.used, rosters };
}

function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

export function renderRosterCollectionSample(report) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const ok = report.status === "complete";
  const details = ok
    ? "<h2>Collecte paginée terminée</h2><p>Rosters lus entièrement : <strong>" +
      report.completedCount + "</strong> / " + report.selectedCount +
      ". Personnages reçus : <strong>" + report.characterCount +
      "</strong>. Pages : " + report.pages + ".</p>"
    : "<h2>Collecte interrompue</h2><p>Motif technique : <strong>" +
      escapeHtml(report.status) + "</strong>. Les éventuelles données partielles sont abandonnées.</p>";
  const extra = Number.isSafeInteger(report.memberCount)
    ? "<p>Membres de l’alliance : " + report.memberCount +
      " ; partage activé : " + report.sharedCount +
      " ; maximum prévu pour ce pilote : " + MAX_PILOT_MEMBERS + ".</p>" : "";
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Collecte roster — LoSP</title>' +
    '<script nonce="' + nonce + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style>body{background:#0b1220;color:#f0f5ff;margin:0;font:16px/1.6 system-ui,sans-serif}' +
    'main{max-width:640px;margin:5vh auto;padding:24px}section{border:1px solid #33435e;' +
    'background:#172236;padding:20px;border-radius:14px}p{color:#b8c5d9}' +
    'a{color:#83c5ff}</style></head><body><main><h1>Collecte des rosters partagés</h1>' +
    '<section>' + details + extra +
    '<p>Ce pilote lit au plus trois rosters partagés, sans sauvegarder ni exposer les personnages.' +
    ' Aucune donnée n’est envoyée à la Web-app ou à GitHub.</p>' +
    '<p>Requêtes officielles effectuées : ' + (report.requests || 0) +
    '.</p></section><p><a href="/">Retour à l’accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const remove = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of [
    "__Host-losp_oauth_state", "__Host-losp_oauth_verifier",
    "__Host-losp_oauth_collection_test"
  ]) headers.append("Set-Cookie", name + "=" + remove);
  return new Response(html, { status: 200, headers });
}
