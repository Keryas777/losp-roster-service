# Diagnostic /game différentiel reprenable sans navigateur — 30 octobre 2026

## Problème corrigé
Le diagnostic précédemment calculé entièrement dans
`public/admin-game-differential-diagnostic.js` interrompait sa boucle
au rechargement ou à la fermeture de Safari. Les compteurs et la pagination
étaient uniquement en mémoire navigateur.

## Nouveau contrat
- L'administrateur déclenche **une seule fois** l'audit depuis
  **Archives R2 → Diagnostic des échecs /game différentiels**.
- POST privé `/admin/api/game-differential-failure-audit`,
  protégé par Cloudflare Access + liste d'administrateurs + vérification Origin.
- Progression persistante :
  `game-archive/v1/diff/failure-audit/v1/progress.json`.
- Le Cron **déjà présent** (`* * * * *`) continue l'analyse par lots de
  16 entrées R2, sous verrou Durable Object indépendant.
- GET du même endpoint renvoie les compteurs sauvegardés (sans curseur R2).
  Le navigateur ne fait que consulter ce GET. Actualiser ou fermer l'onglet
  n'interrompt pas l'analyse.
- Les URL détaillées restent disponibles à la demande par l'ancien endpoint
  paginé `GET /admin/api/game-differential-failures`. L'interface ne charge
  plus automatiquement des centaines de pages et indique explicitement
  que les filtres de détail portent sur les seules lignes chargées.
- Un nouveau calcul demande un redémarrage **manuel**, seulement après la
  clôture précédente.

## Périmètre et limites
- Aucun GET Scopely, aucune action sur /player, aucun nouveau Cron.
- Ne touche ni aux données brutes, ni aux reçus, ni aux pointeurs
  `latest/`, ni à la file de récupération et aux quotas /game.
- Seul le checkpoint du diagnostic est écrit. Pas de collecteur relancé.
- Les compteurs distinguent URL distinctes du registre, états en attente,
  tentatives épuisées, résolutions de l'URL initiale, variantes récupérées,
  erreurs de validation et motifs de la dernière tentative.
- `failed` dans l'état du collecteur représente des **événements**,
  pas directement des URL distinctes.
- Le registre évolue au fil des collectes : si son checkpoint de référence
  change entre le début et la fin, `sourceChanged=true` signale
  explicitement une photographie non homogène.
- La progression n'est pas exprimée en pourcentage, car R2 ne donne pas
  un total fiable des nouvelles clés avant l'achèvement.
- Une interruption temporaire de lecture R2 laisse le curseur inchangé :
  le Cron réessaie un lot ultérieur.
- L'exécution est volontairement bornée par invocation pour laisser
  de la place aux opérations /game déjà en production.

## Vérifications recommandées après merge et déploiement
1. Depuis l'admin, lancer le diagnostic une fois.
2. Vérifier que `stats.scanned` augmente dans GET sans navigation active.
3. Fermer Safari, puis rouvrir : le même état et ses comptes doivent revenir.
4. Vérifier la fin `snapshot-complete` et les codes par groupe/motif.
5. Contrôler que les journaux Scopely et les quotas API n'ont pas augmenté
   du fait de ce diagnostic.
