// Experimental OAuth scope discovery only. The four alliance read scope names
// appear as OpenAPI TAGS but are NOT confirmed in the documented OAuth scope list.
// Never request these scopes from the normal captain login until verified.
const BASE_SCOPE = "openid m3p.f.pr.pro m3p.f.ar.pro";
const EXTRA = Object.freeze([
  { id: "inv", scope: "m3p.f.ar.inv", label: "Inventaire de l’alliance" },
  { id: "raid", scope: "m3p.f.ar.raid", label: "Raids de l’alliance" },
  { id: "war", scope: "m3p.f.ar.war", label: "Guerre de l’alliance" },
  { id: "act", scope: "m3p.f.ar.act", label: "Activité de l’alliance" }
]);

const COOKIE_PREFIX = "__Host-losp_oauth_scope_probe_";
export const ALLIANCE_SCOPE_PROBES = Object.freeze([
  Object.freeze({
    id: "all",
    label: "Les quatre permissions",
    path: "/login/scope-probe/all",
    cookie: COOKIE_PREFIX + "all",
    scopes: Object.freeze(EXTRA.map(row => row.scope))
  }),
  ...EXTRA.map(row => Object.freeze({
    id: row.id, label: row.label,
    path: "/login/scope-probe/" + row.id,
    cookie: COOKIE_PREFIX + row.id,
    scopes: Object.freeze([row.scope])
  }))
]);

export function getAllianceScopeProbe(path) {
  return ALLIANCE_SCOPE_PROBES.find(probe => probe.path === path) || null;
}

export function allianceScopeRequest(probe) {
  return BASE_SCOPE + " " + probe.scopes.join(" ");
}

// Only scope IDs from a valid OAuth token response are inspected.
// Even if OAuth returns a scope string, this does NOT demonstrate any readable API endpoint.
export function auditAllianceScopeProbe(probe, granted) {
  if (typeof granted !== "string") {
    return { status: "unreported", checks: probe.scopes.map(scope => ({ scope, granted: false })) };
  }
  const set = new Set(granted.trim().split(/\s+/).filter(Boolean));
  const checks = probe.scopes.map(scope => ({ scope, granted: set.has(scope) }));
  return {
    status: checks.every(row => row.granted) ? "all-granted" :
      checks.some(row => row.granted) ? "some-granted" : "none-granted",
    checks
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, chr =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[chr]);
}

const MESSAGES = Object.freeze({
  "all-granted": "Scopely a confirmé toutes les permissions demandées dans le token.",
  "some-granted": "Certaines permissions ont été accordées, mais pas toutes.",
  "none-granted": "Aucune des permissions expérimentales ne figure dans le token.",
  "unreported": "Scopely n’a pas fourni le champ scope. Impossible de déterminer les permissions accordées.",
  "invalid-scope": "Scopely a refusé la demande : invalid_scope. Cela ne permet pas de savoir laquelle des quatre permissions bloque la demande groupée.",
  "access-denied": "La demande d’autorisation a été refusée ou annulée.",
  "oauth-error": "L’autorisation ou l’échange OAuth n’a pas abouti. Les permissions ne peuvent pas être vérifiées."
});

export function renderAllianceScopeProbe(probe, report) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const message = MESSAGES[report.status] || MESSAGES["oauth-error"];
  const checks = Array.isArray(report.checks) && ["all-granted", "some-granted", "none-granted"].includes(report.status)
    ? '<ul class="results">' + report.checks.map(item =>
      '<li><span>' + escapeHtml(item.scope) + '</span><strong>' +
      (item.granted ? "Accordée" : "Non accordée") + '</strong></li>').join("") + '</ul>'
    : "";
  const links = ALLIANCE_SCOPE_PROBES.map(item =>
    '<a href="' + item.path + '">' + escapeHtml(item.label) + '</a>').join("");
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Permissions d’alliance — LoSP</title>' +
    '<script nonce="' + nonce + '">try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}</script>' +
    '<style nonce="' + nonce + '">' +
    ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0c1424;color:#f0f5ff;font:16px/1.55 system-ui,-apple-system,sans-serif}' +
    'main{max-width:650px;margin:0 auto;padding:30px 18px 70px}h1{font-size:clamp(26px,7vw,38px);line-height:1.15}h2{font-size:18px}' +
    '.panel{background:#19263e;border:1px solid #354863;border-radius:15px;padding:19px;margin:20px 0}' +
    'p{color:#b5c6dc}.results{list-style:none;margin:16px 0;padding:0}.results li{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid #354863;flex-wrap:wrap}.results strong{color:#d2ebff}' +
    '.links{display:grid;gap:10px}.links a{border:1px solid #56708e;border-radius:10px;background:#192e4b;padding:11px;color:#d9edff;text-decoration:none}' +
    '.notice{font-size:13px;color:#e3c797}a{color:#a4d1ff}' +
    '</style></head><body><main><p>LoSP · Diagnostic OAuth Scopely</p>' +
    '<h1>Permissions d’alliance</h1><section class="panel"><h2>' + escapeHtml(probe.label) + '</h2>' +
    '<p><strong>' + escapeHtml(message) + '</strong></p>' + checks +
    '<p class="notice">Ce test vérifie seulement les droits du token OAuth : aucun inventaire, rapport de guerre, raid ni activité n’a été téléchargé. Aucun token n’est conservé.</p></section>' +
    '<h2>Autres essais disponibles</h2><nav class="links">' + links + '</nav>' +
    '<p class="notice">Un refus du test groupé peut être isolé en essayant les quatre permissions séparément. Chaque essai peut demander une nouvelle connexion Scopely.</p>' +
    '<p><a href="/">Retour à l’accueil</a></p></main></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce +
      "'; style-src 'nonce-" + nonce +
      "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const remove = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  for (const name of [
    "__Host-losp_oauth_state", "__Host-losp_oauth_verifier", probe.cookie
  ]) headers.append("Set-Cookie", name + "=" + remove);
  return new Response(html, { status: 200, headers });
}
