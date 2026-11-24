# Validation WebKit du laboratoire d’événements

Cette note distingue les éléments observés dans les sources du dépôt des structures inventées pour éprouver le rendu. Les fixtures WebKit sont entièrement synthétiques; aucune réponse privée, donnée de compte, capture, token ni archive personnelle n’est copiée dans GitHub.

## Structures établies dans les éléments disponibles

| Élément | État de preuve |
| --- | --- |
| `GET /player/v1/events` fournit une sélection d’événements personnels avec pagination et métadonnées `meta` | Endpoint et pagination documentés par le manuel du projet; les rapports d’archives LoSP comptent une liste réelle de 96 événements. |
| `GET /player/v1/events/{eventId}` | Endpoint documenté. Le propriétaire a confirmé une réponse réelle HTTP 200 d’environ 55,6 Ko dont l’identifiant figurait sous `data.data.id`; aucun corps privé n’est conservé dans le dépôt. |
| `milestone.brackets[]` et `milestone.scoring.cappedScorings[]` | Formes présentes dans les projections publiques de catalogue et comptées dans le rapport d’analyse des archives personnelles. |
| `cappedScorings[].soFar` | Champ réellement numérique dans 25 des 141 compteurs du relevé privé agrégé; les autres ne sont pas assimilés à zéro. |
| `brackets[].objective.progress` | Absent des 34 brackets du relevé privé agrégé. Sa présence dans les fixtures ne confirme pas sa présence dans les réponses de compte. |
| `completedTier` et `claimableTiers` sur un événement personnel | Les tests de l’analyse et les descriptions de l’implémentation Maddoxx montrent qu’ils sont pris en charge par du code; aucun exemple brut de réponse personnelle conservé dans le dépôt ne confirme leur valeur ou leur forme exacte. Le `level.completedTier` documenté ailleurs concerne une progression de niveau, pas nécessairement un événement. |
| Dégâts et complétion d’un raid dans la réponse d’événement personnelle | Non confirmés. Le catalogue public et les ressources de raid n’établissent pas que la progression personnelle d’un raid soit exposée par ces champs. |

Les tests existants `personal-event-analysis.test.mjs` et `personal-event-lab.test.mjs` utilisent eux-mêmes des objets de test synthétiques. Ils vérifient les règles de projection, pas le schéma réel complet de Scopely.

## Couverture des fixtures WebKit

`tests/personal-event-lab.webkit.spec.mjs` sert au navigateur le HTML et les deux scripts produits par `handlePersonalEventLab`, puis remplace uniquement les réponses du fournisseur par des fixtures. La première page de liste contient 100 événements fictifs et son corps JSON est ajusté à environ 173,6 Ko pour éprouver le chemin de grande réponse; une seconde page porte la liste à 120 événements. Une propriété `fixturePadding` purement artificielle fournit le volume et n’est pas présentée comme un champ Scopely.

Les neuf détails séquentiels couvrent : progression absente, valeur zéro, progression partielle avec accents et caractères Unicode, cible atteinte, paliers complétés et réclamables, compteurs absents/null/incomplets, tableaux vides, alias `milestones` et double enveloppe inhabituelle, et une entrée de raid fictive. Le raid et les formes imbriquées inhabituelles sont explicitement des cas hypothétiques de robustesse. Une dixième réponse retardée vérifie qu’un changement de sélection pendant la requête ne fait pas analyser le détail reçu sous l’identifiant d’un autre événement.

Cette batterie a aussi reproduit un défaut local de sélection : après réception d’un détail dont l’identifiant est placé derrière plusieurs enveloppes `data`, choisir un autre événement laissait le dernier détail affiché comme s’il correspondait à la sélection. Le client conserve maintenant la dernière liste reçue et en extrait l’identifiant de détail en parcourant jusqu’à quatre enveloppes avant de décider si le rendu local peut réutiliser le détail ou doit repartir de la liste. La profondeur supérieure à l’enveloppe réellement observée est un test de robustesse hypothétique; l’identifiant de détail réel confirmé dans le dépôt reste `data.data.id`.

Pour chaque sélection, le test vérifie qu’aucun appel fournisseur n’est déclenché par le changement seul. Les appels admis sont les deux pages de liste et un détail à la demande par scénario. Il échoue aussi si le panneau porte `data-analysis-error`, affiche une erreur locale capturée, émet une erreur de console/page, un rejet de promesse non géré ou une erreur de chargement de module/script. Il vérifie l’unicité du panneau, le rendu de la progression et le message explicite lorsque la progression n’est pas fournie.

## Limites

WebKit 26.0 sous Linux CI exerce le moteur WebKit et les réponses générées à partir du code présent sur la branche. Cela ne reproduit ni la version de WebKit embarquée par Safari iOS, ni son contexte exact, ses politiques de mémoire, ses extensions ou son cycle de vie d’onglet. Aucune `ReferenceError` n’a été observée avec ces fixtures; l’incident Safari iOS demeure donc inexpliqué et non résolu jusqu’à une validation réelle ultérieure. Aucun déploiement et aucun nouvel appel Scopely réel ne font partie de cette validation.
