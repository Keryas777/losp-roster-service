# Relevé rapide des Infos après récompenses d'arène

Objectif : commencer une **collecte SUPPLÉMENTAIRE** à **17:01 Europe/Paris**
pour enregistrer le rang latestArena du jour après le reset de 17:00.
Le processus collecte également les autres éléments enrichis déjà pris en charge
par l'import Infos, sans toucher à ses campagnes existantes.

## Zéro changement de planning existant

- Les collectes AM et PM existantes de src/member-info-scheduler.js
  ne sont **ni déplacées ni supprimées**.
- Les 4 crons du fichier wrangler.jsonc ne changent pas.
- Le collecteur de rosters, /player, /game, ISO, etc. ne change pas.
- La nouvelle option est uniquement MEMBER_INFO_REWARD_ENABLED=true.
- L'exécution emploie le cron Cloudflare déjà présent, toutes les minutes.

## Horaire et portée

Début local Europe/Paris : **17:01**, immédiatement après le cut-off
des récompenses de 17:00. Heure UTC :
- hiver CET : **16:01 UTC**
- été CEST : **15:01 UTC**

À la première minute, une alliance est choisie. À la minute suivante,
l'alliance suivante, sans bloquer les campagnes existantes. Au maximum
24 fiches sont lues par passage, par petits groupes simultanés de 3
(et plafonnées si la découverte d'un compte consomme des requêtes).
Pour 6 alliances de 24 membres, le déroulement nominal fait un
premier passage sur les six alliances entre 17:01 et 17:06.
La fenêtre de reprises court jusqu'à 17:30 compris.

Ce n'est PAS la garantie que 122 fiches seront capturées exactement à 17:01 :
le déclenchement Cloudflare peut être retardé ; les appels sont par joueur ;
des erreurs OAuth, membership, 429 ou API empêchent éventuellement de terminer.
Aucun résultat antérieur ne devient artificiellement le relevé du jour.

Le plafond par invocation est une protection du logiciel / du plan Cloudflare,
et non un nombre fixe de requêtes imposé par Scopely.

## Provenance et stockage

Pour chaque alliance approuvée :
- R2 privé : roster-batches/v1/<fingerprint>/campaigns/YYYY-MM-DD-reward-infos.json
- Contrat de reçus : version:1, kind:"alliance-infos-reward",
  campaign:"YYYY-MM-DD-reward", startedAt, capturedAt, expiresAt,
  allianceFingerprint, allianceName, rows (infos enrichies), observedAt
  (dates de lecture de chaque fiche).
- Progression séparée : reward/YYYY-MM-DD-progress.json.
- Aucun secret OAuth, identifiant de membre ou jeton n'est publié dans
  le reçu final. Le suivi temporaire est strictement privé.
- Les campagnes AM/PM continuent d'utiliser leurs propres fichiers.
- Le reçu est soumis au même horizon temporaire R2 que les campagnes Infos
  (expiresAt à sept jours) : il faudra intégrer les relevés autorisés dans
  un historique glissant pour le futur graphique, sans dépasser le TTL légal.

## Validation

    node --check src/member-info-reward.js
    node --test tests/member-info-reward.test.mjs

Les tests couvrent les horaires CET/CEST, le premier tick à 17:01,
l'exclusion de 17:00, les alliances et les garde-fous d'activation.

Cette PR concerne la **capture côté Worker**, sans changer le workflow
GitHub existant d'import Infos ni la page HTML. L'ajout d'un import
dédié aux relevés récompenses dans l'historique du graphique est une étape
distincte.
