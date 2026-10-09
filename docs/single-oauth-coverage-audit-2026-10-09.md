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

## Matrice des routes pertinentes

| GET endpoint | Scope documenté | Paramètres, réponse, pagination et coût | Statut |
|---|---|---|---|
| /player/v1/alliance/card | m3p.f.ar.pro | AllianceCard, lang facultatif ; 1 requête | CONFIRMÉ |
| /player/v1/alliance/members | m3p.f.ar.pro | AllianceMemberInfo[], aucune pagination ; 1 requête | CONFIRMÉ |
| /player/v1/card/member/{memberId} | m3p.{any} | PlayerCard ; membre issu de la liste actualisée ; 1 requête/membre | CONFIRMÉ, 24/24 accessibles |
| /player/v1/alliance/{allianceId}/card | m3p.f.ar.pro | AllianceCard, allianceId temporaire obligatoire ; 1 requête | DOCUMENTÉ — NON TESTÉ ; doublon probable |
| /player/v1/alliance/{allianceId}/members | m3p.f.ar.pro | AllianceMemberInfo[], allianceId temporaire obligatoire ; 1 requête | DOCUMENTÉ — NON TESTÉ ; doublon probable |
| /player/v1/alliance/recruiting/applications | m3p.f.ar.pro | PlayerCard[] avec application conditionnel ; pagination absente ; 1 requête | DOCUMENTÉ — NON TESTÉ |
| /player/v1/recruiting/recruits | m3p.{any} | RecruitInfo[], minTcp/maxTcp/page/perPage facultatifs ; max 100 résultats annoncés ; 1 requête par page | DOCUMENTÉ — NON TESTÉ |
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
