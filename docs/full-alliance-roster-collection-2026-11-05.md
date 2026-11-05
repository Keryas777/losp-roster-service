# Collecte complète des rosters d'alliance — 5 novembre 2026

## But
Une alliance approuvée doit être collectée en une seule invocation lorsque les réponses
Scopely et le budget technique de la plateforme le permettent. Les rosters exclus par
`rosterShare=false` ne sont jamais appelés. L'alliance, le membre OAuth et les
identifiants sont systématiquement revérifiés avant toute attestation.

## Déploiement
- `ROSTER_FULL_COLLECTION_ENABLED=true` est activé dans `wrangler.jsonc`.
- Sans variable supplémentaire, le collecteur donne **une alliance par minute**
  et jusqu'à **44 GET Scopely par invocation** : marge sous les 50 sous-requêtes
  externes Workers Free. Il ne s'agit **pas** d'un quota imposé par Scopely.
- Si le Worker est réellement sous **Workers Paid**, il est possible de fixer
  `ROSTER_FULL_COLLECTION_REQUEST_BUDGET` dans `wrangler.jsonc` à une
  valeur de 44 à 300, après vérification du compte et de l'usage mémoire.
  Sur Free, conserver la valeur par défaut. Ne pas activer 300 par hypothèse.
- Les campagnes utilisent toujours les Crons existants (02–04 et 14–16 UTC).
  Aucun nouveau Cron, secret, route publique ou permission Scopely.

## Collecte et reprise
- Le mode rapide demande jusqu'à 24 rosters de coéquipiers autorisés,
  à concurrence de trois GET de roster simultanés.
- Le moteur conserve en R2 chaque roster validé et son index stable.
- Si le budget est atteint avant la fin, seules les premières réponses complètes
  consécutives sont enregistrées. La liste d'alliance et les consentements
  sont revérifiés. On ne publie jamais un manifeste incomplet.
- Dès que tous les coéquipiers sont traités, le roster du capitaine OAuth
  est collecté **dans la même invocation**, s'il reste du budget.
  Sinon il sera finalisé au prochain passage.
- Une campagne AM inachevée se poursuit en PM sous le même runId, plutôt
  que de recommencer ses premiers membres. Une fois terminée, la campagne
  PM pourra démarrer sous un nouveau runId.
- Une campagne expirée (>7 jours) est relancée proprement au prochain
  passage automatique ; les traitements manuels restent explicites.
- Les campagnes terminées sont exclues de la sélection Cron du même créneau,
  pour ne pas voler des passages aux alliances encore en attente.
- Les erreurs réelles (401, 403, 429, réseau, consentement changé, 472)
  gardent les mêmes validations et diagnostics.

## Portée et limites
- Les endpoints Scopely demeurent individuels : `/player/v1/roster/member/{id}`
  et `/player/v1/roster`. Ce changement n'invente aucun endpoint "alliance CSV".
- Sur Workers Free, un roster très volumineux ou un grand nombre de réponses
  peut encore demander plus d'une invocation. Ce n'est pas une nouvelle
  limitation métier. La progression et les fichiers restent réutilisables.
- Les six alliances LoSP continuent d'utiliser leur pipeline de publication
  existant ; les invitées conservent leur R2 privé et ne sont pas publiées
  dans GitHub ni dans la WebApp sans contrôle d'accès séparé.
- Aucune requête à la production ou à Scopely n'a été lancée lors de la PR.
  Vérifier les tests CI, l'état du plan Cloudflare et les reçus R2 avant merge.
