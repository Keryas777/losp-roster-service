# Découverte automatique des salles de Dimensions noires

La découverte des salles est intégrée à la découverte de phase 2 existante, partagée par l'archive initiale et le différentiel. Quand une réponse validée à `/game/v1/dds/{ddId}` contient `data.rays`, seuls les IDs de rayons non vides qui respectent le format strict des IDs Scopely sont suivis. Les doublons sont retirés avant l'ajout à la file existante. Aucune position de carte ni aucun type de salle n'est déduit.

Chaque salle est demandée à l'endpoint officiel `/game/v1/dds/{ddId}/{roomId}` avec les expansions documentées `nodeReqs=full`, `nodeCombat=full` et `nodeRewards=full`. Toutes les réponses valides sont archivées intégralement, quel que soit le contenu renvoyé. Elles passent par la file, les plafonds, le verrou, les reçus, les checkpoints et le stockage R2 du collecteur différentiel courant.

## DD9 sans relancer l'archive

Après déploiement de cette modification, la prochaine vérification différentielle existante réexamine les routes déjà archivées, y compris la fiche DD9. Sa réponse `rays` met les salles en file automatiquement; les plafonds habituels répartissent les requêtes sur les passages Cron minute.

Il n'est pas nécessaire de relancer la campagne d'archive initiale. Le Cron actuel démarre les nouvelles campagnes différentielles le lundi à 01:00 et le jeudi à 13:00, heure de Paris. Comme la date de cette livraison est le mardi 10 novembre 2026, le prochain créneau est le jeudi 12 novembre 2026 à 13:00 Europe/Paris, si aucune campagne ne tourne déjà. Un créneau qui chevauche une campagne en cours est consommé par celle-ci.

L'achèvement peut dépasser la fenêtre du créneau : la collecte continue ensuite via le Cron minute jusqu'à épuisement du checkpoint ou des plafonds. L'API administrative en lecture seule ne déclenche pas de collecte. Pour suivre la progression, consulter le statut existant `GET /admin/api/game-differential` sous Cloudflare Access (`status`, `queued`, `checked`, `failed`, `nextRunAt`).