# Architecture des connexions Scopely — capitaines LoSP

Statut au 17 octobre 2026 : **code préparé dans la PR #27, connexion durable DÉSACTIVÉE tant que Cloudflare R2 n'est pas configuré et testé en réel**. Aucun capitaine ne doit être invité tant que les prérequis et vérifications ne sont pas terminés.

## Séparation des deux coffres

- `src/session-vault.js` : prototype historique AES-256-GCM limité à 24 heures, **non branché**. Le conserver tel quel ; ne pas lui injecter de refresh token.
- `src/captain-vault.js` : coffre distinct AES-256-GCM pour les autorisations OAuth longue durée. Un objet R2 par session sous `oauth-captains/v1/` + SHA-256 d'un cookie aléatoire de 256 bits. Aucun nom, pseudo, identifiant de joueur, secret ou token ne figure dans la clé d'objet. IV unique aléatoire de 96 bits, authentification du nom d'objet comme AAD.
- `src/captain-refresh-coordinator.js` : un Durable Object par clé R2. Une file asynchrone par instance empêche les rafraîchissements concurrents d'un même jeton à usage unique. Ni la file ni le DO ne conservent les jetons durablement hors de R2.
- `src/captain-session-routes.js` : routes navigateur, cookie, accès répété aux rosters et renouvellement horaire.

La durée maximale d'un objet capitaine est de 365 jours, **glissante uniquement lors d'une rotation réussie**. Le cookie navigateur sécurisé `__Host-losp_captain_session` contient uniquement un identifiant aléatoire et a un délai de **180 jours glissants**. Chaque visite du capitaine qui confirme une session active via `/session`, `/captain`, `/captain/rosters` ou `/login/captain` prolonge ce délai de 180 jours. Les erreurs temporaires ou les jetons révoqués ne prolongent pas le cookie. **180 jours sans visite**, une suppression des cookies, la navigation privée ou le passage à un autre navigateur peuvent encore imposer une authentification Scopely : un objet R2 ne peut pas identifier sans preuve un nouveau navigateur. Il ne faut pas promettre l'absence permanente de reconnexion : Scopely peut révoquer ou invalider les refresh tokens.

## Préparation Cloudflare obligatoire (ordre strict)

1. **Bucket privé R2 existant validé le 17 octobre 2026 :** `losp-roster-sessions` (0 objet lors de la vérification). Une règle `captain-tokens-365d` activée ne cible que le préfixe `oauth-captains/v1/` et supprime après 365 jours. Le prototype 24 h (`oauth-sessions/v1/`) est séparé par préfixe. Vérifier aussi que ce bucket n'a **aucun** domaine public ni accès R2.dev. La règle est un filet de sécurité : l'expiration doit également être appliquée par le Worker.
2. La PR de liaison R2 ajoute au `wrangler.jsonc` :
   ```json
   "r2_buckets": [
     { "binding": "CAPTAIN_BUCKET", "bucket_name": "losp-roster-sessions" }
   ]
   ```
   Cette liaison concerne le bucket préexistant, vérifié dans Cloudflare ; elle ne crée aucun bucket et ne requiert pas de jeton R2 dans GitHub. **Elle n'active pas la persistance** tant que le secret et la variable `CAPTAIN_SESSIONS_ENABLED` n'ont pas été configurés.
3. Configurer un secret de production Cloudflare `CAPTAIN_ENCRYPTION_KEY_HEX`, avec exactement **64 caractères hexadécimaux aléatoires** (32 octets, 256 bits). Générer le secret localement avec un CSPRNG fiable (par exemple `openssl rand -hex 32`) ; ne **jamais** envoyer la valeur par ChatGPT, Discord, GitHub, logs ou commits. Garder une sauvegarde sécurisée hors R2 : perdre cette clé signifie perdre les autorisations, et une mauvaise rotation rend les objets illisibles.
4. La PR #27 ajoute seulement la liaison Durable Object `CAPTAIN_REFRESH_COORDINATOR`, sa migration SQLite et un cron horaire `15 * * * *`. Vérifier après déploiement que la migration est exécutée et que le binding existe. Le cron n'effectue aucune lecture privée quand le stockage n'est pas activé.
5. Ajouter enfin la variable runtime **de production** `CAPTAIN_SESSIONS_ENABLED=true` après la validation du binding et du secret. Sa valeur par défaut est désactivée. Une variable absente, une mauvaise clé ou un binding manquant bloquent la persistance ; si la variable est activée sans configuration complète, `/login/captain` répond HTTP 503 **avant** de demander le code Scopely.
6. Sur le compte pilote Keryas I uniquement, ouvrir `/login/captain`, accorder les droits, vérifier que `offline` et `m3p.f.ar.ros` ont été accordés, et que Scopely transmet réellement `refresh_token` et `expires_in`. Sans ces deux dernières informations, la page annonce explicitement l'absence de session durable.
7. Vérifier `GET /session` (retourne uniquement connecté/déconnecté), `GET /captain`, `GET /captain/rosters`, le retour par `/login/captain` **sans nouvel e-mail**, le renouvellement à expiration (en test), puis `POST /logout` avec Origin valide. Tester aussi la révocation dans l'interface Scopely et l'absence de récupération de rosters après retrait.
8. Avant d'inviter les autres capitaines, confirmer la politique Scopely en cas de révocation depuis le compte, la stratégie de purge ciblée multi-session, la récupération après panne ou refresh token consommé sans écriture R2, et vérifier que la rotation fonctionne réellement de bout en bout.

## Comportements et protections

- `/login`, `/login/rosters`, les diagnostics précédents et la web-app GitHub Pages restent inchangés. **Seule** la route `/login/captain` peut créer une session durable, lorsque la fonctionnalité est explicitement activée.
- La demande OAuth utilise HTTPS, PKCE S256, état CSRF lié à des cookies host-only de 10 minutes. `offline` seul n'active rien sans `CAPTAIN_BUCKET`, `CAPTAIN_ENCRYPTION_KEY_HEX` et le coordinateur.
- Le callback n'enregistre rien si `offline`, l'accès aux rosters d'alliance, le refresh token, la durée de vie du token ou un stockage sain manquent. Il présente un état explicite au navigateur. Les autres scopes restent auditables mais ne déclenchent pas d'accès automatique aux données personnelles.
- Les jetons OAuth ne sont jamais conservés dans le cookie, les URLs, les fichiers publics, le localStorage ou les journaux. Seuls les objets R2 contiennent les jetons **chiffrés**. Le DO peut les lire en mémoire côté serveur pour la rotation, jamais depuis une route publique.
- `GET /captain/rosters` réutilise un jeton serveur valide pour afficher temporairement les **trois premiers** rosters de coéquipiers qui partagent leur roster ; les images et détails sont livrés uniquement au navigateur autorisé, avec `no-store`. Aucune synchronisation globale, sauvegarde de rosters ou JSON public n'est activée. **À chaque consultation, la liste des membres est rechargée depuis Scopely avec le jeton du capitaine, jamais depuis une alliance mise en cache.** Elle doit contenir exactement un membre `isSelf === true` ; en l'absence de cette preuve, aucun roster n'est lu. Si le capitaine change d'alliance, la session OAuth reste liée à son compte MSF et les données consultées sont celles de sa nouvelle alliance. Le code ne conserve aucun ancien identifiant d'alliance ou roster en R2. Une page précédemment affichée dans le navigateur ne peut toutefois pas être effacée rétroactivement ; elle reste éphémère et sans cache.
- `GET /session` ne révèle ni identité, ni jeton, ni données de joueur. `POST /logout` exige l'origine exacte et supprime l'objet R2, puis tente sa révocation chez Scopely ; il n'affirme pas la révocation distante en cas d'erreur réseau.
- Le cron horaire liste uniquement les objets du coffre capitaine (borné à huit pages de cent clés). Il renouvelle les jetons proches de leur expiration, sans jamais récupérer d'inventaire, de raid, de guerre ou de roster. Une erreur temporaire retarde le renouvellement ; `invalid_grant` retire localement la session. Les rotations parallèles du **même** jeton sont sérialisées.
- Erreurs de clé/chiffrement : lecture fermée et aucune suppression aveugle des objets illisibles. La suppression R2 retire l'accès logique via ce bucket mais ne prouve pas l'effacement physique instantané chez le fournisseur.
- Les règles de conservation des données de jeu et les tokens OAuth sont distinctes : toute future copie de roster doit avoir son propre TTL de **30 jours maximum** à compter de sa collecte. Ne pas proroger un ancien snapshot par simple lecture.
- **Limite à lever avant exploitation complète multi-alliances** : l'identification durable, la révocation administrative ciblée de toutes les sessions d'un compte, et le comportement de Scopely lors d'une rotation perdue entre l'acceptation réseau et l'écriture chiffrée R2 ne sont pas garantis par un simple test CI. **Le droit OAuth est attaché au compte Scopely ; la responsabilité d'une alliance LoSP est une autorisation métier distincte.** Il reste à mettre en place un registre privé dynamique (pas de liste d'alliances hardcodée) permettant de contrôler qu'un capitaine est toujours responsable d'une alliance autorisée, notamment lorsqu'il passe à une alliance extérieure à LoSP. Sans cette étape, le pilote lit uniquement l'alliance actuelle accessible via Scopely, et ne doit pas devenir un mécanisme de publication automatique vers LoSP. Le code reste un pilote jusqu'à validation.

## Sources

- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/r2/get-started/workers-api/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developer.marvelstrikeforce.com/beta/index.html
