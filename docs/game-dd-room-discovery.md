# Découverte automatique des salles de Dimensions noires

La découverte des salles est intégrée à la découverte de phase 2 existante, partagée par l'archive initiale et le différentiel. Quand une réponse validée à `/game/v1/dds/{ddId}` contient `data.rays`, la grille imbriquée est aplatie pour extraire les seuls IDs non vides qui respectent le format strict des IDs Scopely. Les doublons sont retirés avant l'ajout à la file existante. Aucune position de carte ni aucun type de salle n'est déduit.

Chaque salle est demandée à l'endpoint officiel `/game/v1/dds/{ddId}/{roomId}` avec les expansions documentées `nodeReqs=full`, `nodeCombat=full` et `nodeRewards=full`. Toutes les réponses valides sont archivées intégralement, quel que soit le contenu renvoyé. Elles passent par la file, les plafonds, le verrou, les reçus, les checkpoints et le stockage R2 du collecteur différentiel courant.

## Déclenchement ciblé DD9

La route privée `POST /admin/api/game-differential-dd9` lit les 23 rayons de la fiche officielle DD9 déjà archivée, ignore les réponses complètes déjà pointées dans R2 et ajoute le reste à la file/checkpoint différentiel courant. Elle refuse d'écrire pendant qu'une campagne différentielle est active. Elle réutilise le verrou, les reçus, le budget /game partagé (9 000 GET/jour) et le Cron minute déjà déployé; aucun nouveau Cron, bucket ou collecteur n'est ajouté.

Après fusion et déploiement du Worker, appeler cette route depuis la session d'administration Cloudflare Access autorisée. L'appel ne fait pas de GET Scopely lui-même: le Cron minute reprend automatiquement le checkpoint et collecte au plus 12 tâches par tick. Suivre `GET /admin/api/game-differential` et vérifier ensuite les objets, reçus et pointeurs DD9 dans R2. La mise en file seule ne constitue pas une collecte achevée.

Une réponse officielle DD9 reste dans le R2 privé du service roster. La WebApp `Keryas777/msf` n'est pas modifiée par cette collecte; son raccordement au classement théorique doit consommer ces réponses via un exporteur/publication explicite vers la source de données existante du dépôt `msf`. Aucun second stockage public n'est créé ici.
