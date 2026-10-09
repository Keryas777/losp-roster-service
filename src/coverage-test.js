// One-shot, opt-in read-only coverage audit. No persistence, IDs or raw API data.
import { API_KEY } from "./player-card.js";

const ROOT = "https://api.marvelstrikeforce.com";
const progress = { completedTier: "uint", goalTier: "uint", progress: "uint" };
const ad = { id: "string", exp: "string" };
const league = { id: "uint", name: "string" };
const raid = { id: "string", groupId: "string", name: "string", difficulty: "uint", completion: "uint" };
const playerQualifications = {
  lang: "array", avgTcp: "uint", style: "string", warZone: "uint",
  warLeague: league, raids: "array"
};
const allianceQualifications = {
  tcp: "uint", lang: "array", custom: "array", raids: "array"
};
const application = { id: "string", message: "string", expiration: "string" };

// Everything below comes from documented 2026 OpenAPI schemas. WW is obsolete.
const schemas = {
  alliance: {
    id: "string", name: "string", icon: "string", frame: "string", level: progress,
    description: "string", type: "string", managementRank: "string",
    demoteDays: "uint", kickDays: "uint", warZone: "uint", warLeague: league,
    warTrophies: "uint", warRank: "uint", raidRank: "uint",
    style: "string", tcp: "uint", avgTcp: "uint", discordUrl: "string",
    ad, qualifications: allianceQualifications, count: "uint"
  },
  member: {
    id: "string", rank: "string", isSelf: "boolean",
    card: {
      name: "string", icon: "string", frame: "string", level: progress,
      tcp: "uint", stp: "uint", warMvp: "uint",
      charactersCollected: "uint", rosterShare: "boolean", daysInAlliance: "uint"
    }
  },
  player: {
    name: "string", icon: "string", frame: "string", level: progress,
    tcp: "uint", stp: "uint", warMvp: "uint",
    charactersCollected: "uint", charactersAtMaxStarRank: "uint",
    bestArena: "uint", latestArena: "uint", latestBlitz: "uint",
    blitzWins: "uint", rosterShare: "boolean", application, aid: "string",
    ad, qualifications: playerQualifications
  },
  recruit: {
    recruitId: "string", ad: {
      tcp: "uint", stp: "uint", level: "uint", lang: "string", timezone: "string"
    },
    card: {
      name: "string", icon: "string", frame: "string", level: progress,
      tcp: "uint", stp: "uint", warMvp: "uint",
      charactersCollected: "uint", charactersAtMaxStarRank: "uint",
      bestArena: "uint", latestArena: "uint", latestBlitz: "uint",
      blitzWins: "uint", rosterShare: "boolean"
    },
    expiration: "string"
  }
};

const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const valid = (value, shape) => {
  if (shape === "string") return typeof value === "string";
  if (shape === "boolean") return typeof value === "boolean";
  if (shape === "uint") return Number.isSafeInteger(value) && value >= 0;
  if (shape === "array") return Array.isArray(value);
  return object(value);
};
function inspect(data, schema, prefix = "", out = {}) {
  if (!object(data)) return out;
  for (const [key, type] of Object.entries(schema)) {
    const label = prefix + key, value = data[key];
    out[label] = value === undefined ? "absent" : value === null ? "null" :
      valid(value, type) ? "type-ok" : "type-invalid";
    if (object(type) && object(value)) inspect(value, type, label + ".", out);
  }
  return out;
}
function extraCount(data, schema) {
  if (!object(data)) return 0;
  return Object.keys(data).filter(k => !Object.hasOwn(schema, k)).length;
}
async function call(path, token, fetchImpl) {
  try {
    const res = await fetchImpl(ROOT + path, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY, "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + token, Accept: "application/json"
      },
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(9000)
    });
    const http = res.status;
    if (!res.ok || res.type === "opaqueredirect") {
      return { status: "http-" + http, http };
    }
    const payload = await res.json();
    if (!object(payload)) return { status: "invalid-envelope", http };
    return { status: "ok", http, payload };
  } catch {
    return { status: "network-or-json-error" };
  }
}
function describe(result, schema, array = false) {
  const summary = { status: result.status, http: result.http || null };
  if (result.status !== "ok") return summary;
  const data = result.payload.data;
  if (array ? !Array.isArray(data) : !object(data)) {
    return { status: "invalid-data", http: result.http };
  }
  summary.status = "ok";
  if (array) summary.count = data.length;
  const sample = array ? data[0] : data;
  if (sample !== undefined) {
    if (!object(sample)) return { status: "invalid-entry", http: result.http };
    summary.fields = inspect(sample, schema);
    summary.extraKeys = extraCount(sample, schema);
  }
  return summary;
}
const stop = result => result.http === 401 || result.http === 429;

export async function probeCoverage(token, fetchImpl = fetch) {
  if (typeof token !== "string" || !token) return { status: "missing-token", probes: {} };
  const probes = {};
  const card = await call("/player/v1/alliance/card", token, fetchImpl);
  probes.alliance = describe(card, schemas.alliance);
  if (stop(card)) return { status: "stopped", probes };

  const members = await call("/player/v1/alliance/members", token, fetchImpl);
  probes.members = describe(members, schemas.member, true);
  if (stop(members)) return { status: "stopped", probes };

  if (probes.members.status === "ok") {
    const rows = members.payload.data;
    // One consenting alliance only; never accept a caller-supplied memberId.
    if (rows.length <= 30 && rows.every(object)) {
      const other = rows.find(row => row.isSelf !== true &&
        typeof row.id === "string" && row.id.length >= 1 && row.id.length <= 256);
      if (other) {
        const memberCard = await call(
          "/player/v1/card/member/" + encodeURIComponent(other.id), token, fetchImpl
        );
        probes.player = describe(memberCard, schemas.player);
        if (stop(memberCard)) return { status: "stopped", probes };
      } else probes.player = { status: "no-other-member" };
    } else probes.player = { status: "unsafe-member-list" };
  } else probes.player = { status: "skipped-no-members" };

  const applications = await call("/player/v1/alliance/recruiting/applications", token, fetchImpl);
  probes.applications = describe(applications, schemas.player, true);
  if (stop(applications)) return { status: "stopped", probes };

  // Only one advertised recruit; never list names, IDs or application messages.
  const recruits = await call("/player/v1/recruiting/recruits?page=1&perPage=1", token, fetchImpl);
  probes.recruits = describe(recruits, schemas.recruit, true);
  return { status: "complete", probes };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-")
    .replace(/\//g, "_").replace(/=+$/g, "");
}
export function renderCoverage(report) {
  const n = nonce();
  const sections = Object.entries(report.probes || {}).map(([name, p]) => {
    const fields = Object.entries(p.fields || {}).map(([field, state]) =>
      "<div class=row><span>" + escapeHtml(field) + "</span><strong>" +
      escapeHtml(state) + "</strong></div>").join("");
    return "<section><h2>" + escapeHtml(name) + "</h2><p>Statut : " +
      escapeHtml(p.status) + (p.http ? " (HTTP " + p.http + ")" : "") +
      (Number.isInteger(p.count) ? " — entrées : " + p.count : "") +
      (Number.isInteger(p.extraKeys) ? " — propriétés supplémentaires non affichées : " + p.extraKeys : "") +
      "</p>" + fields + "</section>";
  }).join("");
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Audit OpenAPI LoSP</title>' +
    '<script nonce="' + n + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + n + '">*{box-sizing:border-box}body{background:#0b1220;color:#f0f5ff;' +
    'font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0}main{max-width:720px;margin:auto;' +
    'padding:22px}h1{font-size:1.55rem}section{padding:10px 16px;margin:14px 0;background:#172236;' +
    'border:1px solid #33435e;border-radius:12px}h2{font-size:1.1rem}.row{display:flex;' +
    'justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #33435e;' +
    'overflow-wrap:anywhere}span{color:#b8c5d9}strong{font-size:.9rem}a{color:#83c5ff}' +
    '</style></head><body><main><h1>Audit ponctuel des schémas API</h1><p>' +
    'État : ' + escapeHtml(report.status) + '. type-ok confirme uniquement le type JSON,' +
    ' pas la validité métier. absent et null sont distingués.</p>' + sections +
    '<p>Un seul compte autorisé. Au plus cinq appels en lecture seule. Aucun nom,' +
    ' identifiant, message de candidature, réponse brute ou token conservé ou affiché.</p>' +
    '<p><a href="/">Accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + n +
      "'; style-src 'nonce-" + n + "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const clear = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const key of ["state", "verifier", "coverage_test"]) {
    headers.append("Set-Cookie", "__Host-losp_oauth_" + key + "=" + clear);
  }
  return new Response(html, { status: 200, headers });
}
