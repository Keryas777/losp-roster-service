# Administration exhaustive des données API MSF — phase 1

## Objectif

Interface privée `/admin` pour inspecter les données réellement **renvoyées** par les requêtes en lecture seule vers Scopely. Deux présentations coexistent : des tableaux de champs (y compris pour les membres et les personnages), et la réponse JSON **intégrale** conservant tous les champs connus ou inconnus, objets imbriqués et `meta`. Le parcours est mobile first, HTML/CSS/JavaScript vanilla et compatible avec le Worker GitHub existant.

Ce n'est **pas encore** une synchronisation complète des rosters de cinq alliances. Le tableau affiche les réponses en direct, une page à la fois. Il n'écrit aucun résultat de jeu dans R2, aucun fichier de données GitHub Pages ni aucun historique. Les jetons OAuth restent chiffrés dans le coffre R2 existant.

## Sécurité absolue — inactif par défaut

- Le panneau est **désactivé** tant que `MSF_ADMIN_ENABLED=true` n'est pas configuré dans Cloudflare et que les valeurs `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `MSF_ADMIN_EMAILS` ne sont pas présentes.
- Chaque visite de `/admin` **et chaque** requête `/admin/api/*` vérifie cryptographiquement la signature RS256 du JWT Cloudflare Access (clé publique JWKS officielle, émetteur, audience, expiration, date de début et e-mail explicitement autorisé). Aucun `Cf-Access-Authenticated-User-Email` non signé, cookie capitaine ou paramètre URL n'accorde les droits administrateur.
- **Prérequis obligatoire :** configurer une application Cloudflare Zero Trust Access couvrant `/admin` et `/admin/*`, avec MFA et une politique Include limitée à l'administrateur. Une politique Access seule ne dispense pas de la vérification serveur.
- `CF_ACCESS_TEAM_DOMAIN` : nom d'équipe complet sous la forme `xxxx.cloudflareaccess.com` ; `CF_ACCESS_AUD` : identifiant AUD de cette application Access ; `MSF_ADMIN_EMAILS` : e-mail(s) administrateur(s) séparés par une virgule. Saisir les secrets dans Cloudflare, **jamais dans GitHub** ni ChatGPT. Le drapeau `MSF_ADMIN_ENABLED` doit rester `false` jusqu'aux tests.
- Les valeurs `MSF_ADMIN_EMAILS` et `CF_ACCESS_AUD` peuvent être stockées comme secrets Cloudflare afin de limiter toute exposition ; l'email n'est jamais renvoyé par l'API.
- Seules des routes GET explicitement listées dans `src/admin-data-api.js` peuvent être appelées. Aucune requête arbitraire, aucun jeton OAuth ou `refresh_token` n'est renvoyé au navigateur.
- Les objets R2 `oauth-captains/v1/` restent privés et chiffrés. L'énumération de comptes par /admin est paginée (10 sessions par page) ; l'administrateur peut consulter le profil/nom de l'alliance actuelle de chaque compte connecté.
- Pour `alliance-roster`, le Worker relit la liste d'alliance via le jeton du compte et n'autorise **que** un `memberId` de l'alliance actuelle avec `rosterShare===true`, à condition de trouver exactement un `isSelf===true`. Un transfert ou retrait de partage bloque la consultation.
- Les réponses API ont `Cache-Control: private, no-store`, sont limitées en taille et rendues avec `textContent` afin d'éviter les injections HTML. Les téléchargements JSON explicites à la demande sont enregistrés **sur l'appareil de l'administrateur** : ne pas les partager sans autorisation.
- Toutes les données disponibles ne sont pas nécessairement exposées par l'API. Scopely peut refuser certaines routes, modifier ses schémas, omettre un champ ou appliquer une pagination. Il faut rendre ces indisponibilités visibles, pas fabriquer des données.

## Rubriques accessibles dans le premier catalogue

Profil joueur, roster personnel paginé, inventaire personnel paginé, liste de souhaits, équipes enregistrées, événements/progression, profil d'alliance, tableau des membres, roster partagé d'un membre, et données générales du jeu (catalogues de personnages, traits, ISO-8, raid definitions, objets, fiches personnages, etc.). Les fiches détaillées ne sont disponibles que si l'identifiant demandé correspond à un endpoint officiel.

Le module ne couvre **pas encore toutes les 57 routes GET** du schéma public, notamment celles avec plusieurs paramètres complexes ou nécessitant des recherches d'identifiants complémentaires. `CAPTAIN_SCOPES` accordés ne signifient pas que chaque route pourra être lue sans 403/404. Le catalogue actuel se développe progressivement sans endpoint en écriture.

## Plan d'activation

1. Attendre et vérifier le premier renouvellement automatique réel de Scopely ; ne pas compromettre les connexions enregistrées.
2. Configurer l'application Access avec règle limitée à l'administrateur et MFA. Confirmer qu'une session sans login Access ne peut pas visiter `/admin`.
3. Configurer dans Cloudflare les secrets ci-dessus ; confirmer le déploiement via GitHub `wrangler.jsonc` et s'assurer qu'aucune nouvelle variable de contrôle n'est perdue au prochain déploiement.
4. Activer `MSF_ADMIN_ENABLED=true` **uniquement après** validation des règles et autorisations ; synchroniser le drapeau non secret avec Wrangler via PR.
5. Vérifier avec un compte Access admin : liste de sessions (Keryas I-IV), chaque alliance actuelle, membres/rosters explicitement partagés, tous les champs JSON et leurs métadonnées, pagination et contrôle des droits.
6. Vérifier avec un compte non autorisé et sans Access que toutes les routes `/admin/api/*` renvoient un refus. Ne jamais présenter de capture de jeton ni copier les inventaires personnels dans un fil public.
7. Phase suivante : registre privé des alliances LoSP et des comptes habilités, collecte complète paginée à consentement contrôlé, contrôle des duplications/changements d'alliance, conservation des snapshots (≤30 jours) et intégration maîtrisée aux pipelines CSV `Keryas777/msf`.

## Documentation API officielle

https://developer.marvelstrikeforce.com/beta/msf-api.json
