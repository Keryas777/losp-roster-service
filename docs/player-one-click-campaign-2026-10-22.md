# Collecte /player en un clic — 22 octobre 2026

## Interface réelle du panneau admin

La navigation actuelle comporte quatre onglets :
**Vue d’ensemble**, **Rosters**, **Archives R2** et **Outils avancés**.

La nouvelle rubrique « Collecte globale /player/v1 » est rangée en tête de
**Archives R2** (`/admin#archives`) et présente :

- **Collecter toutes les données /player** : un unique clic, sans choisir
  de compte, alliance, joueur ou famille.
- **Voir l’avancement (R2)** : statut, nombre de comptes OAuth découverts,
  nombre de familles enregistrées, déjà archivées, ignorées ou échouées.
  Ce contrôle n’appelle pas Scopely.

L’ancien panneau de collecte manuelle famille par famille (PR #75) reste
disponible sous **Outils avancés**, non plus flottant hors des onglets.
La page reste mobile first et l’ouverture de l’admin ne fait aucun GET
Scopely automatiquement.

## Ce que fait effectivement le bouton

Au clic, le Worker liste les **sessions OAuth enregistrées** dans le
coffre privé R2, sans demander aux utilisateurs de se reconnecter et
sans appel Scopely à l’étape de lancement. La campagne reprend ensuite
à chaque minute au moyen du **Cron déjà en place** ; elle continue même
si la page est fermée.

Pour **chaque compte directement connecté**, selon ses scopes personnels
effectivement consentis :
- équipes enregistrées : `/player/v1/squads` ;
- inventaire : `/player/v1/inventory` ;
- souhaits : `/player/v1/itemWishlist` ;
- événements/progression : `/player/v1/events`.

Pour les **membres non connectés**, la campagne découvre leurs IDs actuels
via `/player/v1/alliance/members` et récupère uniquement
`/player/v1/squads/member/{id}` lorsque le roster est partagé. Le Worker
revérifie cet accord avant ET après la requête ; il n'essaye pas de lire
leurs inventaires ou événements individuels. Les mêmes IDs constatés
sous deux comptes OAuth sont dédoublonnés dans une campagne.

Les rosters personnels et partagés, `alliance/card` et
`alliance/members` possèdent déjà une collecte R2 gérée par
`private-roster-batches.js` / `automatic-roster-scheduler.js` :
**le nouveau bouton ne lance pas une deuxième collecte de ces familles**.
Cette PR n'affirme pas qu'elles sont physiquement déjà présentes dans
R2 : leur bilan demeure accessible dans **Rosters**.
Une campagne /player terminée signifie seulement que les **familles
complémentaires** ont été parcourues ; les archives déjà existantes
sont suivies séparément.

## Limites, transparence, sécurité

- Les endpoints qui nécessitent d'autres consentements OAuth sont
  **ignorés avec un compteur**, jamais contournés.
- Seuls des GET explicites vers le domaine Scopely et les endpoints
  déjà autorisés sont possibles.
- Au maximum une action par tick et 10 GET Scopely possibles par tick,
  réservation conservatrice à 1 000 requêtes/jour pour cette campagne.
- En cas de HTTP 429, **pause d'une heure**, et jamais de réponse
  refusée classée comme une archive complète. Les autres erreurs
  provoquent un délai de reprise puis un état **partiel** si elles persistent.
- Les enveloppes JSON sources et le checkpoint sont conservés sous
  `roster-batches/v1/`, bénéficiant de l'expiration **R2 à 7 jours**
  configurée pour ce préfixe ; aucun ajout à GitHub Pages.
- Le panneau administrateur et son API demeurent sous contrôle
  Cloudflare Access + allowlist.
- Aucun nouveau scope, compte OAuth, cron, fichier public ou backend.

## Déploiement et validation

Cette PR n'a effectué aucune lecture des secrets de production ni
aucun téléchargement Scopely en direct. Après fusion et déploiement,
contrôler /admin#archives et démarrer **une seule fois**, puis vérifier
l'avancement par le bouton R2 ; pour les rosters historiques, vérifier
séparément leur inventaire R2 sous l'onglet Rosters. Une erreur sur une
famille peut conduire au statut **partiel** au lieu d'affirmer une
couverture intégrale.