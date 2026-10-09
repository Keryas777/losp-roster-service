# LoSP Roster Service

Service indépendant de `Keryas777/msf` pour les rosters autorisés de Marvel Strike Force et la progression des Dimensions Noires.

## État du projet

- Worker Cloudflare en JavaScript vanilla, déployé automatiquement depuis `main`.
- `GET /health` : état du service (version 0.1.2 inchangée).
- `/`, `/privacy.html` et `/tos.html` : pages publiques.
- `GET /login` : **phase OAuth 1**. Construit une redirection officielle Scopely (`authorization_code`, `state` aléatoire et PKCE S256) en utilisant `SCOPELY_CLIENT_ID` au runtime.
- `GET /oauth/callback` : **phase OAuth 3 — validation et lecture éphémère du profil**. Vérifie `state` et PKCE, échange le code uniquement côté Worker (Client ID + Client Secret en HTTP Basic) puis supprime les cookies temporaires. **Les tokens ne sont ni enregistrés, ni renvoyés au navigateur.** Le compte n'est donc PAS encore connecté durablement.
- `GET /oauth/status` : confirme simplement le résultat du test sans afficher de jetons, codes ni détails d'erreur Scopely.

## OAuth — configuration

Le seul domaine autorisé au démarrage est `https://losp-roster-service.deliriousfan7.workers.dev` et le callback enregistré chez Scopely est `/oauth/callback`.

Variables secrètes Cloudflare **Runtime / Production** :

- `SCOPELY_CLIENT_ID` : utilisé uniquement côté Worker par `/login`.
- `SCOPELY_CLIENT_SECRET` : utilisé uniquement côté Worker pour l'échange du code sur `/oauth/callback`, jamais transmis par `/login`.

Les deux cookies temporaires `__Host-losp_oauth_state` et `__Host-losp_oauth_verifier` sont `Secure`, `HttpOnly`, `SameSite=Lax`, avec une expiration de 10 minutes et sans attribut `Domain`. Ils servent à valider le callback pendant un test OAuth unique. Ils sont effacés après le callback. Aucun token ne passe dans ces cookies.

Les scopes minimaux demandés à ce stade sont `openid m3p.f.pr.pro`. L'accès aux rosters, à l'alliance et la persistance attendent la conception du stockage et de la suppression conformes au Developer Agreement. Ce test ne demande pas `offline` et jette immédiatement tous les tokens renvoyés.

## Tests

Tests de développement sans dépendance applicative, avec Node.js 22+ uniquement comme outil de test local (le Worker ne dépend pas de Node.js en production) :

```sh
node --test tests/*.test.mjs
```

Les tests simulent localement l'endpoint de tokens, sans appel réel à Scopely. La vérification live du fournisseur nécessite un test explicite dans le navigateur. Ne jamais committer de secret, de jeton ou de données privées Scopely.

## Lecture temporaire du profil

Après le succès de l'authentification, le Worker effectue un seul appel officiel à `/player/v1/card` avec le jeton en mémoire. Il affiche le pseudo, le niveau et quelques statistiques de la carte, sans enregistrer les données ni renvoyer le jeton au navigateur. La page est non mise en cache et n'est visible que jusqu'au rechargement. Aucun accès aux rosters n'est activé à ce stade.

Les tests simulent les appels OAuth et profil sans utiliser de comptes réels.

## Vérification ponctuelle d'accès au roster d'un coéquipier

URL **volontairement distincte** de la connexion normale :
`GET /login/alliance-test`.

Cette route ajoute uniquement le scope OAuth documenté `m3p.f.ar.pro` (View Alliance Profile) aux permissions déjà utilisées. Après le callback, le Worker appelle `GET /player/v1/alliance/members`, vérifie le booléen `card.rosterShare === true` et sélectionne **un seul membre qui n'est pas le compte connecté**. Si aucun ne partage son roster, aucun appel de roster n'est effectué.

Ensuite, au plus un `GET /player/v1/roster/member/{memberId}?page=1&perPage=1` est réalisé. Le roster complet, les IDs internes et les personnages ne sont jamais exposés : la page temporaire indique uniquement le nombre de membres, le nombre de coéquipiers partageant, le pseudonyme du membre testé et le statut d'accès. Elle ne conserve ni token, ni roster, ni identité durable. La page est non mise en cache et son URL est neutralisée dans l'historique du navigateur.

L'OpenAPI associe la lecture des rosters des membres à `m3p.f.ar.ros`, **qui ne figure pas dans les scopes OAuth disponibles**. Un code `464 NO_ACCESS` reste donc possible même pour `rosterShare === true`; ce test est précisément destiné à le mesurer et ne contourne aucune restriction. Le `memberId` est éphémère et doit être redécouvert à chaque appel. Ne pas synchroniser 24 rosters en extrapolant à partir d'un seul test.

`/login` continue de fonctionner comme avant. Ne pas utiliser ce test comme mécanisme de production ; aucune liaison durable Scopely ou R2 n'est activée.

## Test comparatif des droits de consultation des rosters

URL de diagnostic distincte : `GET /login/roster-scope-test`.

Cette route ajoute **View Roster** (`m3p.f.pr.ros`) aux droits utilisés par le test d'alliance (`m3p.f.pr.pro m3p.f.ar.pro`) ; `/login` et `/login/alliance-test` restent inchangés. Après OAuth, le Worker vérifie successivement :

1. La lecture d'une seule entrée du roster du compte connecté via `GET /player/v1/roster?page=1&perPage=1`.
2. Les 24 membres de l'alliance du compte connecté, et leurs indicateurs `isSelf` / `rosterShare`.
3. Au maximum une entrée du roster d'un autre membre ayant `rosterShare === true`, via l'endpoint d'alliance déjà utilisé.

Le diagnostic affiche les succès et les refus HTTP des deux consultations **indépendamment**, sans exposer les tokens, les identifiants des membres ni les personnages. Les données ne sont ni stockées, ni mises en cache. Une lecture du roster personnel ne garantit pas l'autorisation `m3p.f.ar.ros` nécessaire à celui des coéquipiers. Si l'accès aux coéquipiers reste interdit, il faudra demander à Scopely comment obtenir ce droit officiellement, sans forger de scope OAuth non proposé.

L'indicateur `isSelf: true` identifie le compte connecté. Le nombre de « coéquipiers partageant » exclut donc explicitement le compte connecté, même si son propre roster est partagé.

## Vérification ponctuelle de l'inventaire personnel

URL de diagnostic indépendante : `GET /login/inventory-test`.

Ce test demande uniquement les scopes OAuth `openid m3p.f.pr.pro m3p.f.pr.inv` (**View Inventory**). Il ne modifie ni `/login`, ni les tests de roster et d'alliance. Après échange du code OAuth, le Worker lance **un seul** `GET /player/v1/inventory?page=1&perPage=1` (sans filtre d'objets), avec les trois en-têtes officiels.

Il vérifie que l'API répond HTTP 200 et renvoie `data` sous forme de tableau. La page affiche un statut et le nombre d'objets retournés sur la première page (au plus un), jamais les IDs, noms ou quantités des objets. Elle ne stocke ni token, ni inventaire, ni données dérivées ; son résultat est non mis en cache et expire au rechargement.

La documentation officielle annonce aussi le filtre `itemType` (GEAR, ISOITEM, SHARD, RS, COSTUME, CONSUMABLE, ABILITY_MATERIAL). Ces catégories ne sont **pas** encore synchronisées par le test. L'endpoint est réservé au **joueur connecté** : il ne confère aucun accès aux inventaires des membres de l'alliance.

Référence : https://developer.marvelstrikeforce.com/beta/msf-api.json

## Test unique des profils de l'alliance

Route volontaire `GET /login/profiles-test`. Elle demande uniquement les droits existants `openid m3p.f.pr.pro m3p.f.ar.pro` ; les autres routes OAuth demeurent inchangées.

Après le consentement du compte responsable et l'échange OAuth côté Worker :

1. Lecture de `GET /player/v1/alliance/card` pour vérifier la fiche complète de l'alliance du compte connecté.
2. Lecture de `GET /player/v1/alliance/members` pour obtenir des identifiants de membres **temporaires**, jamais enregistrés.
3. Lecture initiale de `GET /player/v1/card/member/{memberId}` sur **un autre membre**. Si le premier accès est refusé, le test s'arrête (pas de balayage inutile).
4. Si ce premier accès réussit, audit des autres fiches avec **trois requêtes simultanées au plus**, maximum 24 fiches, arrêt des lots suivants sur HTTP 429 ou 401.

Le résultat affiche les classements de saison de **guerre** (`warRank`) et **raid** (`raidRank`), quelques statistiques globales autorisées et le nombre de fiches accessibles par champ. L'ancien événement World Warrior est volontairement ignoré. Les fiches détaillées, identifiants, tokens, descriptions libres et données brutes ne sont ni sauvegardés ni renvoyés au navigateur. Le résultat est non mis en cache et expire au rechargement.

Ceci est un **diagnostic ponctuel**, pas encore une synchronisation. Un premier succès n'est pas une garantie d'accès à toutes les fiches des alliances futures. La documentation officielle est disponible sur https://developer.marvelstrikeforce.com/beta/msf-api.json .

## Diagnostic ponctuel des types de champs PlayerCard

URL opt-in : `GET /login/card-types-test`.

Le diagnostic prolonge `/login/coverage-test` sans le relancer. OAuth serveur, PKCE S256, CSRF state et scopes déjà validés `openid m3p.f.pr.pro m3p.f.ar.pro` sont conservés.

Après le consentement, **deux GET Scopely maximum** :

1. `/player/v1/alliance/members` pour un identifiant temporaire valide dans l'alliance connectée.
2. `/player/v1/card/member/{memberId}` pour un seul coéquipier non-self ayant `card.rosterShare === true`.

La page affiche uniquement les types JSON de `rosterShare` et `aid`, le type du champ historique officiellement documenté `wwPoints` (exclu du périmètre LoSP), et un compteur de clés inconnues dont les noms restent masqués. Aucun pseudo, ID, token, nom de clé inconnue, valeur privée ou JSON brut ne passe dans le navigateur.

Le résultat est éphémère, `no-store`, CSP à nonce et neutralisation des paramètres OAuth dans l'historique. Aucune donnée persistée, aucune intégration R2, aucun accès au roster ni à l'inventaire. Les erreurs 401/403/429/464 sont affichées sans réponses API brutes et n'entraînent aucune nouvelle requête.

Tests : `tests/card-types-test.test.mjs`. La CI ne remplace pas un essai réel avec le consentement de Scopely.

## Vérification ponctuelle de la cohérence métier des statistiques

Route opt-in indépendante : `GET /login/metrics-test`. Elle réutilise exclusivement les scopes déjà employés par les tests d'alliance : `openid m3p.f.pr.pro m3p.f.ar.pro`.

Ce diagnostic ne cherche **pas** à certifier les statistiques uniquement à partir de leur type JSON. Après le consentement OAuth, il effectue **au plus trois GET Scopely successifs** :

1. `/player/v1/alliance/card` : TCP total, moyenne et effectif ;
2. `/player/v1/alliance/members` : cartes des membres et repérage de la ligne `isSelf` ;
3. `/player/v1/card` : fiche **personnelle du seul compte connecté**.

Le Worker calcule en mémoire la cohérence de l'effectif et du TCP total avec la liste, compare la moyenne avec l'effectif en acceptant uniquement le petit écart d'arrondi inhérent à une moyenne entière, puis compare les statistiques communes de **la propre carte** avec celles de sa fiche personnelle. Aucun profil détaillé des 23 autres joueurs n'est appelé.

La page temporaire affiche des verdicts de cohérence et, uniquement pour le compte connecté, une **liste fermée** de valeurs personnelles (`level`, `tcp`, `stp`, `warMvp`, `charactersCollected`, `daysInAlliance`, `latestArena`, `bestArena`, `latestBlitz`, `blitzWins`) afin que le responsable puisse les confronter à son profil MSF. Elle n'affiche ni pseudonyme, ni statistiques individuelles des coéquipiers, ni identifiant, ni token, ni JSON brut. Aucune valeur n'est persistée.

**Interprétation prudente** : `identique` prouve seulement la cohérence interne de deux réponses API. Un écart peut provenir de données mises à jour à des instants légèrement différents. La validité métier complète exige une comparaison volontaire avec les valeurs actuellement visibles dans MSF. Aucun critère métier arbitraire n'est inventé pour les classements Arène/Blitz, ni pour `warMvp`.

Le diagnostic conserve les protections CSRF state, PKCE, cookies `Secure; HttpOnly; SameSite=Lax`, CSP avec nonce, `no-store` et expiration au rechargement. Aucun stockage R2, refresh token ou nouvelle permission. Tests automatisés : `tests/metrics-test.test.mjs`. La CI ne vaut pas autorisation ni validation réelle de l'API.
