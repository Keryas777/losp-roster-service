# LoSP Roster Service

Service indépendant de `Keryas777/msf` pour les rosters autorisés de Marvel Strike Force et la progression des Dimensions Noires.

## État du projet

- Worker Cloudflare en JavaScript vanilla, déployé automatiquement depuis `main`.
- `GET /health` : état du service (version 0.1.2 inchangée).
- `/`, `/privacy.html` et `/tos.html` : pages publiques.
- `GET /login` : **phase OAuth 1 uniquement**. Construit une redirection officielle Scopely (`authorization_code`, `state` aléatoire et PKCE S256) en utilisant `SCOPELY_CLIENT_ID` au runtime.
- **`/oauth/callback` n'est pas encore implémenté.** Ne lancez pas d'authentification de compte en production pour l'instant : le consentement ne peut pas se terminer et le callback répond 404. Aucun code OAuth n'est échangé et aucun token n'est stocké.

## OAuth — configuration

Le seul domaine autorisé au démarrage est `https://losp-roster-service.deliriousfan7.workers.dev` et le callback enregistré chez Scopely est `/oauth/callback`.

Variables secrètes Cloudflare **Runtime / Production** :

- `SCOPELY_CLIENT_ID` : utilisé uniquement côté Worker par `/login`.
- `SCOPELY_CLIENT_SECRET` : conservé pour la prochaine phase ; jamais utilisé ou transmis par `/login`.

Les deux cookies temporaires `__Host-losp_oauth_state` et `__Host-losp_oauth_verifier` sont `Secure`, `HttpOnly`, `SameSite=Lax`, avec une expiration de 10 minutes et sans attribut `Domain`. Ils serviront à valider le callback dans une étape ultérieure. Aucun token ne passe dans ces cookies.

Les scopes minimaux demandés à ce stade sont `openid m3p.f.pr.pro`. L'accès aux rosters, à l'alliance et la persistance seront introduits uniquement après validation de l'implémentation sécurisée.

## Tests

Tests de développement sans dépendance applicative, avec Node.js 22+ uniquement comme outil de test local (le Worker ne dépend pas de Node.js en production) :

```sh
node --test tests/login.test.mjs
```

Aucun appel réel à Scopely n'est exécuté par les tests. Ne jamais committer de secret, de jeton ou de données privées Scopely.
