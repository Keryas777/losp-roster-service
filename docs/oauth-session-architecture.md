# Architecture des connexions Scopely — décision de phase 4

État : **fondation implémentée, stockage en production NON ACTIVÉ**. Le callback existant doit rester éphémère jusqu'à validation des points ci-dessous.

## Choix retenu

Utiliser **Cloudflare R2 privé** pour les tokens OAuth chiffrés (AES-GCM, 256 bits), avec une clé conservée exclusivement dans un secret Runtime Cloudflare. D1 n'est pas retenu pour les secrets : Time Travel permet de restaurer des valeurs supprimées. R2 a une suppression fortement cohérente via le binding Worker ; cela ne garantit pas un effacement physique instantané dans toute l'infrastructure Cloudflare.

Aucun nom, identifiant de joueur, secret ou token n'apparaît dans les clés d'objet : uniquement `oauth-sessions/v1/` + SHA-256 d'un identifiant de session aléatoire. Le jeton de session à 256 bits n'est jamais enregistré en clair dans R2 et ne doit jamais apparaître dans l'URL. Chaque objet chiffré comporte une IV AES-GCM aléatoire unique et utilise sa clé d'objet comme données associées authentifiées.

Le module `src/session-vault.js` offre `saveSession`, `readSession`, `deleteSession`, `purgeExpiredSessions` et `generateSessionId`. **Il n'est pas importé par le Worker.** Aucun token réel n'est donc enregistré aujourd'hui.

## Mise en service : prérequis bloquants

1. Créer un bucket privé R2 dédié, proposé : `losp-roster-sessions`, sans domaine public ni accès R2.dev. Ne pas y mélanger les snapshots de roster.
2. Configurer sur ce bucket une règle de cycle de vie **supprimant après 1 jour**, comme filet de sécurité ; la suppression peut avoir un délai et ne remplace jamais la vérification applicative de l'expiration. Vérifier aussi la politique de conservation et tout mécanisme de sauvegarde.
3. Configurer une liaison R2 pour le Worker, `SESSION_BUCKET` → `losp-roster-sessions`, **après** création du bucket. Ne pas ajouter de binding inexistant dans `wrangler.jsonc` : cela casserait le déploiement automatique.
4. Créer dans `Runtime variables and secrets / Production` un secret `SESSION_ENCRYPTION_KEY_HEX`, de 32 octets aléatoires représentés par 64 chiffres hexadécimaux, généré localement de façon sûre ; ne jamais copier sa valeur dans GitHub, cette documentation ou une conversation.
5. Définir une cookie de session hôte unique `__Host-losp_session` : `Secure; HttpOnly; Path=/; SameSite=Lax` avec expiration `<=` à celle du token. Cookies OAuth actuels conservés. Au nouveau login, révoquer l'ancienne session avant de délivrer la nouvelle. Ne jamais afficher l'identifiant de session, ni dans des journaux ni dans l'URL.
6. Ajouter une route `POST /logout` qui vérifie l'origine et se protège des CSRF : la demande utilise la session hôte et supprime l'objet R2 avant de supprimer son cookie ; prévoir un retour sûr et des erreurs fermées. Une route `GET /session` ne doit exposer qu'un état général, jamais un token ou une donnée privée en clair sans autorisation.
7. Ajouter un `scheduled()` (cron) de purge ; prévoir le nettoyage de toutes les sessions expirées et des sessions révoquées. Les réponses doivent systématiquement être `Cache-Control: no-store`.
8. Confirmer la prise en compte des retraits d'autorisation depuis le **tableau de bord Scopely** (webhook, interrogation de l'API, ou erreur de consentement au prochain appel). La suppression doit être immédiate dès notification ou demande locale ; jusqu'à cette garantie, **ne pas considérer les connexions persistantes comme aptes à la production**.
9. Exercer les tests : authentification initiale, rechargement, expiration, logout, suppression R2, absence de clé, contenu chiffré corrompu, session volée/forgée, révocation chez Scopely, double login, réinitialisation de Worker et erreur R2.

## Limites actuelles

- **Aucun `offline` demandé**, donc aucun refresh token à sauvegarder. Un access token expiré implique une nouvelle autorisation OAuth ; cela ne permet pas encore de synchroniser les rosters automatiquement.
- La rotation des refresh tokens Scopely est à usage unique : avant d'activer `offline`, prévoir un coordonnateur de renouvellement sérialisé par connexion (ex. Durable Object) et étudier l'endpoint officiel `gatedRefresh`. La simple mise à jour concurrente d'un objet R2 ne suffit pas.
- Pour la gestion multi-alliances, il faut un mécanisme d'indexation par identité joueur et d'appartenance à l'alliance qui permette la purge ciblée **de toutes les sessions et données dérivées**, même après changement de pseudo ou d'alliance. Aucun identifiant durable n'a encore été validé dans le code.
- Le TTL de prototype du coffre est **24 h maximum**. Les futures données de roster devront avoir un TTL contractuel individuel (30 jours max depuis collecte) ; il ne faudra jamais prolonger un ancien snapshot par une simple lecture.
- La politique de confidentialité devra être actualisée avant d'activer un stockage réel ; aucune donnée API ne doit être déversée dans des JSON publics, des logs, des caches PWA ou des backups non maîtrisés.
- **La suppression R2 rend les objets immédiatement inaccessibles via les accès directs au stockage**, selon la documentation ; il ne faut pas promettre un effacement physique instantané ou une conformité juridique automatique sans analyse supplémentaire.

## Pourquoi ce découpage ?

Le test validé aujourd'hui (OAuth → `/player/v1/card` → affichage temporaire) **ne doit pas régresser**. Ce commit livre uniquement la brique testable d'un coffre avec chiffrement, expiration et effacement. La liaison R2, les routes persistantes et le scope `offline` ne seront introduits que lorsque les prérequis sont satisfaits.

## Références

- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/get-started/workers-api/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://developer.marvelstrikeforce.com/beta/index.html
