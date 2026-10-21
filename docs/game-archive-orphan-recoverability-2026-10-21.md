# Audit de récupérabilité des 6 537 objets R2 orphelins — 2026-10-21

## Sources déjà validées (aucun nouvel appel Scopely)
- Campagne R2 : `ced5b23f-504c-428b-9ca8-02171f2a21ef`, `completed-with-gaps`.
- 7 428 archivages réussis comptabilisés, 8 748 tâches traitées.
- Inventaire physique #72 : 632 reçus valides, 7 169 objets SHA-256,
  **6 537 sans reçu** ; aucun `raw/` ; 143 682 091 octets.
- Les collisions de reçus causées par le curseur local ont été prévenues
  par la PR #71. Cela n'a PAS restauré les reçus historiques.

## Objectif de la PR #73
Audit automatique, progressif et **strictement limité à R2**, permettant de
vérifier l'intégrité et les formes de données des objets orphelins. Aucune
tentative de réécrire des `receipts/`, `objects/`, `queue/`, `phase2-seen/`
ou `progress.json`. Aucun appel Scopely, aucune session OAuth/roster et
aucun changement des fréquences ou budgets existants.

Un seul artefact est écrit :
`game-archive/v1/runs/<runId>/orphan-audit/v1-progress.json`.
Il contient le checkpoint et les **hashs de référence des reçus existants**,
des statistiques agrégées et un échantillonnage borné de signatures de champs.
Il ne contient pas de JSON du jeu, de noms de joueurs ni de jetons.

## Activation
1. Fusionner la PR uniquement après validation, puis **attendre le déploiement
   Cloudflare du même commit** : un GitHub Actions vert ne garantit pas la
   mise en ligne immédiate.
2. Ouvrir l'administration privée `/admin`.
3. Dans « Audit de récupérabilité des JSON orphelins R2 », cliquer une fois
   sur « Lancer l'audit des orphelins ».
4. Le Cron Cloudflare déjà existant `* * * * *` poursuit par lots,
   avec un checkpoint R2 : la page peut être fermée.
5. Actualiser le rapport occasionnellement ; à
   `status: snapshot-complete`, copier le JSON agrégé.

Le bouton **ne lance jamais la collecte générale**, ni l'audit V2.
Répéter le démarrage pendant ou après l'audit renvoie le checkpoint sans
écraser les résultats. Une nouvelle photographie nécessitera une nouvelle
version explicite de cet audit.

## Étapes techniques (bornées)
1. **Reçus** : énumération par pages de 40, lecture des seuls petits reçus
   (4 lectures R2 simultanées), conservation des hashs référencés ; chemins
   `/game/v1/` et clés SHA strictement validés.
2. **Indices de requêtes historiques** : lecture limitée de
   `progress.json`, comptage des éléments conservés dans `queue/` et
   `phase2-seen/`, sans établir de correspondance sans preuve.
3. **Objets** : énumération par pages de 40 ; les objets déjà référencés
   ne sont pas relus. Les orphelins de **256 000 octets maximum** sont
   lus, leur SHA-256 est recalculé et comparé à la clé R2, puis leur
   JSON est validé. Les objets plus gros restent `tooLarge` (présence
   connue, contenu non analysé).
4. **Structures** : extraction de noms de champs, types généraux et
   signatures bornées (48 distinctes) ; regroupement en **hypothèses
   structurelles** : characters, characterInstances, événements,
   équipements, episodics, ISO-8, etc. La classe `indetermined`
   reste obligatoire pour les structures ambiguës.

Un JSON valide dans `objects/<sha256>.json` ne fournit jamais
à lui seul la requête complète utilisée pour le récupérer.
Les chemins retrouvés dans `queue/` et `phase2-seen/` sont des
**candidats historiques**, pas une preuve que tel hash en provient.

## Sécurité et interprétation
- R2 uniquement, mêmes protections Cloudflare Access que les autres routes
  `/admin/api/`, POST same-origin + JSON.
- Les réponses administrateur affichent les **comptages et signatures**
  uniquement : pas de chemins individuels, IDs MSF, JSON bruts ni hash list.
- Aucune écriture hors de `orphan-audit/v1-progress.json`.
- Aucune mutation des données archivées et aucune suppression automatique.
- L'audit ne mesure ni la complétude officielle de MSF, ni la validité
  sémantique de chaque réponse. `hashVerified` indique uniquement
  l'intégrité cryptographique des objets examinés.
- `withReceipt` identifie les objets physiquement reliés par un reçu valide.
  `orphaned` n'est **pas** synonyme d'inexploitable.
- Pas de garantie que tous les `queue/` historiques existent ou sont
  exhaustifs ; `evidence.unreadable` doit être surveillé.
- La rétention R2 réelle et la conformité au TTL contractuel Scopely
  (maximum 30 jours) doivent être contrôlées **sans prolongation automatique**.

## Après réception du rapport
- Confronter `objects.listed/orphaned` à l'inventaire #72.
- Vérifier les taux `inspected/hashVerified/tooLarge/unreadable`.
- Prioriser ensuite **une reconstitution de provenance démontrable**, fondée
  sur des indices fiables, ou des catalogues explicitement marqués
  « structure probable, provenance non vérifiée ».
- Ne relancer ni la campagne de 8 748 tâches ni l'audit V2 pour ce diagnostic.
