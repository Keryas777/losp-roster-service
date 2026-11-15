# Éligibilité des objectifs du Poste de commandement — audit du 15 novembre 2026

## Décision

**Seule la sélection de l’API privée `/player/v1/events` établit sans équivoque les événements éligibles pour le compte autorisé.** Le catalogue public `/game/v1/events` fournit l’ensemble des définitions et variantes possibles ; il ne doit pas être présenté comme la liste exacte de missions d'un joueur.

**Ne pas attribuer un feeder à un bracket de niveau sur la base de sa date, de sa difficulté, de son nom ou du nombre de ses objectifs.** L’éligibilité des comptes non connectés ne peut pas encore être reconstruite de manière fiable par niveau à partir des seules données publiques inspectées.

## Preuves examinées (lecture seule, données personnelles non publiées)

- Source publique : catalogue Scopely `/game/v1/events`, projeté dans `docs/data/evenements-snapshot.json` de `Keryas777/msf`, et détails officiels déjà archivés dans R2 sous `game-archive/v1/diff/latest`.
- Source privée : **10 captures autorisées** de `/player/v1/events?lang=fr&eventInfo=full`, dans l’archive privée existante `roster-batches/v1/player-extras/*/personal-events/self/`, réalisées entre **2026-11-14 16:52 UTC** et **2026-11-15 02:30 UTC**. Ce sont dix captures, **pas une preuve de dix joueurs indépendants**. Aucun identifiant de session, PID, token, progression ou profil personnel n’est recopié dans ce document.
- Référence visuelle : sept captures du Poste de commandement « Briseur de volontés — Plan de bataille du mois 1 » fournies par l’utilisateur. Les listes quotidiennes, hebdomadaires et mensuelles comptent respectivement **3, 8 et 7** objectifs, terminés ou non.
- Manuel d'API du projet du 5 novembre 2026 : `/player/v1/events` = événements auxquels le compte est éligible, `/game/v1/events` = catalogue général. La présence de `lohub_feeder` ne suffit pas pour déduire une dépendance directe ni une tranche de niveau.

## Résultat : reproduction exacte de la liste visible

Pour chaque capture privée, on filtre les événements dont `startTime <= capturedAt < endTime`, puis les `lohub_feeder` du même événement et le wrapper `lohub_wrapper`. Les **10 captures** aboutissent à la même structure : **un feeder quotidien (3 objectifs), un feeder hebdomadaire (8 objectifs), deux feeders mensuels (6 + 1 objectifs), soit 18**.

Identifiants **publics Scopely** de la série observée, conservés uniquement ici comme exemple de validation, **jamais comme règle métier hardcodée** :

| Période | Feeder(s) présents dans la sélection privée | Conditions |
| --- | --- | --- |
| Quotidien, 14→15 nov. | `6af8c84dfb365c004bfbbb34` | Torche humaine (Jim), Whiplash, Menace (3) |
| Quotidien, 13→14 nov. | `6af776d047f5070146e7b872` | Même famille quotidienne (3) |
| Hebdomadaire, 9→16 nov. | `6af230ccaba9eda13c26a21f` | Battleworld, énergie préhistorique, Ultron/Yellowjacket G19–G21 (8) |
| Mensuel, 2→30 nov. | `6ae8f64d80ca017386467c30` + `6ae8f64d80ca017386467c31` | Terre Sauvage, équipes/alliances de personnages, Cyclope Puissant (6 + 1) |

Le wrapper parent est `6ae8f64d80ca017386467c2d`. Les dates de collecte ont été prises en compte : les captures prises avant et après la réinitialisation du 14 novembre ne gardent pas le même feeder quotidien.

Le catalogue **public** contient simultanément, pour la période étudiée, trois feeders quotidiens, trois hebdomadaires et quatre mensuels portant le même nom. Les variantes supplémentaires sont réelles et contemporaines, pas des missions historiques terminées. Les joindre uniquement par nom/date provoque donc un surnombre.

## Niveau : établi / non établi

**Établi :**
1. La réponse publique détaillée du wrapper offre les brackets `default`, `65_and_up`, `85_and_up`.
2. Les dix réponses privées observées ne présentent, pour ce wrapper, que `85_and_up`. La sélection de quatre feeders correspond exactement à la liste visible en jeu.
3. Les feeders détaillés observés portent chacun un bracket `default`, même lorsque le compte a `85_and_up` dans son wrapper. Aucun champ d’éligibilité de niveau directement exploitable n’a été trouvé dans les champs `EventInfo` consultés.
4. Le champ `feeders` du wrapper est une liste d’identifiants de sous-événements, **pas une table documentée feeder → tranche de niveau** ; sa présence ne constitue pas une preuve d’éligibilité.

**Non établi :**
- L’appartenance exacte des autres feeders aux tranches `default` et `65_and_up`.
- L'exclusivité du niveau comme critère (d'autres règles d'accès peuvent intervenir).
- La généralisation à tous les joueurs de niveau 85+, à partir de captures qui ne prouvent pas l'indépendance des comptes.
- Une relation parent/bracket/feeder stable et exploitable dans le catalogue **public** seul.

Ne pas convertir une simple corrélation de difficultés (« raid », « guerre », « connexion ») en règle de niveau.

## Stratégie de sélection sûre

### Avec OAuth Scopely consenti (exact)

1. Utiliser le scope autorisé `m3p.f.pr.act` et lire `/player/v1/events` avec pagination complète ; conserver la réponse **privée**, sans l'ajouter à GitHub Pages/R2 public.
2. À date de référence égale, conserver les IDs réellement actifs (`startTime <= t < endTime`) et leurs `locationHints` légitimes ; garder les IDs et non les seuls intitulés traduits.
3. Joindre par **identifiant officiel `event.id`** la sélection privée au catalogue public vérifié (points de progression, récompenses, médias, libellés). Les événements absents des données publiques ou les réponses expirées sont des erreurs contrôlées, jamais des prétextes pour élargir la sélection.
4. Ne retourner au navigateur authentifié qu’une réponse minimale (IDs éligibles et métadonnées nécessaires), `Cache-Control: private, no-store`, sans progression, profil, session ni token ; vérifier l'authentification côté Worker, pas via un sélecteur de simulation.
5. Conserver l’application HTML/CSS/JS statique GitHub Pages : ce n’est qu’un appel **optionnel et authentifié** au Worker existant.
6. En cas de scopes manquants, HTTP 401/403/464, absence de session ou capture obsolète, afficher « catalogue officiel — éligibilité personnelle non vérifiée », **pas** « objectifs à réaliser » comme si la sélection était connue.

L’authentification **Discord/LoSP** de `docs/auth-guard.js` n’est pas une authentification Scopely et ne donne aucun droit aux données personnelles d’événements. La présence d’une session captain OAuth dans R2 ne permet pas de faire consulter ses données à tous les visiteurs.

### Sans OAuth Scopely (cohortes à étudier, pas encore une règle)

- Obtenir volontairement des observations avec accès autorisé à `/player/v1/events` et tranche de récompense `default`, puis `65_and_up` (au moins deux comptes indépendants par tranche, idéalement sur deux renouvellements quotidiens/hebdomadaires). Les captures déjà disponibles documentent seulement `85_and_up`.
- Pour chaque tranche/date, contrôler l'identité du wrapper, la durée et la sélection des feeders. Rechercher toute différence intra-tranche avant de déclarer un filtrage par niveau seul.
- Produire au besoin un **résultat agrégé, anonymisé et explicitement autorisé**, horodaté et versionné, puis vérifier chaque renouvellement. Aucun identifiant personnel, aucun état de progression, aucun token dans une projection publique.
- Si les échantillons divergent ou que le niveau ne suffit pas, abandonner le filtrage par niveau au profit du seul mode personnalisé OAuth.

## Garde-fous / critères d'acceptation

- La sélection privée observée au 14/15 novembre compte exactement **3 + 8 + 7 = 18** tâches pour le wrapper étudié, avec correspondance d’IDs ; les missions achevées restent sélectionnées lorsqu'elles appartiennent à l'événement actif.
- Les feeders expirés ne sont pas affichés après `endTime`, même s'ils demeurent dans le résultat privé.
- Les variantes publiques non éligibles ne sont pas masquées/supprimées **globalement** du catalogue.
- Les points de progression `scoring` ne sont pas confondus avec les récompenses `milestone.brackets[].objective.tiers[].rewards`.
- Le modèle reste dynamique lors des prochains renouvellements ; **aucun ID de mission ni niveau présumé ne doit être hardcodé en production**.
- Aucune réutilisation de données privées consenties pour un affichage public sans autorisation appropriée.
- Aucune modification de `docs/evenements.js` ni du Worker de production par le présent audit.
