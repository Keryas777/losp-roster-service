# Synchronisation différentielle automatique `/game/v1`

## Problème précédent
Le Cron `* * * * *` poursuivait uniquement la campagne R2 initiale.
Une fois terminée, aucun nouveau balayage périodique n'était lancé.

## Nouveau comportement
- `GAME_DIFF_ENABLED=true` : une **première vérification automatique** démarre après clôture de la campagne initiale **et de sa phase 2**.
- La cadence de base reste **une passe 7 jours après la fin de la précédente passe hebdomadaire**. Une passe intermédiaire ne repousse pas cette échéance.
- **Une collecte supplémentaire démarre le vendredi à 01:00 (heure `Europe/Paris`, CET/CEST)**, dans la fenêtre 01:00–01:59. Chaque vendredi est consommé une seule fois au démarrage, y compris si le passage de 7 jours tombe au même moment.
- Si une passe est déjà en cours le vendredi à 01:00, elle continue ; aucune seconde campagne parallèle ne démarre. Si le créneau du vendredi s'écoule pendant cette passe, il est ignoré plutôt que rattrapé par un doublon.
- Ces deux échéances réutilisent le Cron Cloudflare `* * * * *`, le même verrou Durable Object, les mêmes reçus et le même budget ; **aucun Cron supplémentaire** n'est configuré.
- Aucune réinitialisation de `game-archive/v1/active.json` et aucune modification/destruction des archives originales.
- Index des URLs exactes tirées des reçus originaux, des précédentes vérifications différentielles et des 17 racines officielles. Les six racines épisodiques sont ajoutées.
- Les mêmes mécanismes de découverte prudente que l'archive initiale retrouvent les nouveaux IDs présents dans les listes et associations officiellement documentées, avec contrôle de pagination.
- Les données brutes sont comparées par SHA-256. Si `meta.asOf` change seul, une empreinte du contenu JSON sans ce champ évite de compter une modification artificielle ; tous les autres champs, y compris inconnus, sont comparés.
- Une version R2 supplémentaire n'est enregistrée **que si la réponse a changé** ; les passages inchangés ne recopient pas le JSON.
- Index privé de dernière version par route, reçu horodaté par vérification, comptage `changed / unchanged / failed`.
- Les réponses impossibles à vérifier (dont JSON volumineux non indexable) sont explicitement comptées comme échecs/incertitudes, pas comme archives fraîches certifiées.
- Rétention des archives d'origine et des delta sous `game-archive/v1/` : aucune suppression ni diffusion publique.

## Prévention des régressions
- Le différentiel utilise le **même verrou Durable Object** et le **même compteur journalier /game** que le collecteur initial. Il ne peut donc pas dépasser ou contourner ses limites.
- Maximum **12 traitements par passage** (les reprises journalisées ne consomment pas de GET Scopely), sous le plafond `/game` existant de **9 000 GET/jour UTC**. Arrêt immédiat et une heure de pause en cas de HTTP 429. Le deuxième rendez-vous hebdomadaire n'augmente pas ce budget.
- OAuth `client_credentials` de l'application seulement. Aucun accès au roster, aux membres, aux données `/player`, ni aux secrets exposés côté navigateur.
- Ne provoque **aucun appel Scopely à l'ouverture de l'administration**.
- Le bilan global `Vue d’ensemble` affiche la dernière date de changement, le statut, les changements, les inchangés et les échecs. `GET /admin/api/game-differential` expose seulement les compteurs R2 sous Cloudflare Access.
- L'état expose désormais `scheduleTrigger`, `weeklyCompletedAt`, `lastFridaySlot` et `fridaySchedule`. Le champ `nextRunAt` continue à indiquer **l'échéance des 7 jours**, et non le vendredi supplémentaire.

## Limites à signaler honnêtement
- Pas de paramètre universel `since`/ETag démontré par la spécification OpenAPI beta 0.2.1 pour toutes les familles : les réponses sont effectivement relues et comparées localement, pas sollicitées via un hypothétique filtre serveur.
- La vérification de toutes les URL connues peut s'étaler sur plusieurs jours en présence de nombreuses routes et de plafonds Scopely. Le tableau indique « checking », jamais « synchronisé » prématurément.
- Le balayage n'est pas une preuve de complétude absolue : routes non découvertes, sources initialement absentes et fichiers non indexables restent des lacunes explicites.
- Aucun accès direct au R2 de production pendant cette PR ; les dates et chiffres réels ne sont connus qu'après fusion/déploiement.

## Événements : collecte quotidienne indépendante (5 novembre 2026)

- Le catalogue public `/game/v1/events` est vérifié chaque jour à partir de **03:17 UTC**, indépendamment des passes générales de 7 jours et du vendredi. Les passages ne s'exécutent pas en double le même jour.
- Le Cron Cloudflare `* * * * *`, OAuth `client_credentials`, le verrou Durable Object et le budget global `/game` de 9 000 GET/jour sont réutilisés. Aucune nouvelle tâche planifiée, clé ni accès `/player`.
- Récupération complète de toutes les pages anglaises (100 éléments/page, maximum 10 pages), puis tentative de récupération des pages françaises. Toute page anglaise invalide ou manquante bloque la publication ; les textes français incomplets retombent sur un **catalogue anglais complet de la même collecte**.
- Un **seul objet R2** `game-archive/v1/events-daily/current.json` est remplacé après vérification de l'ensemble, avec empreinte SHA-256. Aucune mise à jour partielle ni snapshot GitHub Pages ; la publication publique privilégie cet objet atomique.
- En cas d'échec, le dernier catalogue R2 complet demeure consultable pendant au plus **48 heures** depuis sa vérification, puis `/api/public/events` répond 503 plutôt que d'afficher des données périmées. Un échec HTTP 429 impose une pause d'une heure ; les autres échecs, quinze minutes.
- Seule la période de migration sans objet quotidien accepte les anciennes pages R2 hebdomadaires si leur **dernière vérification date de moins de 48 heures**. Jamais de fichier JSON statique embarqué dans le navigateur.
- `GAME_EVENTS_DAILY_ENABLED=false` peut désactiver ce collecteur indépendamment du différentiel en cas d'incident, sans ajouter de configuration obligatoire en fonctionnement normal.
- Les événements privés ou conditionnés au compte ne sont pas récupérés : l'API `/player/v1/events` nécessite OAuth personnel et consentement, hors périmètre de cette fonctionnalité.
