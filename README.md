# LoSP Roster Service

Service indépendant de `Keryas777/msf` pour les rosters autorisés de Marvel Strike Force et la progression des Dimensions Noires.

## État du projet

- Worker Cloudflare en JavaScript vanilla, déployé automatiquement depuis `main`.
- `GET /health` : état du service (version 0.1.2 inchangée).
- `/`, `/privacy.html` et `/tos.html` : pages publiques.
- `GET /login` : **phase OAuth 1**. Construit une redirection officielle Scopely (`authorization_code`, `state` aléatoire et PKCE S256) en utilisant `SCOPELY_CLIENT_ID` au runtime.
- `GET /oauth/callback` : **phase OAuth 2 — validation éphémère**. Vérifie `state` et PKCE, échange le code uniquement côté Worker (Client ID + Client Secret en HTTP Basic) puis supprime les cookies temporaires. **Les tokens ne sont ni enregistrés, ni renvoyés au navigateur.** Le compte n'est donc PAS encore connecté durablement.
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
