# MSF /game/v1 — récupération ciblée des 472 et qualification des 404

Date : 20 octobre 2026. Référence : [OpenAPI Scopely beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json).

## Résultat du diagnostic de la PR #63 (captures réelles)

À 09 h 27, l'admin R2 indiquait **156 lacunes distinctes** :

- 88 HTTP 472 : 87 `characters`, 1 `upgradeData` ;
- 68 HTTP 404 : 64 `items`, 3 `episodics`, 1 `events`.

Les exemples photographiés dans `items` sont des requêtes
`/game/v1/items/{id}/characters?charInfo=full`. L'API documente
cette route comme la liste des **personnages qui utilisent un objet**.
Sa réponse 404 ne prouve pas que la fiche `/items/{id}` est absente.
L'archive de la fiche et le constat de l'association sont distincts.

Ces 156 signalements sont des résultats historiques R2 réels, pas
une inspection exhaustive des reçus R2. Ils ne prouvent ni que
toutes les données de base ont été perdues ni que les alternatives
sont intégrales.

## Récupération automatique sans nouveau run

Drapeau `GAME_ARCHIVE_RECOVERY_ENABLED=true` dans Wrangler.

Au déclenchement Cron normal :
1. Si la campagne R2 est terminée et n'a pas encore de marqueur
   `recovery`, elle se réactive **avec le même runId**, sans effacer
   `progress.json`, ni les reçus ni les JSON déjà archivés ;
2. Le Worker parcourt jusqu'à **8 signalements existants par tick**,
   et reconnaît uniquement les GET `/game/v1/characters/{characterId}`
   refusés avec HTTP 472 (pas de chemin player ni de character array) ;
3. Il ajoute les variantes plus petites à **la file R2 actuelle** ;
   les GET restent limités à **6 par tick**, le quota quotidien
   et le verrou commun restent inchangés ;
4. Chaque JSON 200 est archivé dans les objets immuables existants
   avec un reçu qui cite sa requête originelle et son segment ;
5. L'échec initial demeure dans `gaps`, mais `recovery.records`
   suit le nombre de segments programmés, archivés et refusés.

Pour un détail supplémentaire refusé, des variantes indépendantes
sont demandées pour : `abilityKits=full`, `costumes=full`,
`gearTiers=full` et coûts `pieceDirectCost=full`,
`pieceFlatCost=full` ; les autres grandes sections sont à `none`.
Si `abilityKits=full` est encore refusé, les quatre types
officiels `basic`, `special`, `ultimate`, `passive` sont
essayés individuellement, **sans boucle récursive**.

Ces réponses ne sont **pas fusionnées artificiellement** :
les champs imbriqués et la sémantique d'un GET complet ne sont pas
garantis identiques à l'assemblage de plusieurs GET. Le rapport
parle donc de **« variantes archivées »**, et non de « fiche complète
récupérée ».

Les refus 472 sur `upgradeData` restent traités par le repli vers
les 12 endpoints officiels déjà livré dans la PR #62.
Les 404 `episodics` et `events` restent explicitement ouverts
tant que leurs chemins exacts et éventuelles alternatives ne sont
pas vérifiés.

## Audit des 404 item/characters

Les signalements passés ou futurs des chemins
`/game/v1/items/{id}/characters` avec 404 sont ventilés dans une
**catégorie dédiée « association objet/personnage indisponible »**.

Cette qualification ne prétend pas que la source `/items/{id}` a
été individuellement revérifiée : seule la route d'association
a échoué. Les autres 404 demeurent des ressources à investiguer.
L'affichage n'efface aucun des signalements cumulatifs.

## Confidentialité, consommation et limites

Le rapport admin continue à lire seulement `active.json` et
`progress.json`, sans appels supplémentaires, suppression ni
publication R2. Le collecteur n'emploie que le jeton applicatif
Scopely existant pour des GET `/game/v1`.
Aucun accès aux données joueurs ni modification des rosters,
de leur calendrier, des quotas ou de GitHub Pages.

Les nombreux petits GET de récupération peuvent prolonger la
campagne. Si Scopely refuse même les segments individuels, le
motif d'échec est conservé pour une nouvelle investigation.
Aucune variante ne garantit un HTTP 200 ni l'exhaustivité globale.
