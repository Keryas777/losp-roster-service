// Private, one-response viewer for OAuth-authorized shared alliance rosters.
// No storage, public JSON, third-party scripts, untrusted HTML or token exposure.
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const number = value => Number.isSafeInteger(value) && value >= 0
  ? value.toLocaleString("fr-FR") : "—";
const safeImage = value => {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "assets.marvelstrikeforce.com" &&
      url.pathname.startsWith("/imgs/") && /\.(?:png|jpg|jpeg|webp)$/i.test(url.pathname) &&
      !url.search && !url.hash && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

function portraitCard(char) {
  const title = typeof char.info?.name === "string" && char.info.name.trim()
    ? char.info.name.slice(0, 140) : char.id;
  const img = safeImage(char.info?.portrait);
  const power = Number.isSafeInteger(char.power) && char.power >= 0 ? char.power : 0;
  const red = Number.isInteger(char.activeRed) ? char.activeRed : null;
  const rank = red === null ? "" : red > 7 ? (red - 7) + " diamant(s)" : red + " rouges";
  const rankText = [
    char.activeYellow ? char.activeYellow + " ★" : "",
    rank
  ].filter(Boolean).join(" · ");
  const isoClass = typeof char.iso8?.activeClass === "string" ? char.iso8.activeClass
    : typeof char.iso8?.class === "string" ? char.iso8.class : "";
  const photo = img
    ? '<img loading="lazy" decoding="async" src="' + escape(img) +
      '" alt="" width="60" height="60" referrerpolicy="no-referrer">'
    : '<span class="portrait-placeholder" aria-hidden="true">★</span>';
  return '<article class="character" data-search="' + escape(title.toLowerCase()) +
    '" data-power="' + power + '" data-level="' + (char.level || 0) + '">' +
    '<div class="portrait">' + photo + '</div>' +
    '<div class="char-info"><strong>' + escape(title) + '</strong>' +
    '<span class="stats">Niv. ' + number(char.level) + ' · G' + number(char.gearTier) +
    ' · ' + escape(rankText || "Étoiles indisponibles") + '</span>' +
    (isoClass ? '<span class="iso">ISO-8 : ' + escape(isoClass.slice(0, 35)) + '</span>' : "") +
    '</div><div class="power"><strong>' + number(char.power) +
    '</strong><small>Puissance</small></div></article>';
}

export function renderLiveRosterViewer(report) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const ok = report.status === "complete" && Array.isArray(report.rosters);
  const collection = ok ? report.rosters.slice(0, 3) : [];
  const members = collection.map((row, i) =>
    '<button type="button" class="member-tab" data-target="member-' + i +
    '" aria-pressed="' + (i === 0 ? "true" : "false") + '">' +
    escape(String(row.name || "Joueur " + (i + 1)).slice(0, 120)) +
    ' <span>' + number(row.chars.length) + '</span></button>').join("");
  const groups = collection.map((row, i) =>
    '<section class="member-group" id="member-' + i + '"' +
    (i ? ' hidden' : "") + '><div class="member-heading">' +
    '<h2>' + escape(String(row.name || "Joueur").slice(0, 120)) + '</h2>' +
    '<span class="count">' + number(row.chars.length) + ' personnages</span></div>' +
    '<div class="characters">' + row.chars.map(portraitCard).join("") +
    '</div></section>').join("");

  const scopeAudit = report.captainScopeAudit;
  const persistenceNotes = {
    active: 'La connexion du capitaine est conservée dans un coffre privé chiffré. Retour sans code via /captain, tant que Scopely permet le renouvellement.',
    disabled: 'La permission de maintien n’est pas encore active : les jetons sont détruits après cette visite. Configurer le stockage privé avant d’inviter les autres capitaines.',
    "scope-not-granted": 'Autorisation offline ou partage de roster refusé : connexion durable impossible.',
    "missing-refresh-token": 'Scopely n’a pas transmis de refresh_token exploitable. Connexion durable impossible.',
    "store-failed": 'Le stockage privé a échoué : aucun accès durable n’a été établi.'
  };
  const note = persistenceNotes[report.captainPersistence] ||
    'Les jetons ne sont pas conservés avant activation du stockage privé.';
  const scopeBanner = scopeAudit ? '<section class="permissions" aria-label="Autorisations Scopely">' +
    '<h2>Autorisations accordées : ' + scopeAudit.granted + ' / ' +
    scopeAudit.total + '</h2>' +
    (scopeAudit.state === "unreported" ?
      '<p>Scopely ne précise pas les permissions dans sa réponse OAuth : vérification impossible.</p>' :
      scopeAudit.state === "partial" ?
        '<p>Certaines permissions manquent. Ne pas inviter les autres capitaines avant confirmation.</p>' :
        '<p>Les neuf autorisations demandées figurent dans la réponse OAuth.</p>') +
    '<ul>' + scopeAudit.scopes.map(row => '<li>' +
      (row.granted ? '✓ ' : '— ') + escape(row.label) +
      (row.granted ? ' : accordé' : ' : non confirmé') + '</li>').join("") +
    '</ul><p class="scope-note">' + escape(note) + '</p></section>' : "";

  const body = ok
    ? '<div class="summary"><div><strong>' + number(report.completedCount) +
      '</strong><span>Rosters affichés</span></div><div><strong>' +
      number(report.characterCount) + '</strong><span>Personnages</span></div>' +
      '<div><strong>' + number(report.sharedCount) +
      '</strong><span>Rosters partagés</span></div></div>' +
      '<p class="notice">Vue de vos trois premiers coéquipiers partageant leur roster. ' +
      'Les autres membres seront accessibles une fois les sessions sécurisées activées. ' +
      'Ces données ne sont pas enregistrées.</p>' +
      '<nav class="member-tabs" aria-label="Joueurs">' + members + '</nav>' +
      '<div class="controls"><label class="search-wrap" for="search">Rechercher un personnage' +
      '<input id="search" type="search" autocomplete="off" placeholder="Nom du personnage"></label>' +
      '<label class="sort-wrap" for="sort">Trier par' +
      '<select id="sort"><option value="power">Puissance décroissante</option>' +
      '<option value="level">Niveau décroissant</option>' +
      '<option value="name">Nom A → Z</option></select></label></div>' +
      '<p class="visible-count" id="visible-count" aria-live="polite"></p>' + groups
    : '<section class="failure"><h2>Les rosters ne sont pas disponibles</h2>' +
      '<p>Lecture interrompue : ' + escape(report.status || "erreur inconnue") +
      '. Aucune donnée partielle n’est affichée.</p>' +
      '<a href="/">Retour à l’accueil</a></section>';

  const js = [
    'const tabs=Array.from(document.querySelectorAll(".member-tab"));',
    'const sections=Array.from(document.querySelectorAll(".member-group"));',
    'const search=document.getElementById("search"),sort=document.getElementById("sort");',
    'const visible=document.getElementById("visible-count");',
    'function update(){',
    ' const active=sections.find(s=>!s.hidden);if(!active)return;',
    ' const grid=active.querySelector(".characters");',
    ' const items=Array.from(grid.querySelectorAll(".character"));',
    ' const q=(search?.value||"").trim().toLocaleLowerCase("fr");let n=0;',
    ' items.sort((a,b)=>sort.value==="name"?a.dataset.search.localeCompare(b.dataset.search,"fr"):',
    '  Number(b.dataset[sort.value])-Number(a.dataset[sort.value]));',
    ' for(const el of items){el.hidden=!!q&&!el.dataset.search.includes(q);if(!el.hidden)n++;grid.appendChild(el);}',
    ' visible.textContent=n+" personnage"+(n>1?"s":"")+" affiché"+(n>1?"s":"");',
    '}',
    'for(const tab of tabs)tab.addEventListener("click",()=>{',
    ' for(const b of tabs)b.setAttribute("aria-pressed",String(b===tab));',
    ' for(const section of sections)section.hidden=section.id!==tab.dataset.target;',
    ' update();',
    '});',
    'if(search)search.addEventListener("input",update);',
    'if(sort)sort.addEventListener("change",update);',
    'update();',
    'try{history.replaceState(null,"","/oauth/status?result=profile-expired")}catch{}'
  ].join("\n");
  const css = [
    ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#080e1b;color:#eff5ff;font:15px/1.5 system-ui,-apple-system,sans-serif}',
    'main{max-width:1100px;margin:auto;padding:20px 14px 64px}header{padding:10px 0 18px}',
    '.eyebrow{color:#8fa8cc;text-transform:uppercase;letter-spacing:.15em;font-size:11px;font-weight:700}',
    'h1{font-size:clamp(26px,6vw,38px);line-height:1.12;margin:6px 0 10px}h2{font-size:20px;margin:0}',
    '.intro,.notice{color:#aebdd4}a{color:#92caff}',
    '.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:18px 0}',
    '.summary>div{background:#152239;border:1px solid #2b3f5c;border-radius:13px;padding:13px 9px}',
    '.summary strong{display:block;font-size:26px;color:#fff;font-variant-numeric:tabular-nums}',
    '.summary span{font-size:11px;color:#b3c2d8}.notice{font-size:13px}',
    '.member-tabs{display:flex;gap:8px;overflow-x:auto;padding:6px 0 16px;scrollbar-width:thin}',
    '.member-tab{flex:0 0 auto;min-height:43px;border:1px solid #40516b;border-radius:11px;background:#172339;color:#dbe8fb;font-weight:650;padding:9px 13px;cursor:pointer}',
    '.member-tab[aria-pressed=true]{background:#184c83;border-color:#7ac2ff;color:#fff}',
    '.member-tab span{opacity:.65;margin-left:5px}',
    '.controls{display:grid;grid-template-columns:1fr;gap:12px;margin:0 0 12px}',
    'label{display:flex;flex-direction:column;gap:5px;color:#b8cce6;font-size:12px}',
    'input,select{width:100%;min-height:44px;padding:10px 12px;border-radius:10px;border:1px solid #415875;background:#0e1a2d;color:#fff;font:inherit}',
    '.member-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:12px 0}',
    '.count,.visible-count{font-size:12px;color:#a9bedb}.visible-count{margin:0 0 8px}',
    '.characters{display:grid;grid-template-columns:1fr;gap:7px}',
    '.character{display:flex;align-items:center;gap:9px;min-width:0;padding:9px;background:#142139;border:1px solid #283c58;border-radius:11px}',
    '.portrait{width:58px;height:58px;flex:0 0 58px;background:#202d49;border-radius:9px;overflow:hidden;display:grid;place-items:center}',
    '.portrait img{width:100%;height:100%;object-fit:cover}.portrait-placeholder{font-size:26px;color:#8298b7}',
    '.char-info{min-width:0;flex:1}.char-info strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}',
    '.stats,.iso{display:block;color:#b1c3dc;font-size:12px}.iso{color:#9cbbf0}',
    '.power{text-align:right;min-width:76px;font-variant-numeric:tabular-nums}.power strong{font-size:13px}.power small{display:block;font-size:10px;color:#8198b9}',
    '[hidden]{display:none!important}.failure{background:#172339;border-radius:12px;padding:22px}',
    '.permissions{background:#132339;border:1px solid #39506d;border-radius:12px;padding:16px;margin:18px 0}',
    '.permissions p{color:#b1c5df;font-size:13px}.permissions ul{padding-left:18px;font-size:13px;columns:1}',
    '.scope-note{font-size:12px;color:#efc98f!important}',
    'footer{margin-top:24px;color:#91a4c2;font-size:12px}',
    '@media(min-width:660px){.controls{grid-template-columns:2fr 1fr}.characters{grid-template-columns:repeat(2,minmax(0,1fr))}}'
  ].join("");
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>Rosters LoSP — Marvel Strike Force</title>' +
    '<style nonce="' + nonce + '">' + css + '</style></head><body>' +
    '<main><header><span class="eyebrow">LoSP · Marvel Strike Force</span>' +
    '<h1>Rosters de l’alliance</h1><p class="intro">Les vrais personnages de vos coéquipiers, directement issus de l’API officielle.</p>' +
    '</header>' + scopeBanner + body + '<footer>Lecture privée et temporaire · Aucun roster stocké dans GitHub Pages.</footer>' +
    '</main><script nonce="' + nonce + '">' + js + '</script></body></html>';
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce +
      "'; style-src 'nonce-" + nonce +
      "'; img-src https://assets.marvelstrikeforce.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  });
  const remove = "; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
  const cookiesToClear = [
    "__Host-losp_oauth_state", "__Host-losp_oauth_verifier",
    "__Host-losp_oauth_roster_viewer"
  ];
  if (scopeAudit) cookiesToClear.push("__Host-losp_oauth_captain");
  for (const name of cookiesToClear) headers.append("Set-Cookie", name + "=" + remove);
  return new Response(html, { status: 200, headers });
}
