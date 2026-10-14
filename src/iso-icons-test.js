// Opt-in read-only ISO-8 icon audit, one documented game-data GET.
// No OAuth tokens, account details, or unrestricted upstream URLs reach the page.
import { API_KEY } from "./player-card.js";

const API_URL = "https://api.marvelstrikeforce.com/game/v1/iso8Abilities";
const CLASS_IDS = Object.freeze([
  "striker", "raider", "skirmisher", "healer", "fortifier"
]);
const ICON_LIMIT = 16;
const isObject = x => x !== null && typeof x === "object" && !Array.isArray(x);

// Only public official image assets can be embedded as a browser request.
// An unexpected external URL may contain sensitive query parameters.
export function publicIconUrl(value) {
  if (typeof value !== "string" || value.length > 400) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        url.hostname !== "assets.marvelstrikeforce.com" ||
        url.port !== "" || url.username || url.password ||
        url.search || url.hash ||
        !/^\/imgs\/[A-Za-z0-9_.-]+\.(?:png|webp)$/i.test(url.pathname) ||
        url.pathname.includes("..")) return null;
    return url.href;
  } catch { return null; }
}

export function summarizeIsoIcons(data) {
  if (!isObject(data)) return { status: "invalid-data" };
  const classes = [];
  for (const id of CLASS_IDS) {
    const ability = data[id];
    if (!isObject(ability)) {
      classes.push({ id, status: "absent", slots: [] });
      continue;
    }
    if (!Array.isArray(ability.icons)) {
      classes.push({ id, status: "missing-icons", slots: [] });
      continue;
    }
    if (ability.icons.length > ICON_LIMIT) {
      classes.push({ id, status: "too-many-icons", slots: [] });
      continue;
    }
    const slots = [];
    for (let i = 0; i < ability.icons.length; i++) {
      const url = publicIconUrl(ability.icons[i]);
      const raw = ability.icons[i];
      const state = url ? "official-url" :
        (raw === null || raw === undefined || raw === "" ? "empty" : "unrecognized-url");
      slots.push({ index: i, state, url });
    }
    classes.push({ id, status: "ok", count: ability.icons.length, slots });
  }
  return { status: "ok", classes };
}

export async function probeIsoIcons(token, fetchImpl = fetch) {
  if (typeof token !== "string" || !token) return { status: "missing-token" };
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        "User-Agent": "APIClient/1.0 (Server)",
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
  } catch { return { status: "network-error" }; }

  if (response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)) {
    return { status: "redirect" };
  }
  if (!response.ok) return { status: "http-error", http: response.status };
  try {
    const payload = await response.json();
    return summarizeIsoIcons(payload?.data);
  } catch { return { status: "invalid-json" }; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}
function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function renderIsoIcons(result) {
  const n = nonce();
  const labels = {
    striker: "Striker", raider: "Raider", skirmisher: "Skirmisher",
    healer: "Healer", fortifier: "Fortifier"
  };
  let body = "";
  if (result.status !== "ok") {
    body = '<p>Diagnostic interrompu : ' + escapeHtml(result.status) +
      (Number.isInteger(result.http) ? " — HTTP " + result.http : "") + "</p>";
  } else {
    for (const entry of result.classes) {
      body += '<section class="box"><h2>' + escapeHtml(labels[entry.id]) + "</h2>";
      body += '<p>Réponse : ' + escapeHtml(entry.status) +
        (Number.isInteger(entry.count) ? " · " + entry.count + " emplacement(s)" : "") + "</p>";
      const candidate = entry.slots.find(x => x.index === 4);
      body += '<p>Indice 4 (tier 4 potentiel) : ' +
        (candidate ? escapeHtml(candidate.state) : "absent") + "</p>";
      if (entry.slots.length) {
        body += '<div class="icons">';
        for (const slot of entry.slots) {
          const label = slot.index === 0 ? "Classe" : "Tier " + slot.index;
          body += '<div class="icon-card"><strong>' + escapeHtml(label) + '</strong>';
          if (slot.url) {
            const safe = escapeHtml(slot.url);
            body += '<a href="' + safe + '" target="_blank" rel="noopener noreferrer" ' +
              'referrerpolicy="no-referrer"><img src="' + safe +
              '" alt="Icône officielle ' + escapeHtml(labels[entry.id]) + " " +
              escapeHtml(label) + '" loading="lazy" decoding="async" ' +
              'referrerpolicy="no-referrer"></a>';
            // Show the exact asset URL only on an explicit expand action.
            body += '<details><summary>URL officielle</summary><p class="url">' + safe + '</p></details>';
          } else {
            body += '<span class="missing">' + escapeHtml(slot.state) + "</span>";
          }
          body += "</div>";
        }
        body += "</div>";
      }
      body += "</section>";
    }
  }

  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Icônes ISO-8 — LoSP</title>' +
    '<script nonce="' + n +
    '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + n +
    '">*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#f0f5ff;' +
    'font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:760px;' +
    'margin:3vh auto;padding:18px}h1{font-size:clamp(1.45rem,5vw,2rem)}' +
    'h2{font-size:1.14rem}.box{padding:16px;margin:16px 0;background:#172236;' +
    'border:1px solid #33435e;border-radius:12px}p{color:#c5d1e3}' +
    '.icons{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px}' +
    '.icon-card{display:flex;flex-direction:column;align-items:center;gap:8px;' +
    'padding:10px 6px;border:1px solid #33435e;border-radius:10px;min-width:0}' +
    'img{width:70px;height:70px;object-fit:contain}summary{color:#8cccff;cursor:pointer;' +
    'font-size:.78rem}details{width:100%}.url{overflow-wrap:anywhere;' +
    'font-size:.7rem;line-height:1.35}.missing{color:#f4c8a4;font-size:.8rem}' +
    'a{color:#8cccff}</style></head><body><main>' +
    '<h1>Diagnostic des icônes ISO-8</h1>' +
    '<p>Un seul appel à /game/v1/iso8Abilities. Indice 0 = classe, indice 1 = tier 1,' +
    ' etc. La présence d’une image au tier 4 ne prouve pas à elle seule' +
    ' qu’elle correspond au visuel orange : une comparaison visuelle reste nécessaire.</p>' +
    body + '<p>Seules les URL publiques d’images du domaine officiel sont affichées.' +
    ' Aucun token, compte, personnage ni réponse JSON brute n’est transmis au navigateur' +
    ' ou conservé par LoSP. Les aperçus chargent des images publiques chez Scopely.</p>' +
    '<p><a href="/">Retour à l’accueil</a></p></main></body></html>';

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + n +
      "'; style-src 'nonce-" + n +
      "'; img-src https://assets.marvelstrikeforce.com; base-uri 'none';" +
      " form-action 'none'; frame-ancestors 'none'"
  });
  const clear = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of ["state", "verifier", "iso_icons_test"]) {
    headers.append("Set-Cookie", "__Host-losp_oauth_" + name + "=" + clear);
  }
  return new Response(html, { status: 200, headers });
}
