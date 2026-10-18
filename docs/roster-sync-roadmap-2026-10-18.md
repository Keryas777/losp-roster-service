# Préparation de la synchronisation automatique des rosters LoSP

État de cette étape : **prévalidation et approbation privée uniquement**.
Le fait de fusionner cette PR ne déclenche **aucune collecte des personnages**.
Aucun cron supplémentaire, publication GitHub, écriture Google Sheets ou PID.

**Règle d'architecture absolue : le service ne pousse JAMAIS de données vers la WebApp ou son dépôt. Seule la WebApp initie la récupération par des requêtes GET de lecture.**

## Source de vérité et périmètre

- Les sessions Scopely OAuth existantes sont attachées aux comptes, **pas** aux alliances.
- Un scan frais de `/player/v1/alliance/card` et `/player/v1/alliance/members` est indispensable, en s'appuyant sur `scanPrivateCoverage`.
- Les alliances sont regroupées par le préfixe stable `aid`, **jamais** par le pseudo de l'alliance ni par le `member_version`.
- `/admin` (Cloudflare Access JWT authentifié) contient un panneau d'approbation. Un opérateur choisit explicitement les alliances LoSP **à partir des alliances effectivement observées**, sans nom d'alliance codé en dur.
- Les décisions sont sauvegardées uniquement dans R2 privé `roster-sync/v1/approved-alliances.json`, au format `{version,approvedAt,alliances:[{fingerprint,name}]}`. Ce registre ne contient ni token ni roster ni nom de membre.
- Une couverture partielle (session indisponible, API interdite, effectif incohérent, énumération tronquée) empêche l'enregistrement d'une nouvelle sélection.
- Les approbations sont remplacées uniquement lors d'une action explicite. Une future collecte **devra** vérifier à nouveau les `aid` et l'appartenance courante des sessions avant toute lecture, et arrêter lorsque l'alliance n'est plus approuvée ou plus joignable.

## Pourquoi cette étape précède la collecte

L'accès OAuth à une alliance peut être valide même si le compte connecté a changé d'alliance ; il ne prouve pas la gestion LoSP. Les approbations ne sont **pas** des autorisations de consulter des rosters non partagés. Elles désignent seulement les alliances autorisées par l'administrateur à entrer dans le futur pipeline.

Pour un membre ordinaire, la route officielle `/player/v1/roster/member/{memberId}` exige son appartenance actuelle et `card.rosterShare===true`. Les `memberId` sont temporaires : ils doivent être relus avant chaque lot.

Le roster du compte OAuth lui-même **n'est pas un roster de coéquipier**. Son éventuelle collecte devra employer `/player/v1/roster`, avec vérification du scope personnel, et sans supposer que `rosterShare` suffit.

La limite interne existante `MAX_REQUESTS=35` et le plafond de pagination du collecteur imposent un traitement par lots sous budget Workers/Scopely, avec relecture des effectifs à chaque lot et gestion de `429` sans réessais agressifs. Il faut valider les structures officielles, les quotas et les formats d'ISO-8 et étoiles avant transformation.

## Suite de développement (non activée ici)

1. **Pilote privé** : collecter de manière explicitement déclenchée un seul roster complet, tester les pages et autorisations en production, sans exposition publique.
2. **Stockage privé** : snapshots horodatés et isolés par alliance et lot, expiration stricte (maximum 30 jours) y compris règle de purge R2, idempotence et suppression lorsqu'un consentement est retiré. Ne jamais indexer l'historique sur les seuls pseudo ou `memberId`.
3. **Orchestration des cinq alliances** : une collecte logique indépendante par alliance, découpée en micro-lots de **1 à 3 joueurs selon la pagination et le budget d'appels réel** (et non un unique lot de 24). Réévaluer à chaque lot l'alliance approuvée, les membres courants et les droits de partage ; sauvegarder les checkpoints privés, contrôler les changements de version d'effectif et dédupliquer plusieurs sessions OAuth. Un roster n'est validé qu'une fois toutes ses pages reçues. Ne jamais promouvoir une alliance partiellement collectée.
4. **Validation métier** : comparer les snapshots à un export CSV officiel de référence ; vérifier les évolutions `power`, `gear`, étoiles rouges/diamants et ISO orange avant toute conversion.
5. **Exposition en lecture seule — pull exclusivement** : LoSP Roster Service met à disposition un manifeste de versions par alliance et des ressources HTTP GET de lecture, après validation d'un snapshot complet. La **WebApp LoSP interroge elle-même ces endpoints**, télécharge les données nécessaires et les exploite localement selon son architecture statique. Le Worker ne déclenche aucun webhook vers la WebApp, aucune GitHub Action du dépôt `Keryas777/msf`, aucun commit, aucun upload et aucune écriture dans `rosters_<alliance>.json` ou `rosters.json`. Toute conversion / mise en cache côté WebApp lui appartient exclusivement et ne doit pas être un effet de la collecte.
6. **Registre PID** : Google Sheets reste la source des PID saisis manuellement. Ne jamais modifier sa colonne C et ne jamais rattacher automatiquement un historique sur un pseudo ambigu.

## Contrat de récupération par la WebApp — non implémenté

- LoSP Roster Service possède les données officielles collectées et les snapshots privés R2. Une promotion **atomique par alliance** rend visible uniquement la dernière version complète et contrôlée ; les lots intermédiaires restent inaccessibles à la WebApp.
- La WebApp est **l'unique initiatrice** de chaque lecture. Proposition de contrat : `GET /api/rosters/manifest` (versions et état par alliance), puis `GET /api/rosters/{allianceKey}?version=...&page=...` (lecture paginée). Ce sont des noms d'API **proposés**, pas des routes existantes.
- Le découpage côté récupération (par alliance et pages bornées) est indépendant du découpage de collecte Scopely en petits lots de joueurs. La WebApp peut ne relire que les versions modifiées ; version/ETag et gestion de cache doivent être spécifiés et testés.
- Le Worker ne connaît pas l'URL de la WebApp pour transmettre ses données. Il ne stocke aucun token d'écriture GitHub et n'effectue aucune opération sur le dépôt WebApp.
- Les rosters sont des données de joueurs : valider le mode d'accès aux GET avant exposition. Un site GitHub Pages public **ne doit jamais embarquer de secret** ; les réponses privées doivent être protégées par une authentification adaptée et des CORS limités à l'origine autorisée. Une origine CORS n'est pas une authentification. L'accès public n'est possible que si sa publication est explicitement autorisée.
- En cas d'échec ou de permission retirée, aucune donnée partielle n'est diffusée ; la révocation et l'expiration maximale de 30 jours s'appliquent aussi aux données précédemment collectées. L'âge du dernier snapshot validé est visible dans le manifeste.

## Consultation

Dans `/admin`, cliquer sur « Vérifier les alliances connectées », sélectionner uniquement les cinq alliances actives reconnues et cliquer sur « Enregistrer les alliances approuvées ». Vérifier que l'effectif et les partages sont cohérents. Cette action **ne télécharge aucun roster**.

Tant que le pilote de collecte n'est pas implémenté et validé, l'état restera `canCollectAutomatically=false`. Le registre peut être ajusté manuellement par un administrateur après nouveau recensement.

Aucun paramètre de production secret n'est enregistré dans le dépôt.
