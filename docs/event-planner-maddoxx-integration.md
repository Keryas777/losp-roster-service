# Intégration du planificateur Maddoxx — branche de travail

Cette note décrit l’intégration portée dans `work/personal-event-progress-v1`. Le code reste en PR brouillon; aucune route de production n’a été publiée par ce chantier.

## Architecture

- `/admin/events-planner` sert la page et ses modules dans le domaine déjà protégé par Cloudflare Access. Le Worker valide en plus le JWT Access et exige l’identité exacte du propriétaire configurée pour le laboratoire privé; un cookie Scopely capitaine ne confère aucun droit administrateur.
- L’entrée « Planifier avec mon roster » est rendue uniquement dans l’espace `/admin` pour le propriétaire. La page Événements GitHub Pages et ses fichiers CSS/JS restent identiques à la production; aucun bouton public ni appel personnel n’y est ajouté.
- `/admin/api/event-planner` expose uniquement `status`, `events`, `detail`, `roster` et `inventory`. Chaque lecture vérifie d’abord l’identité propriétaire, puis le cookie de session, le grant courant et le scope de l’opération. Les alias personnels `/captain/api/events` et `/captain/events` sont également fermés aux non-propriétaires. Les assets `/event-planner/*` sont exécutés par le Worker avant toute réponse statique et refusés en accès direct. L’origine est limitée au domaine du Worker, les réponses sont privées et `no-store`, et aucun jeton ne quitte le Worker.
- Les lectures utilisent le Durable Object `PERSONAL_EVENT_CACHE` déjà présent dans le Worker. Elles sont isolées par le hash du consentement, mises en cache cinq minutes, et les erreurs ne servent jamais une réponse périmée. L’inventaire utilise `since=meta.asOf` lorsque disponible et conserve la dernière liste complète sur une réponse Scopely `344`.
- Les catalogues publics LoSP apportent noms, portraits et traits. Aucun résultat personnel ne leur est envoyé. Les préférences et déclarations de stock sont gardées dans le `localStorage` du navigateur sur l’origine Worker.

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

Les tests unitaires et d’adaptation ciblés passent localement. Le test Playwright Chromium/WebKit est ajouté au CI; aucun navigateur compatible n’était exécutable dans l’environnement local en raison de dépendances système absentes. Le grand ensemble de tests existant contient aussi des échecs présents sur le SHA de base `285c24c19c6bf51600a9e50a611bf1ad2a9f8e58`, notamment dans les collecteurs DD9/rosters et les fixtures temporelles R2; ils ne sont pas introduits par cette intégration.

Aucun appel en direct à un compte Scopely n’a été fait. Les formes des données réelles accessibles dans les archives et les scopes déjà déclarés sont documentées dans `personal-event-progress-v1.md`, mais les réponses personnelles d’événement, roster et inventaire n’ont pas été revalidées en direct dans cette PR.

## Activation après validation

Après accord et fusion de la PR Worker, le Worker existant devra recevoir cette version puis le parcours capitaine devra être testé dans le navigateur. Le lancement se fait depuis le bouton propriétaire uniquement visible dans l’espace administrateur existant. La PR `Keryas777/msf` conserve la page publique Événements inchangée. Ce chantier n’ajoute ni Worker, ni cron, ni binding Durable Object, et n’effectue aucun déploiement.
