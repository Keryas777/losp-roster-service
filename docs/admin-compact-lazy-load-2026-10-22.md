# Administration compacte et lecture à la demande — 22 octobre 2026

## Problème constaté dans la version précédente
La page privée `/admin` chargeait d'office `/admin/api/sessions`.
L'implémentation existante de `adminSessionList()` consulte deux endpoints
officiels Scopely par session valide :
- `GET /player/v1/card`
- `GET /player/v1/alliance/card`

Avec neuf connexions, **un simple rechargement du navigateur pouvait générer
18 GET Scopely**, en plus des lectures locales R2 lancées automatiquement
par différents panneaux. Le bouton « renouvellements » relançait lui
aussi implicitement cet inventaire de comptes.

## Changements volontairement limités à l'administration
- Quatre onglets mobiles, sans framework : **Vue d’ensemble**, **Rosters**,
  **Archives R2**, **Outils avancés**.
- Les sections existantes restent présentes et fonctionnelles mais sont
  repliables dans chaque onglet ; leur état est conservé durant la navigation.
- L'onglet choisi peut être ouvert via `/admin#archives` (fragment local).
  Aucun état de compte, de roster ou de requête n'est stocké dans le navigateur.
- Les endpoints, autorisations, scopes OAuth, fonctions du collecteur, Cron,
  règles de rétention et quotas internes sont **inchangés**.
- Aucun appel Scopely n'est désormais déclenché **par l'ouverture ou le
  rafraîchissement de la page**. Un unique GET vers
  `/admin/api/catalog` (liste locale statique, aucun upstream) reste utile
  pour initialiser la liste des rubriques de l'Explorateur.
- « Charger / actualiser les comptes (API MSF) » reste disponible, mais ses
  GET Scopely deviennent un **choix explicite**. « Comptes suivants » reste
  également manuel.
- Le suivi OAuth lit directement son état agrégé R2 et réutilise les détails
  de sessions déjà chargés dans la page, sans les rafraîchir silencieusement.
- Captures de saison existantes, statut collecteur, statut roster,
  audit des structures et audit des orphelins : leurs premiers GET **R2**
  passent également à la demande, par leurs boutons d'actualisation.
- La consultation des données privées reste protégée par Cloudflare Access.

## Ce qui continue sans dépendre de la page
L'audit de récupérabilité des JSON orphelins (PR #73) est indépendant du
navigateur. S'il est déjà lancé, le Cron et les checkpoints R2 continuent
à progresser pendant que l'onglet est fermé ou rechargé. La nouvelle
interface ne réinitialise jamais cette campagne.

## Impact sur les requêtes
| Action | Avant | Après |
| --- | --- | --- |
| Ouvrir ou recharger `/admin` | Jusqu'à deux GET Scopely par session | **0 GET Scopely** |
| Consulter renouvellements OAuth | Deux GET Scopely par session + R2 | R2 uniquement ; détails de sessions en mémoire si disponibles |
| Charger / actualiser comptes | GET officiels | GET officiels, seulement sur clic |
| Capturer rangs / valider partages / explorer API | Actions explicites | Inchangé |
| Voir les audits R2 | GET automatiques à l'ouverture | GET sur clic |

Attention : **les boutons de tests, de vérification de couverture et
d'exploration continuent d'effectuer des appels officiels lorsqu'ils
sont activés par un administrateur**. Leur coût n'a pas changé.

## Contrôles après déploiement
1. Ouvrir `/admin` : seuls les onglets et panneaux compacts sont visibles ;
   aucun compte n'est interrogé automatiquement.
2. Passer dans **Archives R2** et déplier l'audit des orphelins ; cliquer
   « Actualiser le rapport » pour lire le checkpoint en cours.
3. Tester « Charger / actualiser les comptes » explicitement (lecture
   Scopely), puis « Actualiser les renouvellements » (R2 uniquement).
4. Vérifier l'onglet **Outils avancés** et le résultat dynamique
   de l'Explorateur.
5. Ne pas fusionner avant validation ; vérifier ensuite le SHA réellement
   déployé dans Cloudflare (les tests GitHub ne déploient pas à eux seuls).
