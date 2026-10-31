# Audit ciblé des échecs 404 / 472 du différentiel /game — 31 octobre 2026

## Sources de travail
- Rapport déjà présent `docs/game-archive-targeted-recovery-2026-10-20.md`.
- Capture administrateur du 31 octobre : 2 159 URL en attente (1 638 HTTP 404 et
  521 HTTP 472), dont 519 URL ayant une ou plusieurs variantes récupérées ;
  rattrapage des anciens reçus 2 577 / 2 577.
- Code existant `game-differential-sync.js`, `game-phase2-discovery.js`,
  `game-archive-recovery.js` ; spécification publique Scopely beta 0.2.1.
- Pas d'accès direct au R2 de production pendant ce changement.

## 404 : qualification sans conclusion abusive
La découverte `items/{id}/characters?charInfo=full` suit une fiche
`items/{id}` officielle. Le 404 de la route imbriquée ne démontre pas
l'absence de la **fiche d'objet**.

Le diagnostic persistant V2, lancé manuellement après la fusion, classe les
URL par forme et vérifie le **parent exact** d'une association 404 :
1. Pointeur `diff/latest/<sha256(parent)>.json` pour la route parent exacte.
2. Reçu différentiel correspondant et cohérence de la référence.
3. Présence physique de l'objet R2 et date de stockage dans la fenêtre 30j.

Les résultats sont distincts :
- `indexedObjectPresent` : preuve limitée au pointeur, reçu et HEAD R2
  (pas un re-hash de tous les octets pendant cet audit).
- `noDifferentialIndex` : aucune preuve **dans l'index différentiel**,
  mais la fiche peut se trouver dans les reçus de l'archive initiale.
- `integrityOrFreshnessUnknown` : pointeur, reçu, objet ou fraîcheur
  insuffisamment prouvé.

Aucun de ces états n'est converti en « objet absent » sur la seule base
du 404 de l'association. Le scan complet des reçus initiaux, dépourvus
d'index URL, n'est pas relancé.

## Prévention des GET d'association inutilement répétés
Un échec HTTP 404 sur la route imbriquée conserve l'empreinte **sémantique**
du parent si son dernier index différentiel est disponible. Une nouvelle
tentative peut être écartée uniquement si :
- le même URL exact est encore `pending` avec motif `http-404` ;
- le parent possède toujours **la même** empreinte sémantique ;
- la date `nextAt` n'est pas échue.

La fenêtre de réexamen est de 21 jours pour les associations disposant
d'une empreinte parent, sept jours sinon. Une modification du parent
permet une nouvelle vérification **immédiatement**, et l'expiration de la
fenêtre permet une revérification même sans changement.

Les anciennes lignes sans empreinte parent **ne sont pas supprimées** :
il leur faut un nouvel échec documenté avant la suppression conditionnelle.
Aucun filtre global sur les items, aucun hardcode de catégories SHARD/RS/ISO.

## 472 : preuves de variantes, sans reconstruction fictive
L'audit V2 lit les variantes exactes archivées dans `recoveredParts` ;
pour chacune, il vérifie le pointeur différentiel, son reçu et la présence
physique du blob (sous contrainte de date). Le rapport distingue :
- variantes déclarées et variantes attestées R2 ;
- URL avec au moins une variante attestée ;
- cinq familles mécaniques attendues pour un détail personnage élargi :
  `abilities`, `costumes`, `gear`, `direct-cost`, `flat-cost` ;
- couverture « cinq sections » seulement si ces cinq familles ont une
  preuve R2, ou si les quatre variantes officielles individuelles
  `basic/special/ultimate/passive` attestent ensemble la section capacités.

**Cinq preuves ne garantissent pas un JSON complet équivalent au GET full.**
L'absence de pointeur différentiel n'exclut pas des archives originales.
Un ancien effacement de `recoveredParts` ne peut pas être reconstitué
par une supposition : l'audit reflète les preuves encore traçables.

## Provenance conservée
Un nouveau `recordPending` préserve les variantes distinctes et la
date de récupération. Une URL auparavant `resolved` mais qui répond
de nouveau par un échec redevient `pending`, avec sa résolution
précédente conservée comme historique.

## Activation, compatibilité et absence d'effet de bord
L'analyse existante V1 terminée reste intacte jusqu'à un clic manuel
« Analyser les 404 et les 472 (R2) », qui recrée le même checkpoint
`failure-audit/v1/progress.json` en version 2.

V2 fonctionne par lots de 4 entrées par passage du **Cron existant**.
Fermer Safari n'interrompt pas l'analyse. Les vérifications de
présence R2 sont bornées par invocation. Aucun appel Scopely, aucun
changement de quotas, aucun nouveau Cron, aucune collecte complète,
aucune modification des archives officielles ou de la WebApp.

## Inventaire personnel — hors périmètre de cette PR
La spécification officielle indique que
`GET /player/v1/inventory?itemType=SHARD` retourne les quantités
`ItemQuantity`, sous scope personnel `m3p.f.pr.inv`.
`CharacterInfo.starItems[0]` identifie l'objet d'éclats jaunes,
`CharacterInstance.activeYellow` renseigne l'étoile activée,
`upgradeData/yellowStarTotalShards` décrit les seuils.
La disponibilité réelle pour un joueur et les correspondances d'ID
doivent être validées avec son consentement ; ne pas en déduire
un accès via le roster partagé.
