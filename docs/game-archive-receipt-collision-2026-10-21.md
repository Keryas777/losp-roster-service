# Audit R2 du 21 octobre 2026 — Collisions de reçus, correctif ciblé

## Faits observés en production

Le collecteur `/admin/api/game-archive` annonce sur la campagne
`ced5b23f-504c-428b-9ca8-02171f2a21ef` :

- `completed-with-gaps`, `cursor=8748`, `totalTasks=8748` ;
- `archivedResponses=7428` (nombre d'écritures réussies **comptabilisées**,
  non pas nombre garanti d'objets R2 distincts encore récupérables) ;
- `gapCount=1509`.

L'audit V2 après la fin de la collecte, démarré le
`2026-10-21T12:56:17.892Z` et terminé le
`2026-10-21T13:12:18.199Z`, a encore inventorié seulement **632 reçus**,
sur 4 pages R2, comme son audit précédent.

## Cause identifiée dans le code

`loadNextQueue()` remplace la fenêtre active `state.tasks`, ajoute sa
longueur à `state.completedOffset` et **remet `state.cursor=0`**.

La clé d'un reçu indexé utilisait auparavant seulement
`state.cursor`, `task.page` et `task.series` sous
`runs/<runId>/receipts/`. Deux tâches situées au même index local dans
deux fenêtres différentes pouvaient donc **réécrire le même reçu**.
Le compteur `state.count`, lui, augmentait pour les deux réponses.

Le correctif remplace l'index local par `currentDone(state)` =
`(state.completedOffset||0)+state.cursor` dans la **clé du reçu indexé**.
Il ne change ni la découverte des tâches, ni les réponses brutes, ni
l'index SHA-256, ni les limites d'API, ni le planificateur.

Les gros objets archivés sous `raw/` utilisent déjà une clé UUID et ne
sont pas concernés par cette collision de nommage.

## Conséquences et limites

- **Prévention uniquement.** Le changement n'invente ni ne restaure
  les reçus déjà écrasés et ne relance pas de campagne.
- Les objets JSON sous `objects/<sha256>.json` sont dédoublonnés par
  contenu : ils peuvent être toujours présents, mais certains n'ont
  plus de reçu intact pour relier leur contenu à une route source.
- Le nombre d'objets distincts conservés, d'objets sans reçu et de
  `raw/` est **inconnu** sans un inventaire R2 dédié.
- La phase 2 fondée sur l'inventaire des reçus peut avoir manqué des
  routes liées lorsque leurs reçus d'origine étaient remplacés. Ne pas
  interpréter la file terminée comme exhaustivité API.
- L'audit V2 ne pourra pas faire apparaître magiquement les reçus
  absents : ne pas le relancer avant d'avoir établi un inventaire
  des objets conservés.
- Toute tentative de récupération devra être distincte, sans
  déduire de manière spéculative la provenance des objets par leurs
  champs et sans réécrire les reçus historiques.

## Validation

Un test reproduit une transition entre deux fenêtres dont le curseur
local vaut zéro dans chacune, et vérifie que les deux reçus existent
avec leurs chemins et clés distinctes. Un second teste les anciens
états sans `completedOffset`. Les tests existants de collecte,
pagination, reprise, phase 2 et récupération doivent toujours réussir.
