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

Le moteur conserve séparément les données personnelles Scopely et ses projections. Un `soFar`, un score global, un palier réclamé ou une ressource absente ne sont jamais convertis en zéro. Lorsque le score agrégé manque, Maddoxx permet d’afficher la somme des compteurs plafonnés; elle est utilisée comme score de départ uniquement si tous les compteurs distincts sont numériques et elle est étiquetée comme estimation. Une somme partielle reste visible comme telle, sans calcul de palier. Une équipe indisponible laisse les conditions liées aux personnages inconnues plutôt que bloquées.

Les relevés personnels de stock ne sont pas archivés par le Worker. Une quantité d’inventaire explicite de `0` est utilisée; une ressource absente de la réponse reste inconnue. Quand les compteurs Scopely nécessaires au registre sont incomplets, seule la dernière déclaration locale est utilisée et l’interface indique que l’estimation des dépenses est indisponible.

## Données lues

| Lecture | Usage |
|---|---|
| `/player/v1/events?lang=fr` | événements actifs en français; 8 pages maximum, arrêt dès la dernière page |
| `/player/v1/events/{eventId}?lang=fr&objRewards=full` | une seule série du poste de commandement sélectionnée; aucune autre fiche détaillée |
| Ressource `roster` du planificateur | lecture directe de la copie privée R2 `connected-personal-rosters/<session-hash>/latest.json` via le helper LoSP existant; copie absente/expirée = équipe inconnue, aucun appel Scopely |
| `/player/v1/inventory` pour `CONSUMABLE` et `ISOITEM` | stock connu lorsque Scopely renvoie une quantité explicite |

La liste conserve la classification de tous les événements actifs. Les calculs Maddoxx sont appliqués aux événements à jalons avec scoring; la page publique LoSP conserve ses fiches et regroupements existants pour les autres types.

Les scopes manquants sont signalés. L’interface propose la réautorisation par le parcours capitaine existant avec un marqueur de retour à durée limitée, lié au même état OAuth. Aucun chemin de retour fourni par le navigateur n’est accepté librement.

## Validation effectuée

Les fixtures de test sont synthétiques. Les tests vérifient le moteur original, les valeurs manquantes/partielles, les paliers, le roster indisponible, la pagination, l’inventaire incrémental et la réponse `344`, l’isolation par session, l’accès anonyme et inter-origine, le service de la page privée, le retour OAuth et le parcours mobile de l’interface.

Les workflows GitHub Actions valident les adaptations, les profils d’accès et les navigateurs Chromium/WebKit sur un viewport mobile. Sur `main` au SHA `5af430a10cd636badb0f18d9055e44693a96ef90`, la suite générale du Worker échoue déjà sur 15 tests sur 897 (collecteurs, budgets, fixtures temporelles R2 et accès de roster R2). Le même ensemble de 15 échecs apparaît sur la branche; les tests du planificateur passent séparément.

Aucun nouvel appel personnel Scopely n’est déclenché par cette correction. Les données observées lors de la validation propriétaire du 26 novembre servent à corriger la lecture du cache existant; les ID bruts non accessibles ne sont pas extrapolés.

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
- Les correspondances XPLVL20/40/60 n’ont pas été retrouvées dans les référentiels versionnés examinés; elles ne sont pas ajoutées par déduction. Le catalogue central statique du dépôt `msf` est embarqué dans les assets allowlistés du Worker pour rester disponible sans publication simultanée de GitHub Pages. Les référentiels personnage/traits et le calendrier déjà publiés continuent d’être lus depuis MSF; aucune donnée personnelle n’y est déplacée.
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
- Les libellés français viennent du catalogue statique embarqué lorsqu’ils sont disponibles; les noms anglais bruts d’objets inconnus ne sont pas montrés. Les identifiants et compteurs de reconnaissance restent dans les détails « Diagnostic administrateur », sur cette route protégée. Les valeurs de stock inconnues ne deviennent jamais zéro.

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
- Aucun fichier de licence n’a été trouvé dans les ZIP. Aucun module d’origine n’est copié intégralement. L’autorisation écrite de l’auteur pour l’adaptation n’a pas été retrouvée dans le projet ou la discussion GitHub; ce point doit être confirmé avant tout déploiement.

### Modifications appliquées à l’intégration vanilla

Le classificateur accepte désormais `Battle` et `Battles` avec la formulation réelle `Play Battles with …` et un article facultatif. Le marqueur Scopely `isPremium` est préservé à titre informatif; il ne rend pas une action obligatoire ni payante dans l’analyse.

Les séries PC identifiées par le nom, les marqueurs officiels et leur fenêtre de dates sont regroupées sous la carte parent déjà chargée. Les compteurs manquants restent inconnus; aucune série n’est déclarée terminée en l’absence d’un plafond ou d’un compteur fiable. Une série sélectionnée utilise le détail Maddoxx existant à la demande. Le module statique est ajouté à l’allowlist des assets du Worker derrière les contrôles existants. Les séries enfants correspondantes ne sont pas dupliquées dans la liste principale.

### Ressources et données sources

Le catalogue central livré dans la PR #739 contient 15 identifiants : 12 correspondances depuis des définitions publiques officielles et 3 mappings LoSP déjà observés (SC, HC et énergie de campagne). Le fichier JSON est embarqué comme asset statique sur la branche Worker; ses libellés français internes ne sont pas présentés comme des traductions officielles.

Les archives du client MSF 10.5.0, le manuel API LoSP et la spécification vivante ont été examinés. Aucun identifiant de cristal `ISOITEM_…` exploitable n’a été trouvé dans les trois assets client fournis. Les ions ISO-8 connus restent séparés des cristaux. La matrice cristaux couleur/niveau/classe/statistique et son parseur restent indisponibles jusqu’à l’obtention d’une source vérifiable; aucun stock personnel n’a été relu ou ajouté aux fixtures.

### Validation

- Les tests ciblés locaux de Maddoxx passent 22/22; les tests locaux du catalogue passent 5/5.
- Le workflow Event planner tests #60 passe 119/119 sur le code actuel.
- Le workflow Worker OAuth conserve 15 échecs préexistants identiques au run de référence main #45507035749; aucune régression du planificateur n’y apparaît.
- Le workflow mobile #60 passe sous Chromium et WebKit sur 320, 360, 390 et 430 px, avec un parcours poste de commandement synthétique et sans débordement horizontal. Ce n’est pas une validation réelle sur iPhone Safari. Chromium a produit cinq captures d’interface (Événements, Objectifs, Planifier, Mon stock, poste de commandement) dans l’artefact [maddoxx-planner-mobile-tabs](https://github.com/Keryas777/losp-roster-service/actions/runs/45768126845), SHA `de34dad5f84fb41aeea179efe3d5352523a97255`, conservation jusqu’au 10 décembre 2026.
- Aucun appel personnel Scopely, aucune fusion et aucun déploiement n’ont été effectués.


## Correspondances LoSP / Maddoxx et matrice des cristaux ISO-8 — 26 novembre 2026

Méthode : réutiliser les structures LoSP, faire correspondre les formats, ajouter un adaptateur uniquement à leur frontière.

- Les personnages, IDs, noms, portraits et traits restent fournis par le catalogue LoSP déjà chargé par l’écran; `event-analysis.js` réutilise `createSubjectResolver`, `classifyObjective`, `RESOURCES` et `planEvent` depuis `lib/index.js`. Aucune copie de référentiel personnage n’est ajoutée.
- L’importeur LoSP `scripts/lib/roster-r2-import.mjs` normalise les champs de roster et le CSV ISO du fournisseur vers les cinq classes ISO de combat. `docs/evolution-visuals.js` réutilise la même conversion du niveau continu 1–20 vers quatre couleurs et niveaux 1–5. Ces fichiers MSF sont des références auditées, pas des dépendances runtime : les deux dépôts restent déployables indépendamment.
- Ces structures couvrent la classe ISO attribuée et son niveau, mais ne contiennent pas les quantités d’inventaire des cristaux. L’adaptateur Worker `public/event-planner/lib/iso-crystals.js` traite donc séparément les IDs ISOITEM. Il distingue les classes de personnages des classes ISO de combat.
- Le parseur valide strictement le motif ISOITEM_{GREEN|BLUE|PURPLE|ORANGE}_{BRAWLER|BLASTER|CONTROLLER|PROTECTOR|SUPPORT}_{HEALTH|DAMAGE|ARMOR|FOCUS|RESIST}_{1..5}. Les termes français viennent du vocabulaire confirmé par le propriétaire. À cette date, un seul ID de cristal concret est attesté : `ISOITEM_GREEN_SUPPORT_HEALTH_1`. Les autres combinaisons acceptées sont signalées « déduites de la nomenclature », pas observées dans un inventaire ni confirmées individuellement par Scopely.
- Le modèle conserve l’identifiant original et expose palier, couleur, classe personnage, catégorie et niveau. Les composants inconnus ou hors motif restent consultables comme non classifiés. Une quantité entière numérique ou textuelle est normalisée; une valeur manquante/ambiguë reste inconnue. Les IDs dupliqués, y compris avec casse différente, ne sont pas additionnés deux fois; les quantités contradictoires rendent la cellule inconnue.
- La matrice est construite par le même module pur utilisé par le moteur et l’interface : sélection P1–P4 et niveaux 1–5, cinq classes personnage par cinq catégories, état « inconnu » séparé de zéro explicite, diagnostics des IDs non classifiés et des doublons conflictuels. Les cases absentes restent inconnues; le module ne conclut pas qu’un stock manquant vaut zéro.
- Le cas propriétaire Tireur/P4/niveau 1 (Vie 16, Dégâts 26, Armure 17, Focalisation 42, Résistance 16, total 117) est une fixture synthétique de règle métier. Les cinq IDs orange associés à cette fixture ne sont pas comptés comme des IDs réellement observés.
- Les 15 entrées du catalogue central de la PR #739 sont un catalogue de ressources déjà identifiées (12 définitions publiques officielles, 3 correspondances historiques LoSP), et non 15 items rencontrés dans un inventaire. Aucun inventaire personnel réel n’a été consulté pendant cette passe : identifiants rencontrés = 1, cristal concret identifié = 1 observé, 0 IDs supplémentaires confirmés par inventaire, autres combinaisons reconnues = dérivées, nombre d’IDs réellement inconnus impossible à établir sans corpus d’inventaire complet.
- Les ions ISO-8 du catalogue sont des monnaies, pas des cristaux. Le coût de fusion, de pose et d’amélioration reste inconnu. Les cinq catégories de cristaux à un niveau requis ne suffisent pas à prouver que la classe ISO de combat est améliorée ni que ses monnaies sont disponibles.

Les tests ciblés couvrent l’exemple observé, les combinaisons dérivées, les identifiants ambigus, les quantités nulles/inconnues/textuelles, la déduplication et la matrice synthétique de 117 cristaux. La capture associée est produite par le parcours navigateur synthétique du workflow « Event planner mobile browsers »; elle ne contient aucune donnée personnelle.


## Validation réelle — prévol contrôlé (26 novembre 2026)

### État avant déploiement

- PR #218 est ouverte, en brouillon, et sa branche était au SHA `719ac67e10549a4aedf584365dc5c0d3c53fdb36`, 66 commits devant `main` et 0 derrière; aucune divergence avec `main` n’a été constatée. Le `wrangler.jsonc` de la branche ne diffère pas de `main`.
- Le Worker actif était le déploiement `8789c2d8-62ab-46e4-81f8-cb8b285aa601`, version 235 (`1706e375-159f-4c7b-9940-0776895a61c2`), créé le 24 novembre 2026 à 23:07 UTC. La cible de restauration immédiate est le déploiement précédent `b69a4a7f-d505-4cd5-845a-efc6ab5062a9`, version 234 (`b3a34398-71ea-4e5b-a7b6-fca9d459478d`).
- Le réglage actif contient déjà le binding R2 `CAPTAIN_BUCKET`, le service `LOSP_AUTH`, les trois namespaces Durable Objects existants, les assets `ASSETS`, les drapeaux actuels et les quatre tâches cron. Seuls les noms/types des secrets ont été vérifiés; aucune valeur secrète n’a été lue. Les versions 234 et 235 possèdent les mêmes 33 bindings, les mêmes trois classes Durable Objects et le même `migration_tag` `personal-event-cache-v1`; les changements du planificateur ne modifient pas `wrangler.jsonc` et n’ajoutent donc pas une migration de classe.
- Le workflow de publication contrôlée reste le mécanisme prévu, avec le SHA complet en entrée. Aucun déploiement n’a encore été lancé. La restauration préparée est la création d’un déploiement pointant à 100 % sur la version 234. Les références 234 et 235 ont des bindings et tags de migration identiques; Cloudflare documente qu’un changement ultérieur du cycle de vie d’une classe Durable Object pourrait empêcher un rollback vers une version antérieure.

### Correction du périmètre des lectures

- Le chargement de la page ne demande plus qu’une liste d’événements en français. Le serveur refuse les lectures personnelles en anglais pour cette passe.
- Le roster est lu depuis la copie privée R2 existante `connected-personal-rosters/.../latest.json`, via l’identifiant de session déjà vérifié et les contrôles Access, propriétaire et scope inchangés. Une copie absente ou expirée renvoie « cache manquant » et ne déclenche pas Scopely.
- Les deux familles d’inventaire restent en français et réutilisent la même promesse en mémoire; l’action d’actualisation de la vue ne force plus un rafraîchissement réseau. Changer d’onglet ou recalculer les relevés ne répète pas d’appel.
- Une fiche détaillée n’est demandée qu’après sélection d’une série du poste de commandement, en français, et une seule fois par onglet de navigateur. Les événements ordinaires utilisent les compteurs disponibles dans la liste.
- Aucun token OAuth ne quitte le Worker. Les réponses restent privées et `no-store`; aucun nouveau stockage serveur, endpoint de collecte, binding, secret, cron ou Worker n’est ajouté.

### Tests et blocage avant déploiement

- La suite ciblée locale du planificateur, de ses API et des parcours personnels passe 128/128. Les vérifications syntaxiques Node et `git diff --check` passent.
- Les tests navigateur locaux n’ont pas pu démarrer : les binaires Playwright Chromium/WebKit étaient absents; le téléchargement Playwright a reçu HTTP 403. Les dernières exécutions CI avant cette correction restent vertes, mais le parcours Chromium/WebKit après correction doit être confirmé par GitHub Actions. Aucun test réel sur iPhone Safari n’a été fait.
- Les contrôles Worker OAuth antérieurs restent à 897/912; les 15 échecs correspondent à la même baseline `main` (collecte invitée/tardive, enqueues DD9, budgets et accès R2). Aucun test Maddoxx n’échouait sur le head antérieur.
- À la date de cet examen, les archives des 21 et 25 novembre ne contenaient pas de licence et les sources alors consultées ne documentaient pas d’autorisation. Le propriétaire a depuis confirmé directement avoir reçu de Maddoxx l’autorisation d’utiliser, adapter et intégrer son travail dans LoSP. Cette collaboration est créditée ici; les captures privées et les ZIP originaux ne sont pas publiés. La redistribution publique autonome de ses sources n’a pas été établie et n’est pas revendiquée.
- Aucun appel personnel Scopely n’a été effectué à ce stade. La session Cloudflare Access/LoSP n’a pas été ouverte; les quotas autorisés restent inutilisés. Aucun merge, déploiement ou changement de l’adresse Worker n’a eu lieu.

## Corrections après validation iPhone — 27 novembre 2026

### Autorisation et attribution

Le propriétaire confirme avoir reçu de Maddoxx, le 21 novembre puis avec une mise à jour le 25 novembre, l’autorisation d’utiliser, adapter et intégrer son travail au Planificateur d’événements LoSP. Son nom reste crédité dans la documentation technique, sans apparaître dans les libellés joueurs. Les captures de conversation privée et les ZIP originaux ne sont pas ajoutés au dépôt. La redistribution publique autonome des sources Maddoxx n’a pas été explicitement établie; cette intégration ne constitue pas une affirmation de droit de redistribution.

Cette mise à jour remplace, pour le roster et ISO-8, les indications antérieures devenues inexactes. Elle ne contient aucune donnée personnelle issue de l’inventaire.

### Cause racine du roster indisponible

Le planificateur lisait l’objet facultatif `roster-batches/v1/connected-personal-rosters/{session}/latest.json`. Or `captureConnectedPersonalRoster()` retourne explicitement `managed-by-alliance-sync` pour les alliances approuvées, LoSP comme invitées : cet objet n’est donc pas créé pour ces comptes. Le collecteur planifié conserve le roster personnel sous `roster-batches/v1/{fingerprint}/latest-complete.json` et `{runId}/member-self.json`, avec le lien de compte existant `roster-session-hint/v1/{fingerprint}.json`. L’ancien lecteur ne suivait jamais ce parcours.

Le nouveau lecteur suit l’index de l’alliance de la session capitaine, vérifie l’approbation et l’égalité exacte avec le compte indiqué par le collecteur, puis lit et valide uniquement le manifeste et `member-self.json`. Il ne lit aucun autre roster, ne lance aucune collecte et n’écrit rien dans R2. En cas de session différente du compte qui a servi au passage planifié, il échoue fermé; la page de diagnostic administrateur indique alors l’étape manquante. Cette dernière situation devra être confrontée au R2 réel après autorisation de déploiement.

### Convention Scopely ISO-8

Les suffixes sont des niveaux internes continus, et non des niveaux locaux répétés à chaque palier :

| Couleur | Palier | Suffixes internes | Niveaux affichés |
| --- | --- | --- | --- |
| GREEN | P1 | 1–5 | 1–5 |
| BLUE | P2 | 6–10 | 1–5 |
| PURPLE | P3 | 11–15 | 1–5 |
| ORANGE | P4 | 16–20 | 1–5 |

Les exemples observés `GREEN_SUPPORT_HEALTH_1`, `BLUE_CONTROLLER_ARMOR_6`, `PURPLE_BLASTER_HEALTH_11` et `ORANGE_BLASTER_DAMAGE_16` corroborent les offsets. Le parseur refuse une incohérence entre couleur et suffixe. Les tests couvrent les 100 combinaisons du premier niveau observé, les 500 combinaisons de classes/statistiques/niveaux possibles et des suffixes incohérents. Ces tests ne constituent pas une affirmation sur les quantités personnelles réelles.

Le nombre d’identifiants de cristaux de niveaux fusionnés, leur forme d’identification et la sémantique des quantités restent à établir depuis une source vérifiable. Aucun niveau supérieur n’est calculé à partir des cristaux de base; les quantités manquantes restent inconnues. Aucun coût de fusion, pose ou amélioration n’est supposé.

### Parcours joueur et administration

Les IDs, objets non classifiés, étapes R2, détails de normalisation et couvertures de catalogue sont déplacés dans `/admin/events-planner/diagnostics`, derrière les contrôles Cloudflare Access et propriétaire existants. Les deux inventaires affichés par cet espace utilisent le cache DO déjà présent en mode lecture seule; cache absent ou expiré ne déclenche aucun appel Scopely. Le parcours joueur n’affiche ni identifiant technique ni diagnostic; les ressources manquantes sont regroupées par famille. La matrice ISO-8 reste partielle, affiche « — » pour inconnu, conserve les classes visibles au défilement horizontal et sépare niveau accessible, amélioration effectuée et coût.

### Tests et statut du déploiement

- Tests ciblés planificateur, API, accès propriétaire, ISO-8 et projections roster R2 : 83/83 réussis.
- Chromium 141.0.7390.37 : parcours complet réussi aux largeurs 320, 360, 390 et 430 px, sans débordement horizontal. Les fixtures et captures locales sont synthétiques.
- WebKit n’a pas pu démarrer localement : le système ne fournit pas `libgtk-4`, `libgraphene`, `libharfbuzz-icu`, `libmanette`, `libhyphen` et `libGLESv2`. Le workflow GitHub « Event planner mobile browsers » reste la validation WebKit prévue après publication de ce commit; aucune validation iPhone Safari n’est revendiquée.
- Deux échecs de `tests/automatic-roster-scheduler.test.mjs` (rattrapage PM tardif et publication LoSP pendant une collecte invitée) se reproduisent à l’identique sur `main` au SHA de référence `5af430a10cd636badb0f18d9055e44693a96ef90`. Aucun de ces fichiers n’a été modifié.
- Aucune donnée personnelle n’a été chargée depuis Cloudflare ou Scopely dans cette intervention. Aucun nouvel appel Scopely, aucun déploiement et aucune fusion n’ont eu lieu. Le déploiement de la PR #218 reste en attente d’autorisation explicite. La version de référence actuellement connue reste le déploiement `7c082c73-ff57-41c6-89a6-22ed3cfd0545`, version `42e4f4c9-8e94-4f57-a6de-cac6758d028a`; le rollback du prochain déploiement devra revenir à cette version.
