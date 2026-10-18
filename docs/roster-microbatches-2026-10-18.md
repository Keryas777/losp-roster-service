# Collecte privée par micro-lots — étape de validation

Suite aux PR #45 (approbation des cinq alliances) et #46 (pilote réussi le
18 octobre 2026 : **Unhappy Miky, 383 personnages, 4 pages**).

Cette PR prépare une **reprise manuelle** par alliance. Elle **n'active PAS**
encore un cron de collecte des 120 membres, ni une diffusion à la WebApp.

## Opération depuis /admin

Pour chaque alliance approuvée, le panneau affiche
« Collecter le prochain lot (2) ». À chaque clic :

1. Cloudflare Access authentifie l'administrateur (JWT signé), vérification
   anti-CSRF sur le POST.
2. Un **verrou Durable Object séparé par alliance** refuse le lancement
   concurrent d'un deuxième lot et évite des écritures de progression concurrentes.
3. Relecture de l'approbation R2 et découverte de la session Scopely
   appartenant *actuellement* à cette alliance, sans hardcoder ses noms.
4. Lecture de l'effectif actuel, sélection de **deux coéquipiers partagés** à
   partir de l'index du checkpoint, pagination exhaustive et relecture de
   l'effectif (identifiants, statut de partage, numéro de version implicite).
5. Comparaison de l'empreinte SHA-256 de l'effectif avec le checkpoint privé
   existant. Un changement depuis le précédent lot entraîne un **refus 409**,
   jamais un assemblage de données provenant de versions différentes.
6. Relecture de l'alliance et de son approbation, écriture R2 **isolée pour
   chaque joueur**, puis écriture du seul fichier de progression après succès
   de toutes les écritures. En cas d'échec au milieu d'un lot, les fichiers
   orphelins ne sont pas référencés comme validés, et la prochaine tentative
   réécrit exactement le même lot.
7. L'état `complete-co-members` signifie uniquement « les rosters des
   **coéquipiers** actuellement partagés ont été lus ». Il ne signifie pas
   couverture complète des 24 comptes : le compte OAuth lui-même nécessite
   l'endpoint personnel et un scope spécifique.

Une option de **redémarrage explicite** est disponible en cas de changement
d'effectif ou d'expiration de la série. Les objets de l'ancienne série
deviennent orphelins et devront être supprimés par la politique de cycle de
vie R2.

## Stockage privé

- `roster-batches/v1/{allianceFingerprint}/progress.json` :
  `runId`, empreinte d'effectif, dates, nombres de coéquipiers éligibles et
  terminés ; **pas de roster en clair dans le checkpoint**.
- `roster-batches/v1/{allianceFingerprint}/{runId}/member-{index}.json` :
  personnages reçus en JSON brut, identité de membre explicitement volatile,
  horodatage, expiration. Aucun accès GET externe/public à ces objets.
- Durée logique : **7 jours à compter du début de chaque série**.
  **Avant d'utiliser ce mode à l'échelle**, configurer impérativement dans
  le bucket R2 privé une règle de suppression à 7 jours pour
  `roster-batches/v1/`. Le code ne prétend pas garantir une suppression
  automatique des objets orphelins sans cette règle.
- Maximum 2 coéquipiers par invocation, jusqu'à 10 pages par roster,
  maximum interne de 35 appels Scopely par lot.
- Une série terminée ne constitue **pas** encore un snapshot publié de l'alliance.
  Aucune conversion vers les JSON de la WebApp n'a lieu.

## Contrôles et limites

- Les PID Google Sheets ne sont ni lus ni modifiés dans cette phase.
- Aucun contenu de roster n'est renvoyé au navigateur ; seules des métriques.
- Aucun GitHub token d'écriture, webhook, POST externe, route de publication
  ou connexion de LoSP Roster Service vers la WebApp.
- La WebApp n'est pas modifiée. Elle viendra **plus tard chercher elle-même**
  les snapshots validés par GET authentifiés, via un contrat encore à écrire.
- Si Scopely refuse un partage, répond 429, ou si l'effectif change :
  pas de nouveau checkpoint. Les rosters déjà validés dans la série restent
  privés, et une reprise/redémarrage est nécessaire.
- Une seule session OAuth par alliance ne permet pas, avec cet endpoint
  coéquipier, de récupérer le roster personnel de ce compte. Cette lacune
  est **volontairement signalée** et fera l'objet de l'étape suivante.
- La progression ne remplace pas le registre PID : les identifiants
  `MemberId` restent temporaires.

## Validation

CI locale simulée via `node --test tests/*.test.mjs`.
Les tests couvrent les lots successifs (2+2+1), les changements d'effectif,
la reprise, les séries expirées, le verrou contre la concurrence,
l'authentification, l'interdiction de publication et l'isolation par alliance.

Après fusion, utiliser une seule alliance pour parcourir deux lots, puis
contrôler depuis /admin que la progression est bien passée de 2 à 4.
L'étape automatique quotidienne ne sera introduite qu'après validation en
production et vérification de la politique R2.
