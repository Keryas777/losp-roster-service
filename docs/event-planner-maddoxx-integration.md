# Intégration du planificateur Maddoxx — branche de travail

Cette note décrit l’intégration portée dans `work/personal-event-progress-v1`. Le code reste en PR brouillon; aucune route de production n’a été publiée par ce chantier.

## Architecture

- `/admin/events-planner` sert la page et ses modules dans le domaine déjà protégé par Cloudflare Access. Le Worker valide en plus le JWT Access et exige l’identité exacte du propriétaire configurée pour le laboratoire privé; un cookie Scopely capitaine ne confère aucun droit administrateur.
- La page Événements GitHub Pages garde pour les membres, invités et visiteurs les filtres, cartes, regroupements, libellés et comportements actuels. Cette PR ajoute un identifiant stable aux cartes et un module sans appel réseau; le bouton n’est injecté que pour la session administrateur propriétaire validée par le garde LoSP existant. Les autres profils ne voient aucun bouton et ne déclenchent aucun appel personnel supplémentaire. Le propriétaire ouvre ensuite la page Worker temporaire par navigation de premier niveau.
- `/admin/api/event-planner` expose uniquement `status`, `events`, `detail`, `roster` et `inventory`. Chaque lecture vérifie d’abord l’identité propriétaire, puis le cookie de session, le grant courant et le scope de l’opération. Les alias personnels `/captain/api/events` et `/captain/events` sont également fermés aux non-propriétaires. Les assets `/event-planner/*` sont exécutés par le Worker avant toute réponse statique et refusés en accès direct. L’origine est limitée au domaine du Worker, les réponses sont privées et `no-store`, et aucun jeton ne quitte le Worker.
- Les lectures utilisent le Durable Object `PERSONAL_EVENT_CACHE`, ajouté au Worker existant par cette PR avec une migration de classe additive. Elles sont isolées par le hash du consentement, mises en cache cinq minutes, et les erreurs ne servent jamais une réponse périmée. L’inventaire utilise `since=meta.asOf` lorsque disponible et conserve la dernière liste complète sur une réponse Scopely `344`.
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

Les workflows GitHub Actions valident les adaptations, les profils d’accès et les navigateurs Chromium/WebKit sur un viewport mobile. Sur `main` au SHA `5af430a10cd636badb0f18d9055e44693a96ef90`, la suite générale du Worker échoue déjà sur 15 tests sur 897 (collecteurs, budgets, fixtures temporelles R2 et accès de roster R2). Le même ensemble de 15 échecs apparaît sur la branche; les tests du planificateur passent séparément.

Aucun appel en direct à un compte Scopely n’a été fait. Les formes des données réelles accessibles dans les archives et les scopes déjà déclarés sont documentées dans `personal-event-progress-v1.md`, mais les réponses personnelles d’événement, roster et inventaire n’ont pas été revalidées en direct dans cette PR.

## Activation après validation

Après accord et fusion de la PR Worker, le Worker existant devra recevoir cette version via le workflow de déploiement contrôlé; le parcours capitaine sera ensuite validé dans le navigateur. Le lancement se fait depuis le bouton propriétaire uniquement visible dans l’espace administrateur existant. Dans `Keryas777/msf`, la liste publique reste inchangée pour les membres; seul le propriétaire voit le nouveau lien, sans appel Scopely personnel sur GitHub Pages. Ce chantier n’ajoute ni Worker séparé ni cron; il ajoute le Durable Object de cache et sa migration au Worker existant.

## Restauration rapide

La migration de classe Durable Object est additive. Après son déploiement, Cloudflare n’autorise pas le retour à une version située avant cette migration. En cas de problème, déployer par le workflow contrôlé un commit fail-closed qui conserve le binding et la migration avec `EVENT_PLANNER_ENABLED` à `false`; les routes personnelles du planificateur et les alias progressions répondent alors `404`. Le contrôle du workflow accepte ces deux états du drapeau pour permettre cette restauration. Pour la page GitHub Pages, rétablir le commit précédant la PR #730 par un commit de revert et attendre la publication Pages.


## Passerelle temporaire depuis la page Événements LoSP

La page publique reste la source de vérité pour le calendrier : filtres, groupes, libellés et cartes continuent d’être calculés dans `msf/docs/evenements.js`. Le lien propriétaire n’est ajouté qu’aux cartes après validation de la session administrateur réelle par `auth-guard.js` (identifiant propriétaire déjà utilisé par LoSP). Le mode aperçu d’un membre ne suffit pas à l’afficher.

Le lien transmet uniquement l’identifiant stable de l’événement à la page privée du Worker. Le navigateur ouvre cette page par navigation de premier niveau; les routes personnelles continuent donc d’utiliser le contrôle Cloudflare Access, le contrôle propriétaire et le cookie capitaine de première partie existants. Aucun jeton n’est transmis à GitHub Pages, aucun appel personnel n’est émis sur la page publique et aucune requête CORS vers l’API privée n’est ajoutée.

Le Worker accepte `eventId` uniquement s’il correspond à un événement présent dans le calendrier public LoSP actif et non ignoré. Il n’appelle les détails personnels que pour cette sélection; un identifiant invalide, expiré, filtré ou ignoré ne déclenche pas de requête de détail.

Cette passerelle prépare une migration réversible, mais ne réalise pas encore la page unique souhaitée. Safari iOS bloque ou partitionne les cookies tiers; GitHub Pages ne peut pas servir un proxy côté serveur. Une page unique authentifiée nécessitera soit une origine LoSP commune au front et à l’API, soit un mécanisme de ticket bref à usage unique et révocable. Aucun de ces changements d’architecture/sécurité n’est introduit dans cette PR.


## Périmètre de cette passe et limites à traiter avant ouverture aux membres

- Le calcul Maddoxx et ses classifieurs ne sont pas modifiés. Les libellés français Scopely restent prioritaires; lorsque la traduction manque, les actions courantes (connexion, combats par mode, dépenses et prérequis du roster) ont une formulation française construite à partir des champs structurés. Les cas non reconnus restent signalés comme à vérifier sans exposer les codes internes.
- Les actions sont regroupées par personnage avec un portrait unique, progression en barre uniquement lorsque Scopely fournit un compteur exploitable, et sections repliables pour les actions terminées. Le score d’événement et les paliers continuent d’utiliser leurs champs Scopely séparés.
- L’inventaire est filtrable par famille et par texte, replié par famille sur les grands volumes; un identifiant technique n’est visible qu’à l’ouverture de son détail. Les quantités absentes restent « Quantité indisponible ». Les métadonnées réellement livrées par l’inventaire ne suffisent pas à reconstituer les catégories ISO-8 couleur/niveau/classe/statistique; la vue les regroupe donc seulement selon la famille retournée. Les noms français inconnus restent génériques plutôt que d’afficher un texte anglais ou un ID comme nom.
- Les correspondances XPLVL20/40/60 n’ont pas été retrouvées dans les référentiels versionnés examinés; elles ne sont pas ajoutées par déduction. Un catalogue central partagé d’objets, alimenté depuis les définitions publiques /game/v1/items/{itemId} et livré depuis le dépôt msf, reste à préparer lorsqu’une source complète versionnée sera disponible.
- La persistance des ressources déclarées et des événements ignorés reste dans la clé locale existante du navigateur. Le planificateur étant encore propriétaire uniquement, cette passe ne migre pas les données vers un stockage par compte. Avant ouverture à plusieurs capitaines/joueurs, il faudra scoper ces préférences par identité de compte stable côté service; le statut actuel n’expose pas une telle identité et aucune requête Scopely supplémentaire n’est ajoutée ici.
- Les tests navigateur utilisent des réponses Scopely anonymisées/simulées. Ils vérifient le routage réel des imports de Worker déjà couvert par la PR #217, le deep-link filtré, l’interface, les valeurs nulles/absentes, les quatre onglets et les styles LoSP chargés depuis la page publique. Ils ne revalident pas les données personnelles réelles de l’administrateur.