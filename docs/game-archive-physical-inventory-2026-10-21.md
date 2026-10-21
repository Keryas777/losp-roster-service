# Inventaire physique R2 — LoSP Game Archive (21 octobre 2026)

## Pourquoi

La collecte Scopely `/game/v1/` terminée comptabilise 7 428 archivages
réussis, alors que l'audit V2 (terminé le 21 octobre à 13:12 UTC)
ne découvre que 632 reçus. La PR #71 empêche les futures collisions de
noms de reçus, mais ne recrée aucun ancien fichier.

Cet outil **ne lance aucune collecte**, ne modifie aucun fichier en R2,
n'interroge aucun endpoint Scopely et n'infère aucune provenance manquante.

## Procédure administrateur

Dans la page Cloudflare Access `/admin` :

1. Ouvrir « Inventaire physique des archives R2 ».
2. Cliquer **« Inventorier les fichiers R2 »** et laisser la page ouverte.
3. Le navigateur parcourt séquentiellement les trois préfixes de la
   campagne `active.json` : `receipts/`, `objects/`, `raw/`.
4. Une fois affiché « Inventaire terminé », cliquer
   **« Copier le bilan JSON »** et transmettre le rapport.

L'inventaire conserve sa progression **en mémoire dans l'onglet**,
sans localStorage ni checkpoint R2. Si le navigateur ferme/recharge la page,
il faut recommencer uniquement **la lecture R2**, jamais la collecte.
Les résultats incomplets ne sont jamais présentés comme définitifs.

## Détails du protocole

L'endpoint privé `GET /admin/api/game-archive-inventory?kind=overview`
retourne le runId de la campagne active.
`GET ...?kind=receipts|objects|raw&runId=<uuid>&cursor=<r2-cursor>`
énumère exactement 200 clés maximum par appel et indique
`nextCursor`. Le `runId` est vérifié à chaque page : si la campagne
active change entre deux pages, l'inventaire s'arrête plutôt que de
mélanger des campagnes.

La route est soumise à la même authentification Cloudflare Access que
le reste des fonctions `/admin/api/`.

- `receipts/` : lecture des **petits** JSON de reçus avec 5 GET R2 simultanés
  maximum. Validation du chemin `/game/v1/` et de la référence vers
  `objects/<sha256>.json` ou `raw/<uuid>.json` du même run.
  Les reçus trop gros, illisibles ou invalides restent comptabilisés.
- `objects/` et `raw/` : **list uniquement** (aucun téléchargement
  du JSON du jeu), contrôle du format des noms et tailles R2 présentes.
- Le navigateur compare les références au jeu de fichiers présents,
  calcule les objets référencés, les **orphelins**, les références
  **cassées** et les références multiples. Le rapport copiable ne
  contient que des compteurs, dates et identifiant technique de campagne ;
  **aucune donnée de jeu, aucun token, aucun roster ni identifiant joueur**.
- Les limites de sécurité (1000 pages et 100 000 clés par préfixe)
  provoquent un arrêt explicitement incomplet, sans modifier les budgets.

Ce diagnostic décrit uniquement les objets **présents au moment de la lecture**.
Il ne démontre ni la validité des contenus ni la complétude de l'API.
Un objet orphelin reste potentiellement exploitable, mais le service ne peut
pas déduire avec certitude son endpoint d'origine à partir du seul SHA-256.

## Interprétation

- `receipts.listed` : nombre de fichiers de reçus trouvés, indépendamment
  de `archivedResponses` (qui est un **compteur d'écritures**, incluant
  anciennes collisions et contenus dédoublonnés).
- `objects.listed` : fichiers physiques sous `objects/`, pas nombre
  d'appels Scopely.
- `objects.orphaned` : objets SHA-256 présents mais n'apparaissant
  dans aucun reçu valide conservé.
- `raw.orphaned` : objets volumineux présents sans reçu.
- `missingReferences` : références d'un reçu valide dont le fichier
  physique n'a pas été retrouvé. Cela peut aussi résulter de rétention R2.
- `duplicateReferences` : reçus valides pointant vers le même objet
  (dédoublonnage du contenu, pas forcément une erreur).

## Suite

Après réception du rapport : comparer avec les 7 428 écritures historiques,
qualifier les éventuelles réponses orphelines et déterminer si
une reconstitution **prouvable** de provenance est envisageable.
Aucune réécriture automatique des anciens reçus, aucune relance massive.
