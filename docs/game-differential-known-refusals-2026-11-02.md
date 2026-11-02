# Différentiel /game : réutilisation prudente des refus connus — 2 novembre 2026

## Base factuelle
Audit privé des échecs du 31 octobre 2026 (R2-only) :
- 2 159 URL distinctes en attente : 1 638 HTTP 404, 521 HTTP 472 ;
- 1 583 HTTP 404 de relations `/items/{id}/characters`, dont 1 133
  avec preuve de fiche d'objet indexée et 450 sans attestation suffisante ;
- 518 refus HTTP 472 de détails `/characters/{id}?` enrichis avec **cinq
  sections alternatives attestées** (capacités, costumes, équipement,
  coûts directs et coûts globaux) ;
- 3 refus HTTP 472 sans couverture intégrale ;
- 52 refus 404 `events` et 3 refus 404 `episodics`.

Ces constats **ne prouvent pas** que toutes les associations 404 sont
inapplicables ni que les détails alternatifs sont équivalents à un
JSON `full` unique.

## Changements minimaux pour les futures campagnes
`src/game-differential-sync.js` reste le collecteur existant. Les quotas,
Cron, checkpoint, schéma des reçus et mécanismes HTTP 472 sont inchangés.

### 404 : associations objet/personnage
Le système savait déjà différer les associations 404 d'un objet inchangé.
La nouvelle condition interdit de réutiliser ce constat si le pointeur de
l'objet parent est manifestement **ancien (>=21 jours)**, mal formé ou
incohérent avec son SHA. Il n'est pas permis d'en inférer une preuve
physique : la validation HEAD+reçu reste celle du diagnostic spécifique.

Lorsqu'une version sémantique **différente** de l'objet parent est observée,
le suivi des tentatives précédentes repart à zéro. Le 404 n'est pas
étiqueté `success` et la fiche objet continue d'être mise à jour.

### 472 : détail de personnage enrichi
Quand une URL demande simultanément `abilityKits=full`,
`costumes=full`, `gearTiers=full`, `pieceInfo=full`,
`pieceDirectCost=full` et `pieceFlatCost=full`, les réponses 472
continuent à provoquer la récupération ciblée existante.

**Les prochaines campagnes peuvent différer un GET `full` connu refusé,
mais uniquement si toutes les conditions suivantes sont remplies :**
1. L'URL d'origine figure toujours comme `pending/http-472`, sans être
   déclarée résolue ;
2. Son personnage parent possède une référence différentielle sémantique
   cohérente et stockée depuis moins de 21 jours ;
3. Le hash sémantique du parent est identique à celui constaté lors du
   refus initial ;
4. Chacune des **cinq sections exactes** a sa propre date de succès
   enregistrée après validation du blob et de son reçu lors de
   `finishCommitted`, et aucune date n'a 21 jours ;
5. La date de réexamen du refus initial n'est pas dépassée.

La vérification est limitée aux métadonnées du registre et du parent ;
aucune recherche massive des objets R2 n'est déclenchée à chaque Cron.
Les alternatives, déjà indexées dans `latest/`, restent synchronisées
par le différentiel. À expiration ou changement sémantique du personnage,
la demande complète redevient éligible immédiatement.

Les anciens `recoveredParts` sans dates de succès individuelles ne
sont **jamais promus rétroactivement** en preuve fraîche. Il faudra
une prochaine collecte validée pour initialiser ces dates.
La couverture des cinq sections ne crée pas de faux JSON full et ne
supprime pas l'échec d'origine.

### 404 d'événement/épisode et 472 incomplets
Aucune suppression spéculative n'est appliquée. Ces URL restent visibles
dans le registre et sont réessayées selon les règles existantes ;
leurs codes ne sont pas modifiés pour améliorer artificiellement le
pourcentage de réussite.

## Compatibilité et sécurité
- Aucun appel Scopely/R2 de production pendant ce chantier.
- Aucun changement des campagnes historiques, de leurs IDs ou checkpoints.
- Aucun nettoyage du bucket, aucun nouveau Cron, aucune augmentation de GET.
- Nouvelles métadonnées facultatives `expandedSourceHash` et
  `verifiedParts` dans le registre existant uniquement, rétrocompatibles
  avec les versions V1/V2.
- Les 30 jours de conservation sont gérés par les règles du bucket déjà
  configurées ; le différentiel utilise une marge conservatrice de 21 jours.
- Le diagnostic autonome R2 reste la source des **preuves de présence
  physique** et de la qualification des refus historiques.

## Validation
Tests simulés vérifiant : cinq sections datées -> refus `full` différé,
source modifiée -> GET original réactivé et tentatives réinitialisées,
section manquante -> aucune suppression, objet parent expiré -> aucun
404 masqué, changement d'objet -> compteur de reprise réinitialisé,
et non-régression des flux existants.

PR laissée ouverte pour vérification avant tout déploiement.
