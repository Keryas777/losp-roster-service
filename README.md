# LoSP Roster Service

Service Cloudflare Worker indépendant de [`Keryas777/msf`](https://github.com/Keryas777/msf) pour consulter, avec les autorisations officielles de Scopely, des informations de Marvel Strike Force (MSF) : profils, alliances, rosters partagés et, selon les droits réellement accordés, autres données accessibles par l'API.

**État documenté : 18 octobre 2026, `main` après la PR [#35](https://github.com/Keryas777/losp-roster-service/pull/35).** Ce README décrit le **code intégré**. Les tests automatiques et un déploiement réussi ne constituent pas une validation en production de tous les parcours OAuth, du renouvellement des jetons ou de l'accès administrateur.

## Situation actuelle

| Composant | État dans le dépôt | Limite importante |
| --- | --- | --- |
| OAuth Scopely ponctuel | Fonctionnel dans le code (`/login`, callback et diagnostics) | Sans session conservée pour ces parcours historiques |
| Consentement capitaine | `/login/captain`, 9 scopes dont `offline` et `m3p.f.ar.ros` | Les scopes doivent être **effectivement accordés** |
| Session capitaine persistante | Coffre R2 chiffré, cookie opaque, Durable Object et renouvellement programmé ; `CAPTAIN_SESSIONS_ENABLED=true` dans Wrangler | Dépend des secrets/bindings Cloudflare et de la validation réelle des rotations Scopely |
| Lecture de rosters | Vue mobile des **3 premiers** coéquipiers dont le roster est partagé | Aucune synchronisation permanente ni diffusion publique |
| Couverture multi-alliances | Découverte et agrégation privées, sans alliance codée en dur | Scan quotidien désactivé : `CAPTAIN_COVERAGE_ENABLED=false` |
| Administration | Explorateur privé `/admin`, lecture seule, authentification Cloudflare Access ; `MSF_ADMIN_ENABLED=true` dans Wrangler | Dernier refus connu : récupération des clés JWKS ; résolution réelle après PR #35 non confirmée |
| Publication vers la Web-app LoSP | Non implémentée | Aucun roster automatique écrit dans `Keryas777/msf` ou GitHub Pages |

Le Worker sert aussi des pages statiques HTML/CSS/JavaScript vanilla (mobile first). Pas de framework front-end ni de serveur lourd. Le dépôt `Keryas777/msf` et ses fichiers de rosters restent indépendants.

## Accès et parcours principaux

Origine de production enregistrée chez Scopely : **https://losp-roster-service.deliriousfan7.workers.dev**. Callback : `/oauth/callback`. Le flux OAuth de production ne doit pas être démarré depuis une URL de preview.

| Route | Usage | Accès |
| --- | --- | --- |
| `/`, `/index.html` | Accueil et liens | Public |
| `/privacy.html`, `/tos.html` | Confidentialité et conditions d'utilisation | Public |
| `GET /health` | Santé du Worker (version exposée `0.1.2`) | Public |
| `GET /login` | OAuth minimal, puis lecture éphémère du profil | Consentement Scopely |
| `GET /login/rosters` | Vue éphémère des rosters partagés (3 membres maximum) | Consentement Scopely |
| `GET /login/captain` | Consentement complet et création d'une session durable si les conditions sont réunies ; réutilisation d'une session active | Consentement Scopely |
| `GET /captain` | Espace de la session persistante | Cookie capitaine |
| `GET /session` | État de connexion sans identité ni jeton | Cookie capitaine |
| `GET /captain/rosters` | Rosters partagés de l'alliance **actuelle** | Session capitaine active |
| `GET /captain/coverage` | Membres et état du partage de l'alliance actuelle | Session capitaine active |
| `POST /logout` | Suppression de la session LoSP et tentative de révocation Scopely | Cookie + contrôle `Origin` |
| `GET /admin` | Explorateur privé de l'API MSF | Cloudflare Access + autorisation administrateur |
| `GET /admin/api/catalog`, `/sessions`, `/data` | Catalogue, sessions et lectures d'API autorisées | Même contrôle administrateur sur **chaque requête** |

`GET /oauth/status` présente les résultats bornés des parcours ponctuels ; `/oauth/callback` traite le retour OAuth côté Worker. Les diagnostics historiques sont détaillés plus bas.

## OAuth Scopely et permissions

Le Worker utilise `authorization_code`, **PKCE S256**, un `state` anti-CSRF et des cookies temporaires `__Host-` en `Secure`, `HttpOnly` et `SameSite=Lax` (10 minutes). L'échange du code et les appels API authentifiés se déroulent côté Worker. Le jeton Scopely n'est jamais remis au JavaScript du navigateur.

Le manifeste `src/captain-scopes.js` demande **neuf scopes** pour `/login/captain` :

| Scope | Fonction |
| --- | --- |
| `openid` | Identification Scopely |
| `m3p.f.pr.pro` | Profil personnel |
| `m3p.f.pr.ros` | Roster et équipes personnels |
| `m3p.f.pr.inv` | Inventaire personnel |
| `m3p.f.pr.act` | Activité et événements personnels |
| `m3p.f.pr.buy` | Consultation des offres |
| `m3p.f.ar.pro` | Profil et membres de l'alliance |
| `m3p.f.ar.ros` | Rosters et équipes partagés de l'alliance |
| `offline` | Autorisation de renouveler l'accès |

Le scope `m3p.f.ar.ros` a été **accordé lors d'un test réel le 16 octobre 2026** (travaux des PR #22 à #25) ; ce n'est plus un scope purement hypothétique. À l'inverse, `m3p.f.ar.inv`, `m3p.f.ar.raid`, `m3p.f.ar.war` et `m3p.f.ar.act` restent non validés : ils apparaissent dans des tags de la spécification mais ne sont **pas** ajoutés à `CAPTAIN_SCOPES`. Leurs tests isolés restent facultatifs.

**Le consentement est attaché à un compte MSF, pas au titre de « capitaine LoSP ».** Une permission OAuth n'autorise ni publication de données, ni accès aux alliances précédentes, ni usage d'un endpoint Scopely qui répond 403/464.

## Sessions capitaines et tokens

Cette partie est présente depuis les PR [#27](https://github.com/Keryas777/losp-roster-service/pull/27) à [#30](https://github.com/Keryas777/losp-roster-service/pull/30), avec la correction du changement d'alliance en [#28](https://github.com/Keryas777/losp-roster-service/pull/28).

- `src/captain-vault.js` : tokens `access_token` et `refresh_token` chiffrés en **AES-256-GCM**, dans le bucket **R2 privé** `losp-roster-sessions` sous `oauth-captains/v1/`. Chaque objet est adressé par le SHA-256 d'un identifiant aléatoire de session, jamais par un nom de joueur ou un token.
- `src/captain-refresh-coordinator.js` : **Durable Object** par session, avec sérialisation des rotations d'un `refresh_token` potentiellement à usage unique. Aucun jeton en clair n'est conservé durablement dans le DO.
- `src/captain-session-routes.js` : cookie `__Host-losp_captain_session` opaque, `Secure`, `HttpOnly` et `SameSite=Lax` ; **180 jours glissants**, prolongés uniquement après validation d'une session active. Le cookie ne contient aucun jeton OAuth.
- Enregistrement chiffré : **365 jours maximum glissants après renouvellement réussi**. La conservation R2 `captain-tokens-365d` porte sur le préfixe des sessions capitaines ; elle n'est pas la politique des futurs snapshots de rosters.
- Cron `15 * * * *` : vérification et renouvellement des jetons proches de l'expiration, sans téléchargement de rosters. Les erreurs temporaires ne forcent pas une reconnexion ; une révocation ou `invalid_grant` retire l'accès local selon le comportement prévu.
- `POST /logout` : suppression locale puis tentative de révocation auprès de Scopely. Un échec réseau ne doit pas être présenté comme une révocation distante confirmée.

La persistance n'est possible que si **tous** les prérequis de production sont réunis : `CAPTAIN_SESSIONS_ENABLED=true`, binding R2 `CAPTAIN_BUCKET`, binding Durable Object `CAPTAIN_REFRESH_COORDINATOR`, secret `CAPTAIN_ENCRYPTION_KEY_HEX` valide et secrets OAuth Scopely. Un stockage incomplet bloque le nouveau consentement capitaine ; `offline` seul ne suffit jamais. Perdre la clé de chiffrement rend les sessions illisibles.

Si le capitaine change d'alliance, `/captain/rosters` récupère **à chaque consultation** les membres de sa nouvelle alliance auprès de Scopely et exige exactement un membre `isSelf === true`. Seuls les coéquipiers actuels ayant `card.rosterShare === true` sont éligibles. La lecture est limitée à trois rosters, sans stockage de ces données ; un ancien identifiant d'alliance n'est pas réutilisé.

Le prototype `src/session-vault.js` (ancien coffre éphémère de 24 h) est distinct et **non branché** au mécanisme capitaine. Ne pas le confondre avec `src/captain-vault.js`.

**À valider en production** : rotation réelle de `refresh_token`, révocation effective, récupération après erreur entre rotation et écriture R2, gestion de plusieurs sessions d'un compte et reconnexion après expiration du cookie. Les tests locaux ne prouvent pas ces cas.

Documentation : [docs/oauth-session-architecture.md](docs/oauth-session-architecture.md) (guide historique de déploiement ; vérifier les valeurs actuelles dans `wrangler.jsonc`).

## Couverture privée de plusieurs alliances

La PR [#31](https://github.com/Keryas777/losp-roster-service/pull/31) prépare `src/alliance-coverage.js` :

- Découverte des alliances **actuelles** depuis les sessions OAuth conservées, sans hardcoder Zeus, Athéna, Kronos, Dionysos ou Poséidon.
- Déduplication de plusieurs capitaines d'une même alliance sur le `aid` stable extrait de `{aid}:{member_version}`, pas sur le nom ni la version d'effectif.
- Comptage des membres et des partages de roster ; aucune collecte de personnages.
- Scanner limité à **12 sessions** par exécution ; résultat non exhaustif signalé par `complete=false`.
- Résultat agrégé dans R2 privé : `oauth-coverage/v1/latest.json`, sans identité de membre, jeton ni roster.
- Cron prévu `15 3 * * *` (03:15 UTC) mais **inactif** tant que `CAPTAIN_COVERAGE_ENABLED` reste `false`.
- `/captain/coverage` : lecture individuelle, immédiate et éphémère de l'alliance du compte connecté ; elle ne nécessite pas l'activation du scanner global.

Avant d'activer le scanner : valider les rotations réelles, la règle de conservation **30 jours** propre à `oauth-coverage/v1/` et la couverture des comptes concernés.

Avant toute synchronisation multi-alliances, créer un **registre privé dynamique** des alliances LoSP approuvées (identifiants officiels) et des responsables autorisés ; l'identité d'un joueur et son consentement ne prouvent pas sa fonction de capitaine. Voir [docs/multi-alliance-coverage-phase-1.md](docs/multi-alliance-coverage-phase-1.md).

## Administration privée et explorateur API MSF

La PR [#32](https://github.com/Keryas777/losp-roster-service/pull/32) fournit `/admin` et son front-end `public/admin-explorer.js` / `public/admin-explorer.css`. Le panneau permet, **en lecture seule** :

- d'énumérer les sessions capitaines par pages de 10 ;
- d'afficher les profils et alliances actuels des comptes connectés ;
- de consulter les catégories d'API autorisées : profil, roster personnel, inventaire, souhaits, équipes, événements, alliance, membres, rosters partagés et catalogues/détails de jeu ;
- de voir tableaux et réponses JSON **intégrales** (champs imbriqués, propriétés inconnues, `meta`) ; l'export JSON demandé explicitement reste sur l'appareil administrateur.

Les requêtes sont limitées à des **routes GET inscrites explicitement** dans `src/admin-data-api.js`, avec pagination et limites de taille. Pour le roster d'un membre, le serveur revalide à chaque demande son appartenance à l'alliance actuelle et `rosterShare === true`. Certains endpoints peuvent rester indisponibles malgré un scope accordé ; aucune donnée ne doit être inventée.

### Contrôle administrateur Cloudflare Access

- `MSF_ADMIN_ENABLED=true` est enregistré dans `wrangler.jsonc` depuis la PR #33. Ce drapeau **n'accorde pas** à lui seul l'accès.
- Une application Cloudflare Zero Trust Access doit couvrir **`/admin` et `/admin/*`**, avec politique restreinte aux administrateurs et MFA.
- Le Worker requiert `CF_ACCESS_TEAM_DOMAIN` (domaine `*.cloudflareaccess.com`), `CF_ACCESS_AUD` et `MSF_ADMIN_EMAILS`, configurés côté Cloudflare.
- Il valide le **JWT signé RS256** transmis via `Cf-Access-Jwt-Assertion` ou, si l'en-tête est absent, via le cookie officiel `CF_Authorization` (PR [#33](https://github.com/Keryas777/losp-roster-service/pull/33)). La signature JWKS, l'émetteur, l'audience, les dates et l'e-mail autorisé sont tous vérifiés. Ni une session capitaine, ni un simple en-tête d'e-mail ne permettent de devenir administrateur.
- Les PR [#34](https://github.com/Keryas777/losp-roster-service/pull/34) et [#35](https://github.com/Keryas777/losp-roster-service/pull/35) ajoutent des diagnostics de refus **sans données sensibles**. Si et seulement si `MSF_ADMIN_DIAGNOSTICS_ENABLED=true` est défini temporairement dans Cloudflare, le HTTP 403 affiche un code fixe (`jwt-*`, `jwks-http-*`, `jwks-redirect`, `jwks-timeout`, `jwks-network-error`, `jwks-invalid-json`, etc.).
- Les certificats sont récupérés depuis `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, sans suivre les redirections, avec un délai maximal de **12 secondes**. L'échec de la vérification **refuse l'accès** : aucun contournement par une information non signée.

**Dernier incident réel documenté (17 octobre 2026)** : authentification Cloudflare Access réussie sur iOS, mais `/admin` refusé avec `jwks-unavailable`. La PR #35 détaille désormais la cause, sans preuve dans le dépôt que l'accès fonctionne finalement en production. Tester à nouveau `/admin`, ne transmettre **que le code de diagnostic**, puis désactiver `MSF_ADMIN_DIAGNOSTICS_ENABLED` une fois le problème résolu. Ne jamais partager JWT, cookies, jetons ou secrets.

Voir [docs/admin-api-explorer.md](docs/admin-api-explorer.md).

## Configuration et déploiement

Le déploiement Cloudflare Workers s'appuie sur `wrangler.jsonc` ; `main` est la branche de déploiement automatique. **Ne pas modifier directement `main`** : créer une branche et une PR.

Configuration non secrète actuellement versionnée :

| Élément | Valeur |
| --- | --- |
| `CAPTAIN_SESSIONS_ENABLED` | `"true"` |
| `CAPTAIN_COVERAGE_ENABLED` | `"false"` |
| `MSF_ADMIN_ENABLED` | `"true"` |
| `CAPTAIN_BUCKET` | R2 `losp-roster-sessions` |
| `CAPTAIN_REFRESH_COORDINATOR` | Durable Object `CaptainRefreshCoordinator` |
| Cron des tokens | `15 * * * *` |
| Cron de découverte | `15 3 * * *` (inactif sans activation explicite) |

Secrets et paramètres de confiance à gérer **uniquement dans Cloudflare**, jamais dans ce dépôt :

- Scopely : `SCOPELY_CLIENT_ID`, `SCOPELY_CLIENT_SECRET`.
- Sessions : `CAPTAIN_ENCRYPTION_KEY_HEX`, clé de 32 octets / 64 caractères hexadécimaux.
- Administration : `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `MSF_ADMIN_EMAILS`.
- Diagnostic facultatif : `MSF_ADMIN_DIAGNOSTICS_ENABLED` (laisser absent ou à `false` hors investigation).

**Attention :** les variables définies uniquement dans le Dashboard Cloudflare peuvent être affectées par les prochains déploiements Wrangler. Synchroniser les **drapeaux non secrets** avec `wrangler.jsonc` via PR, mais ne jamais y copier les secrets.

Les politiques de conservation doivent être **distinctes par préfixe** : `oauth-captains/v1/` (sessions), `oauth-coverage/v1/` (agrégats) et, à terme, snapshots des rosters (maximum **30 jours** à compter de leur collecte). Aucun bucket ne doit être exposé publiquement.

## Diagnostics historiques (toujours disponibles)

Ces routes sont des tests **volontaires, bornés, éphémères** ; elles ne remplacent ni `/login/captain` ni le panneau administrateur. Elles ne sauvegardent pas de jeton ou de roster durablement.

| Route OAuth | Objet |
| --- | --- |
| `/login/alliance-test` | Vérifier l'accès à un roster partagé d'un coéquipier |
| `/login/roster-scope-test` | Comparer les droits roster personnel / roster d'alliance |
| `/login/alliance-scope-test` | Contrôler le scope `m3p.f.ar.ros` accordé |
| `/login/alliance-collection-test` | Tester une collecte paginée et bornée (3 membres au maximum) |
| `/login/inventory-test` | Vérifier une lecture minimale de l'inventaire personnel |
| `/login/profiles-test` | Tester les fiches d'alliance et de membres, avec limites |
| `/login/coverage-test` | Audit des types et champs accessibles avec un consentement |
| `/login/card-types-test` | Vérifier les types réels de `rosterShare` et `aid` |
| `/login/metrics-test` | Comparer les agrégats et statistiques du compte connecté |
| `/login/iso-icons-test` | Inspecter les URL d'icônes ISO-8 officielles |
| `/login/scope-probe/all` | Tester ensemble quatre scopes d'alliance non confirmés |
| `/login/scope-probe/inv`, `/raid`, `/war`, `/act` | Replis isolés si le test groupé échoue |

Les observations datées de l'API réelle figurent dans [docs/single-oauth-coverage-audit-2026-10-09.md](docs/single-oauth-coverage-audit-2026-10-09.md). Ne pas confondre `AllianceMemberCard.card.rosterShare` (booléen) et `PlayerCard.rosterShare` (chaîne observée en test). Aucune nouvelle autorisation ne doit être déduite de la simple présence d'un champ.

## Tests

Tests locaux sans dépendance applicative ni compte Scopely réel (Node.js 22+ **uniquement pour les tests**, pas pour l'exécution du Worker) :

```sh
node --test tests/*.test.mjs
```

La CI [Worker OAuth tests](.github/workflows/oauth-tests.yml) couvre notamment les sessions, rotations simulées, couverture, authentification administrateur et diagnostics JWKS. Les tests et builds de la PR #35 ont réussi ; une validation en conditions réelles est indispensable pour les appels Scopely et Cloudflare Access.

Ne jamais committer ni recopier dans une issue, une PR, ChatGPT ou Discord des tokens, JWT, identifiants secrets, réponses d'inventaire personnelles ou données privées de joueurs.

## Prochaines étapes

1. **Lever le dernier blocage de `/admin`** en production à partir du nouveau diagnostic JWKS, sans affaiblir la validation cryptographique.
2. Valider la **rotation OAuth réelle** Scopely et les scénarios de révocation, de panne et de reconnexion.
3. Compléter le **registre privé dynamique** des alliances LoSP et des capitaines habilités ; vérifier les changements d'alliance et les consentements.
4. Activer la découverte agrégée uniquement après vérification des prérequis et de la conservation.
5. Concevoir séparément les **snapshots privés de rosters partagés**, leurs contrôles, leur expiration (≤ 30 jours) puis une éventuelle intégration explicite et maîtrisée à `Keryas777/msf`. **Aucune publication automatique aujourd'hui.**

API officielle : https://developer.marvelstrikeforce.com/beta/msf-api.json
