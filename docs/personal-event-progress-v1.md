# Progression personnelle des événements — contrat v1

Le Worker expose une lecture privée à la demande sous `/captain/api/events` (alias lisible `/captain/events`). Le service réutilise la session capitaine existante. Le parcours `/login/captain` standard demande les scopes déclarés par le service, dont `m3p.f.pr.act`, `m3p.f.pr.ros` et `m3p.f.pr.inv`; le laboratoire n’ajoute aucune route OAuth. Les callbacks n’appellent ni les collecteurs de roster ni les routes d’archive.

## Requêtes

- `GET /captain/api/events` : liste complète paginée de `/player/v1/events`.
- `GET /captain/api/events?eventId=<id>` : détail d’un seul événement, seulement si l’appelant le demande.
- `GET /captain/api/events?refresh=1` : actualisation explicite. Deux actualisations forcées du même consentement doivent être espacées d’au moins 10 secondes; cette protection ne limite pas les consultations normales et n’installe aucun quota par minute.

Le cookie de session est HttpOnly, Secure et SameSite=Lax. Aucun token n’est transmis au navigateur. Les réponses portent `Cache-Control: private, no-store`, `CDN-Cache-Control: no-store`, `Vary: Cookie` et `X-Robots-Tag: noindex`.

## Réponse réussie

```json
{
  "status": "ok",
  "schemaVersion": 1,
  "source": "scopely-player-events",
  "retrievedAt": "2026-11-22T12:00:00.000Z",
  "cache": { "hit": false, "expiresAt": "2026-11-22T12:05:00.000Z" },
  "upstream": { "endpoint": "/player/v1/events", "calls": 1, "pages": 1, "asOf": null },
  "events": [{
    "id": "<eventId>",
    "milestone": {},
    "progressFacts": [{
      "kind": "objective-progress",
      "bracketId": "<bracketId>",
      "path": "milestone.brackets[0].objective.progress",
      "value": null,
      "state": "unknown"
    }]
  }]
}
```

`events` conserve les champs Scopely; `progressFacts` ne projette que les valeurs numériques présentes dans `milestone.brackets[].objective.progress` et `milestone.scoring.cappedScorings[].soFar`. `null` + `unknown` signifie absent ou non numérique; la progression n’est jamais ramenée à zéro et aucun palier n’est déclaré terminé par cette version. Le champ `scope` distingue `individual`, `collective`, `global` ou `unknown` quand `milestone.type`/`isGlobal` le permet. Le corps brut reste la référence pour bracket, type de jalon, plafonds, scoring, méthodes et récompenses. Pour le détail, `upstream.endpoint` vaut `/player/v1/events/{eventId}` et `eventId` est renvoyé.

Erreurs JSON explicites : `not-connected`, `consent-revoked`, `scope-insufficient`, `authorization-unavailable`, `rate-limited`, `provider-error`, `invalid-provider-response`, `inconsistent-page`, `inconsistent-total`, `changed-during-pagination`, `incomplete-pagination`, `page-budget-exceeded`, `refresh-too-soon`.

## Cache et pagination

Un Durable Object privé, nommé par le hash du consentement OAuth, conserve la réponse au plus 300 secondes après une récupération réussie; une alarme Durable Object supprime les entrées expirées. Les demandes simultanées pour le même consentement et la même ressource partagent la même récupération. Les événements globaux et les détails d’événement ont des entrées distinctes. Une erreur fournisseur ne restitue jamais une entrée expirée. Aucune donnée personnelle n’est écrite dans R2 ou GitHub. Le scope d’isolation est le grant/session OAuth : des connexions distinctes du même compte n’ont pas encore de clé d’identité Scopely stable vérifiée et ne mutualisent donc pas leur cache.

## Relevés et limites de validation (22 novembre 2026)

Dans les archives privées existantes, dix sessions possèdent un manifeste récent `personal-events`; aucun manifeste `personal-inventory` n’est présent dans ces dix sessions. Un seul dernier relevé d’événements a été examiné au niveau des champs : 96 événements sur une page, 34 brackets, 141 groupes de scoring plafonné. `objective.progress` était absent dans les 34 brackets; `soFar` était numérique dans 25 des 141 groupes. Aucun champ de reset n’était présent. Cinq instantanés historiques du même consentement montraient des variations de `soFar` entre captures espacées d’environ 34 h, mais aucun journal ne relie ces captures à une action identifiable : cela ne valide pas encore l’effet d’une action en jeu.

Le scope documenté de l’inventaire est `m3p.f.pr.inv` et `/player/v1/inventory` retourne des `ItemQuantity[]`. Aucun inventaire brut archivé n’était disponible pour classifier l’or, les noyaux de puissance, les ions ISO-8 et les énergies; le diagnostic historique `inventory-test` ne conserve qu’un état et un nombre, pas les identifiants/quantités. Leur disponibilité précise reste donc à confirmer sur une réponse consentie et à relier au catalogue commun. La progression d’événement ne dépend pas de cette exploration.

La documentation API consultée décrit `startTime` et `endTime`, mais ne documente pas les périodes de réinitialisation des objectifs. Le service ne prétend donc pas les connaître et ne peut pas invalider à un instant de reset qui n’est pas exposé par ces sources; la durée maximale de cinq minutes borne la fraîcheur. Le ZIP Maddoxx est maintenant examiné plus bas. Il faut encore un test réel, avec une action identifiable d’un compte volontaire, pour confirmer les compteurs et les resets.

## Compte des appels

Une lecture sans cache appelle la route globale une fois par page (`perPage=100`, paramètres `lang=fr`, `eventInfo=full`, `objRewards=full`), jusqu’à 8 pages. Le détail appelle une fois `/player/v1/events/{eventId}`. Le nombre exact est renvoyé dans `upstream.calls`; une erreur renvoie les appels déjà effectués. Une réponse de cache en fait zéro.

## Comparaison Maddoxx — ZIP du 21 novembre 2026

Le ZIP contient un extrait backend Express, une page React et la bibliothèque pure d’analyse/planification. Il n’embarque ni captures de réponses Scopely ni réponses API brutes.

| Fonction | Implémentation Maddoxx | PR LoSP |
|---|---|---|
| Liste événements | `GET /player/v1/events`, `msfGet` ajoute `lang=fr`; pagination suivante avec `page` et `perPage` | liste globale avec `lang=fr`, `eventInfo=full`, `objRewards=full`, `page`, `perPage` |
| Détail | Pour l’événement sélectionné, l’analyse demande `/player/v1/events/{id}` en anglais et en français, puis ne conserve pas ces appels comme archive | détail à la demande en un appel, paramètres `lang=fr`, `objRewards=full` |
| Roster | `/player/v1/roster` appelé en parallèle des détails pour analyser un événement | non lu par le service d’événements v1 |
| Inventaire | `/player/v1/inventory` avec `itemType=CONSUMABLE` et `ISOITEM`, `lang=none`, et `since=<meta.asOf>` quand disponible; deux types sont lus séquentiellement dans le service | non lu par le service d’événements v1 |
| Scopes | `openid offline m3p.f.pr.pro m3p.f.pr.ros m3p.f.pr.inv m3p.f.pr.act m3p.f.ar.pro`; l’inventaire est facultatif dans son intégration | consentement événements minimal `openid m3p.f.pr.pro m3p.f.pr.act offline`; les scopes roster/inventaire ne sont pas requis par le service de progression |
| Progression d’objectif | L’analyse backend ne prend en charge que `milestone.brackets[].objective.progress`; l’interface de rendu accepte aussi `objective.contribution` et `playerContribution` | `progressFacts` examine `objective.progress` et `cappedScorings[].soFar`, sans inventer les valeurs absentes |
| `soFar` absent | Le calculateur Maddoxx fait `Number(entry.soFar) || 0`, puis calcule le reste avec cette valeur; son registre fait aussi `Number(entry.soFar) || 0` | absent/non numérique reste `null` et `unknown` |

Le service de stock de Maddoxx relit la liste des événements actifs en anglais. Pour chaque événement à jalons dont les récompenses ne sont pas déjà dans son cache disque, il appelle le détail avec `lang=en` (jusqu’à quatre appels parallèles), mais n’en extrait que les récompenses de paliers liées aux ressources. Sa page d’analyse appelle le détail `lang=en`, le détail par défaut en français et le roster en parallèle pour l’événement sélectionné. Le service d’inventaire lit `CONSUMABLE` et `ISOITEM` séquentiellement avec `lang=none` et `since=meta.asOf` si connu; il traite le statut 344 comme « inchangé ». Les inventaires sont gardés cinq minutes en mémoire et les récompenses de paliers jusqu’à sept jours après la fin de l’événement. Le registre déduit les dépenses depuis les deltas de `soFar` entre deux relevés, prend le maximum des compteurs compatibles plutôt que leur somme, et estime les récompenses réclamées à partir de `completedTier`, `claimableTiers` et des récompenses du détail. Ce calcul d’inventaire n’est pas une source brute de progression personnelle.

**Piste principale, à confirmer en direct :** les archives LoSP examinées sont des captures de la liste globale (`/player/v1/events?lang=fr&page=1&perPage=100&eventInfo=full`). Elles ne contiennent pas de capture de `/player/v1/events/{eventId}`. Maddoxx charge ce détail lors de l’analyse d’un événement sélectionné; les appels du service de stock en extraient seulement les récompenses puis abandonnent le reste du corps. Le détail peut donc contenir des champs personnels omis de la liste sans être conservé dans ces archives. C’est une explication plausible pour l’absence totale de `objective.progress` dans nos brackets de liste, pas une preuve. Les paramètres diffèrent aussi : liste Maddoxx en `lang=en` pour le stock et `lang=fr` pour la page, sans `eventInfo=full` ni `objRewards=full`; ses détails utilisent `lang=en` ou la langue par défaut, sans expansion `objRewards=full`. Les 25 `soFar` numériques montrent que certains compteurs sont bien fournis dans la liste; les 116 autres peuvent être absents, non numériques ou conditionnels. Maddoxx ne les complète pas depuis le détail et leur attribue zéro dans ses calculs. `soFar` absent ne prouve donc pas que la progression vaut zéro. La comparaison live liste/détail avec les mêmes paramètres doit isoler la différence.

L’interface Maddoxx consomme le détail pour faire son analyse, pas pour remplir à l’avance l’ensemble des événements. Une récupération de détail pour chaque entrée de la liste ajouterait jusqu’à 96 requêtes de détail (ou 192 pour reproduire les deux langues de l’analyse Maddoxx) et ne doit donc pas être activée par défaut. Le laboratoire ci-dessous permet de comparer les deux formes et plusieurs profils de paramètres, puis de limiter le détail aux événements mesurables.

## Laboratoire privé sur le Worker existant (non activé)

`src/personal-event-lab.js` prépare une route temporaire sur le Worker LoSP existant : `/admin/personal-event-lab`. Elle n’ajoute ni Worker, ni client OAuth, ni callback, ni session indépendante. Elle réutilise le cookie et la session Scopely `__Host-losp_captain_session` déjà utilisés par l’espace capitaine, ainsi que le client et les secrets OAuth existants. Le laboratoire ne lance aucun parcours OAuth à lui seul : le lien de connexion mène au parcours capitaine courant. La session existante est d’abord contrôlée et ses scopes sont vérifiés par opération; un scope absent produit `scope-insufficient` et aucun appel fournisseur. La connexion complémentaire, si elle s’avère nécessaire, passe par le mécanisme courant.

La route est doublement restreinte : JWT Cloudflare Access vérifié par le Worker et correspondance exacte avec `PERSONAL_EVENT_LAB_ADMIN_EMAIL`, qui doit également être autorisé dans l’allowlist administrateur existante. Le chemin `/admin/personal-event-lab` est placé sous l’application Access existante `/admin`, sans modifier son audience ni sa politique. L’activation exige `PERSONAL_EVENT_LAB_ENABLED=true`; sans cette valeur ou sans email exact, la route répond 404. L’email doit être renseigné comme secret Cloudflare et ne figure pas dans le dépôt. Chaque endpoint vérifie l’identité avant de lire la session Scopely. Le contenu et les réponses sont `private, no-store`; aucune réponse personnelle n’est persistée, publiée, ni gardée en cache public.

La page peut interroger la liste (pagination complète ou une page), un détail ciblé, le roster et les deux familles d’inventaire. Les paramètres sont validés côté serveur; les requêtes Scopely partent immédiatement avec `cache: no-store`. Chaque relevé indique paramètres, statut, latence, octets et nombre d’appels. La comparaison récursive A/B et les réponses brutes restent en mémoire de l’onglet. Ces comportements sont couverts par des tests simulés; aucun appel Scopely en direct n’a encore validé les champs ou les latences.

### Déploiement ciblé à valider

La modification est intégrée au Worker actuel. Elle réutilise son bucket R2 de sessions et son Durable Object de renouvellement OAuth. Elle ajoute un binding Durable Object `PERSONAL_EVENT_CACHE` et la migration SQLite `personal-event-cache-v1` pour le cache privé de progression, indépendant du bucket de sessions. `PERSONAL_EVENT_LAB_ENABLED` est livré avec la valeur `false`. Aucun cron ni déclenchement de collecte n’est ajouté et les quatre schedules existants restent inchangés. Aucun client, secret, scope ou callback OAuth Cloudflare n’est modifié.

Pour préparer l’activation ciblée après validation du déploiement, un seul secret Cloudflare est à ajouter : `PERSONAL_EVENT_LAB_ADMIN_EMAIL=<adresse exacte du propriétaire>`. La valeur initiale du flag reste `PERSONAL_EVENT_LAB_ENABLED=false`; son passage à `true` est une étape distincte, après contrôle d’accès. L’adresse doit déjà figurer dans `MSF_ADMIN_EMAILS`, qui est utilisé par le validateur Access actuel.

L’application Access existante couvre le chemin `/admin`; les sous-chemins héritent sa protection. Avant activation, vérifier que le compte du propriétaire utilise une session Scopely active avec `m3p.f.pr.act`, `m3p.f.pr.ros`, `m3p.f.pr.inv` et `offline`. Le laboratoire ne démarre pas d’autorisation ni ne change les scopes consentis; la coordination habituelle de session peut renouveler un access token expirant. Si un scope manque, la route affiche explicitement le scope requis et aucun appel Scopely n’est lancé. Il faut alors compléter l’autorisation par le parcours OAuth capitaine existant puis revenir au laboratoire. Ne pas recopier de token ni les réponses brutes dans la conversation ou GitHub.

Le déploiement de cette branche sur le Worker existant n’est pas effectué. Le plan proposé est de téléverser d’abord une version Cloudflare non déployée à partir du commit de la PR, puis, après accord, de la déployer à 100 % sur `losp-roster-service` avec le laboratoire désactivé. Après contrôle du service et de l’héritage Access, l’ajout du secret propriétaire et le basculement du flag seront soumis comme étape d’activation séparée. Cela déploie une nouvelle version du Worker de production mais ne fusionne pas la PR GitHub; aucun Worker temporaire distinct n’est créé. La procédure de retour arrière consiste à remettre immédiatement le flag à `false`, puis à redéployer la version Cloudflare active précédant ce changement. La migration DO déjà créée reste inactive et n’est pas supprimée; les schedules et les autres bindings sont restaurés avec la version précédente.
