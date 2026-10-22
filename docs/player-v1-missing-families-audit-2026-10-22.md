# Audit et collecte privée des familles /player absentes — 22 octobre 2026

## Périmètre et méthode

Sources : code réel de la branche main, OpenAPI officielle Scopely beta 0.2.1
(https://developer.marvelstrikeforce.com/beta/msf-api.json),
rapports du 9 et du 19 octobre, PR #49, #54, #70.
Audit **du code de collecte et des archives prévues**, pas audit des octets
effectivement présents dans le bucket R2 de production : cette branche
n'a pas accès au bucket ni aux sessions OAuth en production.
Une route présente dans l'explorateur ne constitue pas une archive R2.
Les tests automatisés utilisent un fournisseur simulé ; ils ne prouvent
pas que Scopely répond aujourd'hui HTTP 200 sur une route non encore essayée.

## Les deux populations ne sont pas équivalentes

1. **Membres de l'alliance sans OAuth individuel LoSP**, avec
   \`AllianceMemberCard.card.rosterShare === true\` : la connexion du
   capitaine autorisé permet de lire les informations de membre dans
   \`/player/v1/alliance/members\`, les profils
   \`/player/v1/card/member/{memberId}\` et, sous le scope
   \`m3p.f.ar.ros\`, le roster et potentiellement les squads partagés.
   Les IDs de membres sont volatils et doivent être revérifiés sur
   l'effectif actuel. \`rosterShare\` sur la liste des membres doit être
   exactement le booléen \`true\`. La propriété \`rosterShare\` d'une
   \`PlayerCard\` détaillée peut avoir un type différent et ne suffit pas.
   Aucun accès collectif documenté à leur inventaire, liste de souhaits
   ou progression individuelle.
2. **Comptes personnellement connectés à OAuth** (capitaines maintenant,
   tout autre joueur autorisé à l'avenir) : en plus du groupe précédent,
   l'API autorise leurs données \`card\`, \`roster\`, \`squads\`,
   \`inventory\`, \`itemWishlist\`, \`events\`, sous leurs permissions
   spécifiques \`m3p.f.pr.pro\`, \`m3p.f.pr.ros\`, \`m3p.f.pr.inv\`,
   \`m3p.f.pr.act\`. Le scope demandé ou affiché ne garantit pas l'accès :
   toute réponse HTTP 403/464 est considérée comme un refus.

## Audit : déjà obtenu vs réellement sauvegardé

| Famille | Déjà consultée / code disponible | Archive source dans R2 avant cette PR | Décision |
| --- | --- | --- | --- |
| \`alliance/card\`, \`alliance/members\` | Oui, HTTP 200 confirmé | Oui : enveloppes \`data\` + \`meta\` via PR #54 | NE PAS doublonner |
| \`roster/member/{id}\` partagé | Oui, collecte automatisée existante | Oui : pages source, même si certaines réponses conditionnelles sont 344 | NE PAS retoucher |
| \`roster\` compte OAuth | Oui, collecte automatique | Oui : pages source, gestion 344 | NE PAS retoucher |
| \`card\` compte OAuth | Oui, lu dans le panneau admin et lors de connexion | Pas d'archive brute indépendante systématique prouvée | Pas de nouvelle famille : déjà utilisé ; audit de conservation à différer |
| \`card/member/{id}\` | Oui, profils réellement lus | Les statistiques de l'effectif sont archivées dans \`members\`, mais pas forcément toute la fiche détaillée | Couverture partielle documentée, pas de reprise des 24 sondes |
| \`squads\` compte OAuth | Catalogue explorateur existant | Aucune collecte R2 régulière dans le code examiné | **Ajout manuel** |
| \`squads/member/{id}\` | Documenté, sans test live de la route | Non | **Ajout manuel, partage obligatoire** |
| \`inventory\` compte OAuth | Catalogue explorateur + test ponctuel préparé | Non | **Ajout manuel** |
| \`itemWishlist\` compte OAuth | Catalogue explorateur | Non | **Ajout manuel** |
| \`events\` compte OAuth | Catalogue explorateur | Non | **Ajout manuel** |
| \`events/{eventId}\` | Catalogue explorateur avec ID explicite | Non | Différé : dépend d'IDs obtenus légalement, pas de balayage de valeurs supposées |
| Recrutement, invitations et candidats | Routes diverses documentées, quelques HTTP 200 avec listes vides | Pas de collecte systématique | Différé : données tierces sensibles, étude d'utilité et consentements avant archivage |
| Routes POST/DELETE | Documentées | Non | **Exclues** (collecteur strictement GET) |

Les réponses conservées sont les enveloppes complètes de Scopely, sans
normalisation détruisant les propriétés futures. Les données \`/game/v1\`
et les 11 services Web Playable sont des chantiers distincts, non touchés.

## Ajout dans cette branche

Nouvelle route admin \`/admin/api/player-extras\`, soumise à la
**même authentification Cloudflare Access + allowlist serveur** que
les autres routes. Aucune route publique de données personnelles.

- \`POST\` explicite : \`{ "session": "<empreinte-session-OAuth>",
  "resource": "personal-inventory" }\`, ou
  \`{ "session": "...", "resource": "shared-member-squads",
  "member": "<ID volatil extrait de l'effectif actuel>" }\`.
- \`GET ?session=<empreinte-session-OAuth>\` : statut **R2 uniquement**,
  sans accès réseau Scopely, sans données brutes ni noms de joueurs.
- Resources **explicitement autorisées** :
  \`personal-squads\`, \`personal-inventory\`, \`personal-wishlist\`,
  \`personal-events\`, \`shared-member-squads\`.
- Avant **et après** capture de squads partagées : contrôle de l'effectif
  actuel et du booléen \`rosterShare === true\`. Aucune carte de membre
  extérieur, aucun inventaire tiers. Refus de partage observé :
  purge ciblée des snapshots de cette famille lors de cette vérification.
- Payloads officiels complets : \`data\`, \`meta\`, champs inconnus ;
  aucune réponse brute ne remonte via le POST ou GET de capture.
- Tableaux paginés à 100 entrées et au plus huit pages par clic ;
  \`SquadsInfo\` personnel est un objet unique. Toute incohérence de
  pagination, limite, erreur fournisseur ou changement de consentement
  **interdit** la publication du pointeur \`latest.json\`.
  Un plafond de huit pages est une sécurité, **pas** une garantie
  d'exhaustivité : \`page-budget\` signale un échec partiel.
- Un verrou Durable Object existant, mais avec **une empreinte dédiée**
  (pas celle des collectes de rosters), évite les doubles captures.
  Une capture récente est réutilisée pendant dix minutes.
- Toutes les écritures sous \`roster-batches/v1/player-extras/\` pour
  bénéficier de la règle R2 existante de **sept jours** ; aucune nouvelle
  règle d'expiration globale. Ni nouveau cron, ni changement de budget
  des collectes rosters/\`game\`, ni modification d'OAuth ou de la Web-app.
- Sous \`/admin\` : bouton de capture à l'unité, choix du compte OAuth
  existant, sélection explicite d'un membre partageant, consultation
  des archives R2 indépendamment d'appels Scopely.

## À valider avant de considérer la nouvelle couverture opérationnelle

1. Déployer **après merge** puis visiter \`/admin\` authentifié.
2. Choisir un seul compte OAuth personnel ; tester d'abord
   \`personal-squads\`. Consigner **uniquement** l'état, le nombre
   de pages et le total d'entrées (ne jamais partager les JSON privés).
3. Tester \`personal-inventory\`, \`personal-wishlist\`, \`personal-events\`
   séparément. Un 403/464 reste un refus, ne pas contourner.
4. Charger l'effectif actuel et tester au plus un membre avec partage
   actif sur \`shared-member-squads\`. Valider en direct que le résultat
   n'est pas une réponse vide / incomplète attribuée par erreur.
5. Contrôler le bilan \`GET\` R2 ; sur une réponse archivée, les pages
   doivent exister (HEAD vérifiés si disponible).
6. Vérifier les règles d'expiration **réellement en production** sur le
   préfixe parent, le comportement après révocation, puis examiner si
   une collecte périodique est utile. Le merge n'active aucune nouvelle
   collecte automatique.

**Attention :** les captures sont manuelles. Les données des nouveaux
joueurs OAuth seront accessibles en utilisant le même contrat de session,
sans nom de capitaine, de joueur ou d'alliance codé en dur.
