# LoSP Roster Service — audit un seul OAuth (2026-10-09)

Source officielle : https://developer.marvelstrikeforce.com/beta/msf-api.json (OpenAPI beta 0.2.1).
État de référence du dépôt : main ecf5d8048ecb3af2c0ba519e905ed9a7695251d9.

## Méthode et statuts

- CONFIRMÉ : succès réel rapporté après test Scopely. La présence d'un champ ne garantit pas sa valeur métier.
- DOCUMENTÉ — NON TESTÉ : déclaré dans l'OpenAPI sans résultat live.
- REFUSÉ : code HTTP réellement observé.
- NON DISPONIBLE : aucun endpoint collectif de lecture documenté.
- HORS PÉRIMÈTRE : OAuth individuel, écriture, ou World Warrior désormais supprimé.
- Aucune simulation CI ne vaut test d'autorisation réel. Aucune nouvelle requête Scopely n'a été effectuée pour ce rapport.
- Les IDs de membres et d'alliance sont temporaires et changent lors d'une entrée/sortie de membre.
- m3p.{any} signifie un token joueur valide, pas un droit universel sur tous les joueurs.

## Retour réel iPhone du 9 octobre 2026 — `/login/coverage-test`

**Source de preuve : six captures de la page temporaire du Worker transmise par le responsable d'alliance après OAuth réel.** Statut de la page : `complete`. Les cinq GET du diagnostic ont répondu **HTTP 200**. Ce sont des succès live et non des simulations CI.

| Rubrique | Observation | Portée de la preuve |
|---|---|---|
| alliance | 200, 0 propriété de premier niveau non reconnue | Un AllianceCard réel, types vérifiés, pas validation métier de toutes les valeurs |
| members | 200, tableau de 24 entrées, 0 propriété additionnelle sur l'entrée examinée | Un AllianceMemberInfo examiné en détail, pas 24 structures inspectées |
| player | 200, 1 propriété de premier niveau non reconnue par le diagnostic | Un PlayerCard d'un coéquipier, valeur du champ supplémentaire non révélée |
| applications | 200, tableau vide (0 entrée) | **Accès confirmé**, structure d'une candidature non testable sur liste vide |
| recruits | 200, première page demandée `page=1&perPage=1` vide (0 entrée) | **Accès confirmé**, structure d'un RecruitInfo non testable |

**Détails AllianceCard observés :**

- Type conforme : id, name, icon, frame, level, level.completedTier, level.goalTier, description, type, demoteDays, kickDays, warZone, warLeague, warLeague.id, warLeague.name, warTrophies, warRank, raidRank, style, tcp, avgTcp, count.
- Absent : level.progress, managementRank, discordUrl, qualifications.tcp, qualifications.lang.
- `ad` : null (distinct d'absent).
- `qualifications` : objet conforme ; `qualifications.custom` et `qualifications.raids` : tableaux conformes. Ceci ne confirme pas qu'ils contiennent des entrées.

**Détails AllianceMemberInfo / première carte dans la liste :**

- Type conforme : id, rank, isSelf, card, card.name, card.icon, card.frame, card.level, card.level.completedTier, card.level.goalTier, card.tcp, card.stp, card.warMvp, card.charactersCollected, card.rosterShare, **card.daysInAlliance**.
- Absent : card.level.progress.

**Détails PlayerCard d'un seul coéquipier :**

- Types conformes : name, icon, frame, level, level.completedTier, level.goalTier, tcp, stp, warMvp, charactersCollected, charactersAtMaxStarRank, latestArena, latestBlitz, blitzWins, qualifications, qualifications.lang, qualifications.style.
- Absents : level.progress, bestArena, application, qualifications.avgTcp, qualifications.warZone, qualifications.warLeague, qualifications.raids.
- Null : ad.
- **Élucidé quant au type, mais pas à la valeur métier** : un second diagnostic réel confirme `rosterShare` de type `string` et `aid` de type `number` sur un `PlayerCard` de coéquipier ; l'ancien `type-invalid` venait des types attendus par le validateur (respectivement booléen et chaîne). OpenAPI PlayerCard prévoit `rosterShare` comme union booléen / `RosterShareState`, même si pour les cartes d'autrui le booléen est documenté ; `aid` référence l'identifiant d'alliance décrit comme chaîne.
- La propriété supplémentaire comptabilisée (1) **n'est pas identifiée** ; le diagnostic complémentaire montre explicitement que `wwPoints` est absent de l'échantillon. Ne pas réactiver World Warrior.

**Économie d'appels :** aucune raison de refaire 24 fiches. Ne pas relancer l'audit de cinq requêtes pour confirmer les cinq HTTP 200. Si un besoin concret justifie de résoudre `rosterShare`, `aid` et le champ supplémentaire, privilégier une unique lecture supplémentaire d'une carte membre, après actualisation de son ID via `alliance/members` (2 requêtes GET maximum) ; afficher seulement le type JSON exact, et éventuellement un nom de propriété non sensible, jamais une valeur ou un ID.

## Retour réel iPhone du 9 octobre 2026 — `/login/card-types-test`

Source : capture d'écran fournie après authentification OAuth et test ponctuel exécuté depuis l'iPhone. `Statut : ok` ; le code de la route correspond à une lecture réussie de la liste des membres puis d'un seul `PlayerCard` pour un autre membre partageant. Le résultat ne présente pas les codes HTTP exacts des deux réponses : **ne pas inventer HTTP 200 pour ce nouveau test**. Les précédentes campagnes avaient déjà confirmé les deux endpoints en HTTP 200.

| Champ `PlayerCard` | Type JSON réel | Portée de la confirmation |
|---|---|---|
| `rosterShare` | `string` | Observé sur une fiche de coéquipier, **pas** un booléen ; la chaîne exacte et sa signification métier restent inconnues |
| `aid` | `number` | Observé sur une fiche de coéquipier, contrairement au type `string` attendu par l'ancien validateur ; valeur et format métier non contrôlés |
| `wwPoints` | absent | Champ historique non renvoyé sur cette fiche ; World Warrior reste **hors périmètre** |
| Propriétés supplémentaires inconnues | 1 | Une propriété non reconnue demeure ; son nom et sa valeur ont volontairement été masqués, donc **aucune identification possible** depuis la capture |

**Conséquence technique :** `AllianceMemberCard.card.rosterShare` a été observé comme booléen, mais `PlayerCard.rosterShare` est ici une chaîne. Ne pas fusionner ces représentations ni convertir aveuglément la chaîne en booléen. `aid` peut être un nombre : ne pas supposer une chaîne ni utiliser un identifiant entier non validé. Les contrôles de `coverage-test.js` sont des attentes documentaires strictes ; leurs `type-invalid` précédents résultaient de cette différence, et **ne prouvaient pas un refus API**.

**Propriété inconnue :** le champ restant n'est pas `wwPoints` sur cette fiche. Un nouvel appel n'est pas justifié tant que son intérêt fonctionnel pour LoSP n'est pas démontré ; si une investigation devient nécessaire, filtrer strictement les noms que l'on accepte de rendre visibles et ne jamais afficher de valeurs, d'identifiants ou de clés arbitraires.

**Ce qui reste à vérifier avant exploitation métier :** signification de la chaîne `rosterShare`, format exploitable de `aid`, cohérence temporelle et métier de `tcp`, `stp`, `warMvp`, `daysInAlliance`, `latestArena` et `latestBlitz`. Aucun nouveau GET Scopely n'a été effectué pour cette mise à jour de documentation.


## Audit sémantique des statistiques — 9 octobre 2026

**Source de définitions** : [OpenAPI beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json), schémas `PlayerCard`, `AllianceMemberCard`, `AllianceCard` et `SimpleProgress`. Ces descriptions indiquent le sens *annoncé* par Scopely, pas l'exactitude indépendante des valeurs à un instant donné.

| Champ | Signification documentée | Couverture constatée | Validation métier |
|---|---|---|---|
| `tcp` | Total collection power | Champs réels membres, joueur et alliance | Compare somme de la liste et TCP de l'alliance, puis TCP de l'auto-carte |
| `stp` | Strongest team power | Liste et PlayerCard présents | Compare uniquement la propre fiche, vérifie STP <= TCP à titre indicatif |
| `warMvp` | Nombre historique de distinctions MVP de guerre | Liste et PlayerCard présents | Comparaison des deux cartes du compte connecté ; **non limité à la saison** |
| `daysInAlliance` | Nombre de jours dans l'alliance | `AllianceMemberCard` présent, type entier | Valeur individuelle de la seule ligne `isSelf` à confronter au jeu ; pas date d'entrée calculable |
| `charactersCollected` | Total de personnages débloqués | Liste et PlayerCard présents | Comparaison de la carte du compte connecté |
| `latestArena` | Dernier rang Arène | PlayerCard présent | À comparer avec la valeur affichée dans MSF ; aucune borne universelle inventée |
| `latestBlitz` | Dernier rang Blitz | PlayerCard présent | À comparer au classement du dernier Blitz pertinent ; aucune hypothèse sur l'événement |
| `blitzWins` | Nombre cumulé de victoires Blitz | PlayerCard présent | À confronter au profil MSF |
| `bestArena` | Meilleur rang historique en arène | Absent sur les 24 cartes de Zeus lors du test précédent | **Non exploitable à ce stade**, absence ≠ zéro |
| `level.completedTier` | Dernier palier atteint | Présent | Niveau de commandant du compte connecté, comparaison cartes |
| `level.goalTier` | Prochain palier en cours | Présent | Peut être testé sans assimiler à un niveau déjà atteint |

**Important — correction documentaire de l'ancien diagnostic :** le schéma officiel `SimpleProgress` prévoit `completedTier`, `goalTier`, `points`, `goal`. Le champ `level.progress` utilisé par `coverage-test.js` **n'appartient pas à ce schéma** : son absence relevée précédemment n'est pas une anomalie Scopely et ne donne aucune information sur `level.points`/`level.goal`. Le Worker de la campagne ancienne n'a pas été retouché par cet audit.

**Important — limites OpenAPI :** certains champs de puissance sont déclarés `int32`, malgré le TCP total de Zeus observé à **10 381 253 767**, supérieur au maximum `int32`. L'application doit accepter les entiers JSON non négatifs dans la plage sûre JavaScript, sans tronquer à 32 bits. Les types décrits ne garantissent ni la mise à jour atomique ni l'absence de champs facultatifs.

**Premier recoupement déjà possible sans requête :** sur la fiche réelle précédente de Zeus, `avgTcp = 432 552 240` et `count = 24`, d'où `avgTcp × count = 10 381 253 760`, à **7 points** du `tcp = 10 381 253 767`. La cohérence est compatible avec l'arrondi d'une moyenne entière, mais ne vérifie pas à elle seule les 24 TCP.

**Vérification minimale préparée, non encore testée en production :** `/login/metrics-test` effectue au plus trois lectures séquentielles de **la même alliance et du compte connecté** (alliance/card, alliance/members, card personnelle). Il compare les agrégats et les champs communs sans divulguer les données individuelles d'autres joueurs. Les valeurs affichées pour le compte connecté doivent être confrontées volontairement aux valeurs visibles dans MSF avant de qualifier une statistique de métier « vérifiée ». Une comparaison `identique` entre deux réponses API n'est **pas** une confirmation indépendante de la valeur.

**Limites non résolues** : la fraîcheur des données Scopely n'est pas garantie ; `daysInAlliance` ne révèle pas la date d'entrée historique et peut réinitialiser après un retour dans l'alliance ; la définition du « dernier » rang Arena/Blitz ne précise pas explicitement la fenêtre d'actualisation. Ne pas en déduire une période ou une saison absente de la documentation.


## Matrice des routes pertinentes

| GET endpoint | Scope documenté | Paramètres, réponse, pagination et coût | Statut |
|---|---|---|---|
| /player/v1/alliance/card | m3p.f.ar.pro | AllianceCard, lang facultatif ; 1 requête | CONFIRMÉ |
| /player/v1/alliance/members | m3p.f.ar.pro | AllianceMemberInfo[], aucune pagination ; 1 requête | CONFIRMÉ |
| /player/v1/card/member/{memberId} | m3p.{any} | PlayerCard ; membre issu de la liste actualisée ; 1 requête/membre | CONFIRMÉ, 24/24 accessibles |
| /player/v1/alliance/{allianceId}/card | m3p.f.ar.pro | AllianceCard, allianceId temporaire obligatoire ; 1 requête | DOCUMENTÉ — NON TESTÉ ; doublon probable |
| /player/v1/alliance/{allianceId}/members | m3p.f.ar.pro | AllianceMemberInfo[], allianceId temporaire obligatoire ; 1 requête | DOCUMENTÉ — NON TESTÉ ; doublon probable |
| /player/v1/alliance/recruiting/applications | m3p.f.ar.pro | PlayerCard[] avec application conditionnel ; pagination absente ; 1 requête | CONFIRMÉ HTTP 200, 0 candidature ; contenu non validé |
| /player/v1/recruiting/recruits | m3p.{any} | RecruitInfo[], minTcp/maxTcp/page/perPage facultatifs ; max 100 résultats annoncés ; 1 requête par page | CONFIRMÉ HTTP 200, 0 sur page 1 ; contenu non validé |
| /player/v1/recruiting/recruits/{recruitId} | m3p.{any} | RecruitInfo, identifiant temporaire obligatoire ; 1 requête | DOCUMENTÉ — NON TESTÉ |
| /player/v1/alliance/recruiting/recruiters | scope non précisé | AllianceCard[], filtres langs/raids/search ; pagination à vérifier | DOCUMENTÉ — NON TESTÉ, autres alliances hors audit |
| /player/v1/card/applicant/{applicantId} | m3p.{any} | PlayerCard pour candidat connu ; 1 requête | DOCUMENTÉ — NON TESTÉ |
| /player/v1/card/requester/{requesterId} | m3p.{any} | PlayerCard pour demandeur connu ; 1 requête | DOCUMENTÉ — NON TESTÉ |
| /player/v1/applicant/applicants | scope non précisé | PlayerCard[], pagination non décrite | DOCUMENTÉ — NON TESTÉ ; recouvrement applications |
| /player/v1/roster/member/{memberId} | m3p.f.ar.ros | CharacterInstance[], lang/statsFormat/charInfo/charWar/since/page/perPage ; 1+ requêtes par membre | REFUSÉ HTTP 403 sur un coéquipier partageant |
| /player/v1/squads/member/{memberId} | m3p.f.ar.ros | SquadsInfo[], since facultatif ; 1 requête/membre | DOCUMENTÉ — NON TESTÉ, même scope problématique |
| /player/v1/roster/applicant/{applicantId} | m3p.{any} | CharacterInstance[], pagination ; 1+ requêtes/candidat | DOCUMENTÉ — NON TESTÉ, candidat seulement |
| /player/v1/squads/applicant/{applicantId} | m3p.{any} | SquadsInfo[], since ; 1 requête/candidat | DOCUMENTÉ — NON TESTÉ |
| /player/v1/roster/requester/{requesterId} | m3p.{any} | CharacterInstance[], pagination ; 1+ requêtes/demandeur | DOCUMENTÉ — NON TESTÉ |
| /player/v1/squads/requester/{requesterId} | m3p.{any} | SquadsInfo[], since ; 1 requête/demandeur | DOCUMENTÉ — NON TESTÉ |

### Personnel uniquement, pas une autorisation collective

| GET endpoint | Scope | Observation et décision |
|---|---|---|
| /player/v1/card | m3p.f.pr.pro | CONFIRMÉ sur Keryas I |
| /player/v1/roster | m3p.f.pr.ros | CONFIRMÉ sur Keryas I, pas de portée collective |
| /player/v1/squads | m3p.f.pr.ros | DOCUMENTÉ — NON TESTÉ, HORS PÉRIMÈTRE collectif |
| /player/v1/inventory | m3p.f.pr.inv | Test éphémère préparé, HORS PÉRIMÈTRE collectif |
| /player/v1/events | m3p.f.pr.act | HORS PÉRIMÈTRE collectif |
| /player/v1/invites | scope non précisé | HORS PÉRIMÈTRE collectif, invitations personnelles |

Les endpoints /game/v1/... sont des données générales du jeu, pas des rosters ou inventaires privés. GET /game/v1/scopes est un catalogue, pas une permission nouvelle. Aucune route de lecture de l'inventaire d'un coéquipier n'est documentée. POST et DELETE sont exclus de cette campagne de lecture.

## Schémas officiels et preuves

### AllianceCard

- Identité : id, name, icon, frame, level.
- Gestion : description, type, managementRank, demoteDays, kickDays, warZone, style, discordUrl.
- Guerre/raid : warLeague.id, warLeague.name, warTrophies, warRank, raidRank.
- Collectif : count, tcp, avgTcp.
- Recrutement : ad.id, ad.exp, qualifications.tcp, qualifications.lang, qualifications.custom[].text, qualifications.raids[].id/groupId/name/difficulty/completion.
- Exclure wwTier et qualifications.wwPoints (World Warrior).
- CONFIRMÉ, Zeus : count 24, warLeague DIAMOND II, warRank 201, raidRank 33, warTrophies 2649, tcp 10381253767, avgTcp 432552240.
- Les autres propriétés et leurs valeurs imbriquées n'étaient pas systématiquement contrôlées.
- ATTENTION : l'OpenAPI décrit par erreur warRank comme raid rank ; l'observation réelle distingue classement de saison de guerre (warRank) et raid (raidRank).

### AllianceMemberInfo / AllianceMemberCard

- Entrée : id temporaire, rank (leader/captain/member), isSelf, card.
- card : name, icon, frame, level, tcp, stp, warMvp, charactersCollected, rosterShare, daysInAlliance.
- CONFIRMÉ : 24 membres, 23 autres membres rosterShare=true, compte connecté isSelf.
- À vérifier : rank, daysInAlliance, level imbriqué, valeurs chiffrées, champs réellement absents et null.

### PlayerCard

- Identité : name, icon, frame, level.
- Puissance/stats : tcp, stp, warMvp, charactersCollected, charactersAtMaxStarRank, bestArena, latestArena, latestBlitz, blitzWins.
- Partage : rosterShare booléen pour autrui ; RosterShareState complet possible pour son propre compte.
- Compléments conditionnels : application.id/message/expiration, aid, ad.id/exp, qualifications.lang/avgTcp/style/warZone/warLeague/raids.
- Exclure wwPoints et qualifications.wwTier (World Warrior).
- CONFIRMÉ : 24/24 fiches accessibles ; 13 champs de base présents sur 24/24, bestArena absent de 24/24.
- Les valeurs métier, les propriétés conditionnelles et les structures imbriquées n'ont pas été certifiées.

### Recruitment et équipes

- RecruitInfo : recruitId, ad.tcp/stp/level/lang/timezone, card (PlayerCard), expiration.
- SquadsInfo : tabs.roster/blitz/tower/raids/arena/war/crucible, listes de squads composés de characterIds, et maxSquads.
- Le caractère documenté de ces schémas ne confirme en rien l'accès au roster/squads des 24 membres.

## Codes HTTP, limites et stratégie de test

- Codes publiés selon les routes : 344 UNCHANGED (since sur roster/squads), 404, 422, 464 NO_ACCESS, 472, 474, 500, 552, 553.
- Le Worker traite aussi les HTTP 401, 403, 429 (qui peuvent survenir même s'ils ne sont pas explicitement listés dans les responses OpenAPI).
- Pagination : page 1-indexée, perPage à limiter, since seulement quand pertinent. Une page ne vaut jamais extraction complète.
- Refaire 24 fiches coûterait 1 members + 24 card/member (+1 card alliance) = 25 à 26 requêtes : inutile, déjà fait.
- Nouveau diagnostic /login/coverage-test : au plus 5 appels séquentiels avec OAuth existant :
  alliance/card ; alliance/members ; un card/member non-self ; alliance/recruiting/applications ; recruiting/recruits?page=1&perPage=1.
- Arrêt sur 401/429 ; aucun ID soumis par le navigateur ; aucune collecte roster, squads ou inventaire.
- Résultats : codes HTTP exacts, types de champs de premier niveau et imbriqués ; absent, null, type-ok, type-invalid. type-ok n'est PAS une validation métier.
- Données privées, noms, identifiants, messages de recrutement, réponses brutes et tokens jamais envoyés au navigateur ou persistés.
- Un seul membre inspecté : n'extrapoler ni la fréquence d'un champ facultatif ni les données de candidat quand le tableau est vide.

## Décisions et questions ouvertes

1. Demander à Scopely l'obtention officielle du scope m3p.f.ar.ros. Ne pas contourner le refus HTTP 403. Le même scope concerne les squads membre.
2. Confirmer en réel valeurs et structures nested des trois types AllianceCard, AllianceMemberInfo et PlayerCard avec un exemple au lieu de 24.
3. Évaluer les candidatures de l'alliance et la présence de recrues publiques, sans divulgation de profils.
4. Reporter les variantes par allianceId : mêmes schémas/permissions, pas de bénéfice clair qui justifie une collecte supplémentaire.
5. NON DISPONIBLE via la lecture collective documentée : inventaires des 23 autres joueurs, attaques de guerre par joueur, dégâts détaillés de raid et historique de combats.
6. HORS PÉRIMÈTRE : 24 connexions individuelles, World Warrior, synchronisation R2/tokens, architecture dashboard, écriture côté jeu.
7. Conservation future maximum 30 jours et suppression sur retrait de consentement : obligation à intégrer lors de la phase de stockage, pas pendant cet audit ponctuel.

## Test réel après déploiement confirmé

Sur Safari iPhone : https://losp-roster-service.deliriousfan7.workers.dev/login/coverage-test

Recueillir uniquement le nombre de sections, les codes HTTP et les états des champs, jamais les valeurs privées. Une réussite simulée en CI ne change aucun statut documentaire. Toute nouvelle confirmation doit venir du test réel, puis mettre à jour cette matrice.
