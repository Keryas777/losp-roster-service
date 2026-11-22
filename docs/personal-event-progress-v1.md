# Progression personnelle des événements — contrat v1

Le Worker expose une lecture privée à la demande sous `/captain/api/events` (alias lisible `/captain/events`). Le parcours OAuth dédié commence à `/login/events` et ne demande que `openid`, `m3p.f.pr.pro`, `m3p.f.pr.act` et `offline`. Les callbacks n’appellent ni les collecteurs de roster ni les routes d’archive.

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

La documentation API consultée décrit `startTime` et `endTime`, mais ne documente pas les périodes de réinitialisation des objectifs. Le service ne prétend donc pas les connaître et ne peut pas invalider à un instant de reset qui n’est pas exposé par ces sources; la durée maximale de cinq minutes borne la fraîcheur. Il faut encore un test réel, avec une action identifiable d’un compte volontaire, et le ZIP Maddoxx pour confirmer les compteurs et les resets.

## Compte des appels

Une lecture sans cache appelle la route globale une fois par page (`perPage=100`, paramètres `lang=fr`, `eventInfo=full`, `objRewards=full`), jusqu’à 8 pages. Le détail appelle une fois `/player/v1/events/{eventId}`. Le nombre exact est renvoyé dans `upstream.calls`; une erreur renvoie les appels déjà effectués. Une réponse de cache en fait zéro.
