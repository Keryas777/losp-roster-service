# Intégration du planificateur Maddoxx — branche de travail

Cette note décrit l’intégration Maddoxx portée par la branche `work/maddoxx-convergence-ui` de la PR #218. Le service, son moteur et les données personnelles restent hébergés par le Worker existant de `losp-roster-service`.

## Architecture définitive

- Le planificateur Maddoxx, son moteur, ses objectifs et ses lectures personnelles restent sur le Worker Cloudflare existant de `losp-roster-service`, derrière Cloudflare Access et les contrôles propriétaire/session/scope déjà en place.
- `Keryas777/msf` conserve les fonctionnalités communautaires et un lien de navigation propriétaire vers le planificateur. La page Événements publique demeure inchangée pendant cette phase.
- Les deux infrastructures restent indépendantes. Aucune session inter-domaines, aucun ticket temporaire, aucune origine commune, aucun domaine et aucune passerelle Scopely supplémentaire ne sont nécessaires pour cette architecture.
- L’ancienne expérimentation inter-domaines est abandonnée. Son code de test et ses scénarios ne servent pas à l’architecture retenue; aucun mécanisme de sécurité existant n’est retiré.
- Les protections actuelles restent la source d’autorité : Cloudflare Access, identité propriétaire exacte, cookie de session, consentement/grant et scopes. Aucun jeton OAuth Scopely ne sort du Worker.
- Les caches personnels existants gardent leur durée courte et leur portée actuelle. Le planificateur ne crée pas d’historique supplémentaire des données Scopely; les préférences locales existantes ne sont pas transformées en stockage serveur.

## Portage Maddoxx

La logique pure originale est portée dans `public/event-planner/lib/` : classification des lignes, résolution personnages/traits, calcul des actions faisables, leviers du roster, paliers, besoins par ressource, alternatives et registre des stocks/récompenses. Les 29 tests originaux du moteur accompagnent le port. Le catalogue issu du JSON Maddoxx est embarqué dans un module JavaScript statique afin de garder le même moteur utilisable dans le navigateur et le Worker; l’interface a été adaptée en JavaScript natif pour rester compatible avec GitHub Pages et Safari iOS.

Le moteur conserve séparément les données personnelles Scopely et ses projections. Un `soFar`, un score global, un palier réclamé ou une ressource absente ne sont jamais convertis en zéro. Lorsque le score agrégé manque, Maddoxx permet d’afficher la somme des compteurs plafonnés; elle est utilisée comme score de départ uniquement si tous les compteurs distincts sont numériques et elle est étiquetée comme estimation. Une somme partielle reste visible comme telle, sans calcul de palier. Un roster indisponible laisse les conditions liées aux personnages inconnues plutôt que bloquées.

Les relevés personnels de stock ne sont pas archivés par le Worker. Une quantité d’inventaire explicite de `0` est utilisée; une ressource absente de la réponse reste inconnue. Quand les compteurs Scopely nécessaires au registre sont incomplets, seule la dernière déclaration locale est utilisée et l’interface indique que l’estimation des dépenses est indisponible.

## Données lues

| Lecture | Usage |
|---|---|
| `/player/v1/events` en anglais et en français | événements actifs et libellés; pagination complète |
| `/player/v1/events/{eventId}` en anglais et en français | scoring, brackets, récompenses et détail de l’événement sélectionné |
| `/player/v1/roster` | exigences par personnage, traits et leviers |
| `/player/v1/inventory` pour `CONSUMABLE` et `ISOITEM` | stock connu lorsque Scopely renvoie une quantité explicite |

La liste conserve la classification de tous les événements actifs. Les calculs Maddoxx sont appliqués aux événements à jalons avec scoring; la page publique LoSP conserve ses fiches et regroupements existants pour les autres types.

Les scopes manquants sont signalés. L’interface propose la réautorisation par le parcours capitaine existant avec un marqueur de retour à durée limitée, lié au même état OAuth. Aucun chemin de retour fourni par le navigateur n’est accepté librement.

## Validation effectuée

Les fixtures de test sont synthétiques. Les tests vérifient le moteur original, les valeurs manquantes/partielles, les paliers, le roster indisponible, la pagination, l’inventaire incrémental et la réponse `344`, l’isolation par session, l’accès anonyme et inter-origine, le service de la page privée, le retour OAuth et le parcours mobile de l’interface.

Les workflows GitHub Actions valident les adaptations, les profils d’accès et les navigateurs Chromium/WebKit sur un viewport mobile. Sur `main` au SHA `5af430a10cd636badb0f18d9055e44693a96ef90`, la suite générale du Worker échoue déjà sur 15 tests sur 897 (collecteurs, budgets, fixtures temporelles R2 et accès de roster R2). Le même ensemble de 15 échecs apparaît sur la branche; les tests du planificateur passent séparément.

Aucun appel en direct à un compte Scopely n’a été fait. Les formes des données réelles accessibles dans les archives et les scopes déjà déclarés sont documentées dans `personal-event-progress-v1.md`, mais les réponses personnelles d’événement, roster et inventaire n’ont pas été revalidées en direct dans cette PR.

## Exploitation et périmètre

La PR reste en brouillon et n’est ni fusionnée ni déployée. Après validation explicite, l’exploitation continue via le Worker et les workflows de publication contrôlés déjà existants. Aucun nouveau Worker, cron, endpoint de collecte ou déploiement n’est créé par la phase 1.

Dans `Keryas777/msf`, seul le lien de navigation propriétaire est conservé. La page Événements publique et son comportement pour les membres ne sont pas modifiés dans ce chantier.

## Restauration rapide

La migration de classe Durable Object est additive. Après son déploiement, Cloudflare n’autorise pas le retour à une version située avant cette migration. En cas de problème, déployer par le workflow contrôlé un commit fail-closed qui conserve le binding et la migration avec `EVENT_PLANNER_ENABLED` à `false`; les routes personnelles du planificateur et les alias progressions répondent alors `404`. Le contrôle du workflow accepte ces deux états du drapeau pour permettre cette restauration. Pour la page GitHub Pages, rétablir le commit précédant la PR #730 par un commit de revert et attendre la publication Pages.


## Lien propriétaire depuis MSF

Le dépôt `msf` fournit uniquement un lien propriétaire vers la page du planificateur hébergée sur le Worker existant. Le lien transmet l’identifiant stable de l’événement selon le parcours déjà contrôlé; il ne transporte aucun jeton ni donnée personnelle.

Cette navigation entre deux pages existantes est la décision définitive pour cette phase. La migration de la page Événements publique, son éventuelle convergence graphique et une page unique relèvent de phases ultérieures.

## Périmètre de cette passe et limites à traiter avant ouverture aux membres

- Le calcul Maddoxx et ses classifieurs ne sont pas modifiés. Les libellés français Scopely restent prioritaires; lorsque la traduction manque, les actions courantes (connexion, combats par mode, dépenses et prérequis du roster) ont une formulation française construite à partir des champs structurés. Les cas non reconnus restent signalés comme à vérifier sans exposer les codes internes.
- Les actions sont regroupées par personnage avec un portrait unique, progression en barre uniquement lorsque Scopely fournit un compteur exploitable, et sections repliables pour les actions terminées. Le score d’événement et les paliers continuent d’utiliser leurs champs Scopely séparés.
- L’inventaire est filtrable par famille et par texte, replié par famille sur les grands volumes; un identifiant technique n’est visible qu’à l’ouverture de son détail. Les quantités absentes restent « Quantité indisponible ». Les métadonnées réellement livrées par l’inventaire ne suffisent pas à reconstituer les catégories ISO-8 couleur/niveau/classe/statistique; la vue les regroupe donc seulement selon la famille retournée. Les noms français inconnus restent génériques plutôt que d’afficher un texte anglais ou un ID comme nom.
- Les correspondances XPLVL20/40/60 n’ont pas été retrouvées dans les référentiels versionnés examinés; elles ne sont pas ajoutées par déduction. Un catalogue central partagé d’objets, alimenté depuis les définitions publiques /game/v1/items/{itemId} et livré depuis le dépôt msf, reste à préparer lorsqu’une source complète versionnée sera disponible.
- La persistance des ressources déclarées et des événements ignorés reste dans la clé locale existante du navigateur. Le planificateur étant encore propriétaire uniquement, cette passe ne migre pas les données vers un stockage par compte. Avant ouverture à plusieurs capitaines/joueurs, il faudra scoper ces préférences par identité de compte stable côté service; le statut actuel n’expose pas une telle identité et aucune requête Scopely supplémentaire n’est ajoutée ici.
- Les tests navigateur utilisent des réponses Scopely anonymisées/simulées. Ils vérifient le routage réel des imports de Worker déjà couvert par la PR #217, le deep-link filtré, l’interface, les valeurs nulles/absentes, les quatre onglets et les styles LoSP chargés depuis la page publique. Ils ne revalident pas les données personnelles réelles de l’administrateur.
## Reprise de finalisation (PR #218)

### Données de session dans le navigateur

GET /admin/api/event-planner?resource=status renvoie maintenant un identifiant local opaque calculé à partir du cookie capitaine aléatoire, sous forme SHA-256. Il ne contient ni le cookie, ni un identifiant joueur, ni un jeton OAuth. Le navigateur ne lit les réglages locaux qu’après validation d’une session connectée, et les stocke sous la forme losp-event-planner-v1:<namespace>. Les événements ignorés, stocks manuels et historiques ne sont donc plus partagés entre deux sessions capitaine sur le même navigateur. Une déconnexion vide immédiatement les données personnelles en mémoire et arrête les appels personnels. L’ancienne clé globale n’est ni lue ni migrée. Si le capitaine se réauthentifie et reçoit un nouveau cookie, ses déclarations antérieures restent dans l’ancienne partition et ne sont pas restaurées; l’API ne fournit pas d’identifiant de compte stable sans collecte personnelle additionnelle.

### Inventaire compact et langue

- La requête d’inventaire conserve ses deux familles CONSUMABLE / ISOITEM, mais passe lang=fr au lieu de lang=none, comme le permet le manuel LoSP du 5 novembre (pagination, since, lang).
- Le résumé met l’or, les noyaux, les modules d’entraînement et les ions connus avant le détail. Les quatre modules archivés L1–L4 sont traduits en N1–N4; leurs icônes officielles proviennent des définitions publiques. Les ions sont listés par identifiant exact et niveau observé, sans les additionner.
- Le détail des objets reste compact, repliable par famille et consultable par recherche française. L’identifiant brut reste dans un élément « Diagnostic » replié. Une quantité explicite 0 reste zéro; une quantité absente ou un objet non renvoyé reste « Non communiqué ».
- La matrice cristal ISO-8 est volontairement signalée indisponible. L’archive publique consultée a livré des définitions d’ions/monnaies ISO-8, fragments et énergies, mais aucune définition de cristal reliant un ID à la couleur, au niveau, à la classe et à la statistique. Ni les noms d’identifiants ni docs/data/iso-icons.json (icônes de classe) ne suffisent à établir ces propriétés. Aucun cristal n’est classé par supposition.
- Les libellés français proviennent du référentiel central public de msf lorsqu’il est disponible; les noms anglais bruts d’objets inconnus ne sont pas montrés. Les valeurs de stock inconnues ne deviennent jamais zéro.

### Planification et fidélité au moteur

Le port conserve les modules et algorithmes Maddoxx. Dans event-analysis.js, un combat est déjà mutualisé au sein d’un événement entre lignes compatibles partageant personnage + mode, ou trait + mode; les points par combat sont cumulés et le nombre de combats est le maximum nécessaire parmi ces lignes. Le moteur réserve les ressources à partir du stock connu et produit les paliers avec actions/ressources manquantes. La présentation qualifie explicitement la projection de « conditionnelle » et sépare le score acquis des actions gratuites projetées.

La planification demeure sélectionnée événement par événement. Le moteur ne construit pas de calendrier global entre événements; les jours restants ne prouvent pas la disponibilité quotidienne d’un mode, d’une énergie ou d’un nombre de combats. Il ne compte donc pas de gains croisés entre événements, ne mutualise pas des ressources entre plusieurs planifications simultanées et ne présente pas comme garanti un combat dont le calendrier de disponibilité n’est pas donné par Scopely. L’amélioration du roster peut indiquer un levier de points, mais un coût manquant reste inconnu et n’est pas déclaré réalisable.

Le test synthétique Faim mutante reprend désormais les valeurs exactes communiquées : 65 300 acquis + 29 600 conditionnels = 94 900 projetés; le palier 18 à 95 000 reste à 100 points et 100 points demeurent non couverts. Aucun relevé personnel n’a été enregistré.

### Expérience inter-domaines historique — abandonnée

Une ancienne exécution de CI testait les cookies tiers et un ticket simulé entre GitHub Pages et le Worker. Elle a échoué partiellement sous WebKit et ne constituait pas une validation Safari iOS réelle. Cette expérience n’est plus nécessaire avec la décision architecturale actuelle. Aucun ticket applicatif n’est implémenté; ce test est retiré du workflow actif lors de l’actualisation de la PR. Les tests mobiles Chromium/WebKit continuent de couvrir l’interface, sans prétendre valider un appareil Safari réel.


## Phase 1 — actualisation Maddoxx (26 novembre 2026)

### Versions comparées

- planificateur-evenements-2026-11-21(3).zip — SHA-256 `233e9b67efcab7fab5ac2eb53d7c2c82256bb33acca3829655867bb7762d2716`; version qui correspond à l’intégration initiale du 23 novembre (commit `824229edc85a`).
- planificateur-evenements-2026-11-25.zip — SHA-256 `39664f61c9cb22fe19786da96287c1e530267eb25229c24a94c78f7f8f423e84`; 45 fichiers contre 37, dix ajouts et aucun retrait.
- Les modules purs Maddoxx partagés ne changent pas entre les archives. L’original du 25 novembre ajoute la reconnaissance des combats `Play Battles with …`, les cartes `lohub_wrapper`/`lohub_feeder` du poste de commandement, les marqueurs Premium, un plan de combats partagé, et des services/composants d’interface. Le port vanilla LoSP garde ses propres garde-fous contre les valeurs de progression manquantes.
- La logique originale PC identifie les récompenses de chaque ligne via `rewardTier - 1` et sépare les objets `EVTA_META_*` des autres récompenses. Cette règle est comprise dans le code source, mais aucune fixture de détail PC anonymisée et vérifiable n’est fournie par les archives. Cette passe n’affiche donc pas de projection de points/récompenses du PC.
- Les composants React, le serveur Express, les appels supplémentaires à la liste EN/FR et au roster, et le cache fichier durable de l’archive ne sont pas portés. Aucune nouvelle route, persistance Scopely ou dépendance n’est ajoutée.
- Aucun fichier de licence n’a été trouvé dans les ZIP. Aucun module d’origine n’est copié intégralement.

### Modifications appliquées à l’intégration vanilla

Le classificateur accepte désormais `Battle` et `Battles` avec la formulation réelle `Play Battles with …` et un article facultatif. Le marqueur Scopely `isPremium` est préservé à titre informatif; il ne rend pas une action obligatoire ni payante dans l’analyse.

Les séries PC identifiées par le nom, les marqueurs officiels et leur fenêtre de dates sont regroupées sous la carte parent déjà chargée. Les compteurs manquants restent inconnus; aucune série n’est déclarée terminée en l’absence d’un plafond ou d’un compteur fiable. Une série sélectionnée utilise le détail Maddoxx existant à la demande. Le module statique est ajouté à l’allowlist des assets du Worker derrière les contrôles existants. Les séries enfants correspondantes ne sont pas dupliquées dans la liste principale.

### Ressources et données sources

Le catalogue central livré dans la PR #739 contient 15 identifiants : 12 correspondances depuis des définitions publiques officielles et 3 mappings LoSP déjà observés (SC, HC et énergie de campagne). L’état de preuve est explicite; les libellés français internes ne sont pas présentés comme des traductions officielles.

Les archives du client MSF 10.5.0, le manuel API LoSP et la spécification vivante ont été examinés. Aucun identifiant de cristal `ISOITEM_…` exploitable n’a été trouvé dans les trois assets client fournis. Les ions ISO-8 connus restent séparés des cristaux. La matrice cristaux couleur/niveau/classe/statistique et son parseur restent indisponibles jusqu’à l’obtention d’une source vérifiable; aucun stock personnel n’a été relu ou ajouté aux fixtures.

### Validation

- Les tests ciblés locaux de Maddoxx passent 22/22; les tests locaux du catalogue passent 5/5.
- Le workflow Event planner tests #60 passe 119/119 sur le code actuel.
- Le workflow Worker OAuth conserve 15 échecs préexistants identiques au run de référence main #45507035749; aucune régression du planificateur n’y apparaît.
- Le workflow mobile #60 passe sous Chromium et WebKit sur 320, 360, 390 et 430 px, avec un parcours poste de commandement synthétique et sans débordement horizontal. Ce n’est pas une validation réelle sur iPhone Safari. Chromium a produit cinq captures d’interface (Événements, Objectifs, Planifier, Mon stock, poste de commandement) dans l’artefact [maddoxx-planner-mobile-tabs](https://github.com/Keryas777/losp-roster-service/actions/runs/45768126845), SHA `de34dad5f84fb41aeea179efe3d5352523a97255`, conservation jusqu’au 10 décembre 2026.
- Aucun appel personnel Scopely, aucune fusion et aucun déploiement n’ont été effectués.
