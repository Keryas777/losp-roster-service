# Synchronisation différentielle automatique `/game/v1`

## Problème précédent
Le Cron `* * * * *` poursuivait uniquement la campagne R2 initiale.
Une fois terminée, aucun nouveau balayage périodique n'était lancé.

## Nouveau comportement
- `GAME_DIFF_ENABLED=true` : une **première vérification automatique** démarre après clôture de la campagne initiale **et de sa phase 2**.
- Ensuite, une **nouvelle passe hebdomadaire** commence 7 jours après la précédente passe terminée. Si une passe n'est pas terminée, elle reprend chaque minute plutôt que d'en créer une autre.
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
- Maximum 3 GET officiels par tick différentiel et 1 500 GET par jour UTC, sous réserve de la limite totale existante de 9 000 GET/jour. Arrêt immédiat et une heure de pause en cas de HTTP 429.
- OAuth `client_credentials` de l'application seulement. Aucun accès au roster, aux membres, aux données `/player`, ni aux secrets exposés côté navigateur.
- Ne provoque **aucun appel Scopely à l'ouverture de l'administration**.
- Le bilan global `Vue d’ensemble` affiche la dernière date de changement, le statut, les changements, les inchangés et les échecs. `GET /admin/api/game-differential` expose seulement les compteurs R2 sous Cloudflare Access.

## Limites à signaler honnêtement
- Pas de paramètre universel `since`/ETag démontré par la spécification OpenAPI beta 0.2.1 pour toutes les familles : les réponses sont effectivement relues et comparées localement, pas sollicitées via un hypothétique filtre serveur.
- La vérification de toutes les URL connues peut s'étaler sur plusieurs jours en présence de nombreuses routes et de plafonds Scopely. Le tableau indique « checking », jamais « synchronisé » prématurément.
- Le balayage n'est pas une preuve de complétude absolue : routes non découvertes, sources initialement absentes et fichiers non indexables restent des lacunes explicites.
- Aucun accès direct au R2 de production pendant cette PR ; les dates et chiffres réels ne sont connus qu'après fusion/déploiement.
