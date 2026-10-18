# Préparation de la synchronisation automatique des rosters LoSP

État de cette étape : **prévalidation et approbation privée uniquement**.
Le fait de fusionner cette PR ne déclenche **aucune collecte des personnages**.
Aucun cron supplémentaire, publication GitHub, écriture Google Sheets ou PID.

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
3. **Orchestration des cinq alliances** : réévaluer les alliés approuvés, répartir les appels dans des lots bornés, sauvegarder les checkpoints vérifiables et ignorer toute transition de version d'effectif non revalidée. Plusieurs sessions de la même alliance ne doivent pas produire de doublons. Les erreurs partielles ne sont pas publiées.
4. **Validation métier** : comparer les snapshots à un export CSV officiel de référence ; vérifier les évolutions `power`, `gear`, étoiles rouges/diamants et ISO orange avant toute conversion.
5. **Publication distincte** : alimenter les sources de `Keryas777/msf/docs/data/rosters_<alliance>.json` via un mécanisme autorisé, revoir `scripts/merge-rosters.mjs`, contrôler les CI, puis seulement permettre la promotion. Aucune écriture directe dans `docs/data/rosters.json` depuis le Worker.
6. **Registre PID** : Google Sheets reste la source des PID saisis manuellement. Ne jamais modifier sa colonne C et ne jamais rattacher automatiquement un historique sur un pseudo ambigu.

## Consultation

Dans `/admin`, cliquer sur « Vérifier les alliances connectées », sélectionner uniquement les cinq alliances actives reconnues et cliquer sur « Enregistrer les alliances approuvées ». Vérifier que l'effectif et les partages sont cohérents. Cette action **ne télécharge aucun roster**.

Tant que le pilote de collecte n'est pas implémenté et validé, l'état restera `canCollectAutomatically=false`. Le registre peut être ajusté manuellement par un administrateur après nouveau recensement.

Aucun paramètre de production secret n'est enregistré dans le dépôt.
