# Audit des lacunes de la collecte MSF /game/v1 — 20 octobre 2026

## Objectif

Afficher la **répartition des lacunes déjà consignées dans R2** sans
ajouter un seul appel à Scopely, sans redémarrer la campagne et sans
changer les quotas, les workflows, les authentifications ou les rosters.

La valeur `gapCount` de `/admin/api/game-archive` donne seulement
un total. Elle ne dit pas pourquoi certaines ressources n'ont pas été
archivées ou indexées. Le diagnostic ajoute **une lecture séparée et
facultative** par bouton depuis le panneau `/admin`.

## Source de vérité

- `game-archive/v1/active.json` désigne le run courant.
- `game-archive/v1/runs/{runId}/progress.json` contient le tableau
  `gaps` enregistré par les collecteurs des PR #58–#62.
- L'audit se limite à **deux lectures R2**, sans `list`, `put`, appel
  réseau amont, cron, verrou ou accès à d'autres préfixes.
- Les réponses restent `Cache-Control: private, no-store` et passent
  exclusivement par la même authentification Cloudflare Access JWT que
  le reste de `/admin`.

## Rapport renvoyé

`GET /admin/api/game-archive-gaps?offset=0&limit=25` renvoie :

- Nombre total de signalements cumulatifs et chemins distincts ;
- Regroupements par `reason`, famille `/game/v1`, catégorie
  d'investigation et statut HTTP ;
- Liste paginée (50 maximum par lecture), filtrable par `family`
  et `cause`, ordonnée des signalements les plus récents aux plus
  anciens selon leur ordre dans `progress.json` ;
- Contexte de campagne : statut actuel, tâches traitées et réponses
  archivées.

Les lignes de diagnostic ne conservent que chemin public de jeu
`/game/v1/...` validé, statut HTTP, motif, catégorie et compteur éventuel.
Le chemin privé R2 `objectKey`, les jetons, le contenu JSON source,
les données personnelles et les identifiants internes du run ne
sont **jamais envoyés au navigateur**.

## Interprétation — ne pas surévaluer les chiffres

Un signalement enregistré **n'est pas nécessairement une ressource
encore inaccessible**. Exemple : un HTTP 472 sur `upgradeData` peut
avoir été suivi de réponses 200 pour les détails alternatifs, sans
que le signalement de la racine soit effacé.

Les catégories sont des **pistes de diagnostic**, pas des verdicts :

- `volume-ou-pagination` : HTTP 472 ou réponse non paginable ;
- `alternative-partielle` : la récupération par détails a été
  déclenchée, sans garantie de récupération complète ;
- `indexation-requise` : le JSON brut est déjà stocké, mais
  son contenu n'a pas encore été extrait ;
- `acces-a-verifier` : HTTP 401/403/464/474 ;
- `introuvable-a-verifier` : HTTP 404/422, ID éventuellement périmé ;
- `reprise-a-etudier` : tentatives épuisées ; prévoir une reprise
  explicite des écarts après la première campagne ;
- `identifiant-manquant`, `schema-a-etudier`,
  `pagination-a-etudier` : découverte ou conformité du schéma
  à approfondir.

Les entrées multiples d'un même chemin restent visibles : le rapport
affiche à la fois le nombre d'entrées et celui des chemins distincts.

Ce module **ne réessaie pas** les requêtes, ne modifie pas `gaps`
et ne remplace pas une future campagne de récupération.
Il constitue un inventaire de travail pour prioriser les prochains
correctifs.

## Tests et vérification en production

- Tests simulés : totaux, ventilation, parcours paginé, filtres,
  conservation des lacunes inconnues, blocage de chemins non autorisés,
  absence de GET Scopely et d'écriture R2, contrôle admin Access.
- Après fusion et déploiement : visiter `/admin`, cliquer sur
  **Analyser les lacunes enregistrées**, vérifier les familles et codes
  réellement observés. Les valeurs réelles sont accessibles uniquement
  au détenteur de la session administrateur Cloudflare.

Aucune affirmation d'exhaustivité totale ou de correction rétroactive
des signalements n'est tirée d'une CI verte.
