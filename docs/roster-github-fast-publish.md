# Publication rapide des rosters LoSP via GitHub Actions

## Pourquoi ?

Les évènements GitHub Actions `schedule` peuvent arriver plusieurs heures en retard.
La collecte officielle Scopely reste dans Cloudflare Worker, en R2 privé, pendant
**02:00–04:00 UTC** (AM) et **14:00–16:00 UTC** (PM).
Le Worker peut désormais réveiller l'importateur GitHub **dès que les reçus R2
des alliances autorisées sont tous complets**. Les horaires `schedule`
existants restent des secours indépendants.

## Activer après fusion et déploiement des deux dépôts

1. Sur **Keryas777/msf**, fusionner la PR correspondante et confirmer que le
   workflow `.github/workflows/pull-rosters-r2.yml` accepte l'entrée
   `strict` pour les appels `workflow_dispatch`.
2. Dans GitHub, créer un jeton **fine-grained**, limité au seul dépôt
   `Keryas777/msf`, avec l'autorisation de dépôt **Actions: Read and write**.
   Ne pas utiliser de jeton Scopely/OAuth et ne jamais committer le jeton.
3. Dans Cloudflare, pour **losp-roster-service**, ajouter le secret
   `ROSTER_GITHUB_DISPATCH_TOKEN` avec `wrangler secret put` ou le tableau
   de bord Cloudflare. La valeur ne doit apparaître ni en clair dans le dépôt
   ni dans les logs.
4. Activer `ROSTER_GITHUB_DISPATCH_ENABLED=true` dans la configuration
   déployée (variable Worker). **La valeur du dépôt est volontairement false**
   jusqu'à l'activation explicite. Redéployer la version contenant le module.
5. Vérifier une campagne suivante : un seul import `workflow_dispatch`
   apparaît dès que toutes les alliances approuvées sont complètes ; le run
   valide de nouveau tous les fichiers R2 et publie les JSON sur `main`.
   Contrôler les journaux, le statut d'import et les commit(s) effectifs.

## Garde-fous

- Aucun changement au système d'autorisations, au nombre d'appels Scopely,
  aux chemins R2 existants ou aux fenêtres de collecte.
- Aucun nouveau Cron Cloudflare ni backend : un seul appel REST GitHub sortant
  une fois l'ensemble des reçus complets et après contrôle de consentement.
- Les jetons sont uniquement dans les secrets Cloudflare.
- Un indicateur privé R2 `roster-auto/v1/github-dispatch/YYYY-MM-DD-am|pm.json`
  évite le second déclenchement ; une réponse GitHub non-204 ne le crée pas.
  Une vérification intervient au plus toutes les 5 minutes en secours.
- La publication GitHub doit revalider elle-même tous les fichiers ; l'appel
  du Worker ne constitue pas une preuve de publication réussie.
- Les anciens déclenchements programmés restent actifs si le jeton manque ou
  si GitHub est indisponible. Le marqueur signifie **dispatch accepté**,
  jamais « import réussi ».
- Le contrôle de monotonie dans `msf` interdit à un ancien import AM/PM de
  remplacer une campagne publiée plus récente.

**Remarque :** un événement `workflow_dispatch` réduit la dépendance
aux Cron GitHub, mais GitHub Actions ne garantit pas une heure exacte de
démarrage ou la disponibilité immédiate d'un runner.

## Trophées de guerre : réveil indépendant des rosters

Le jeudi et le samedi, dès 02:00 UTC, chaque première vérification valide
du capitaine donne déjà une réponse `/player/v1/alliance/card`.
Sans nouvelle requête Scopely, le Worker archive cette réponse dans le
préfixe R2 privé `roster-batches/v1/` (rétention existante de sept jours),
puis crée un marqueur de disponibilité propre à l'alliance et à la campagne.

Quand toutes les alliances approuvées disposent de leur marqueur valide,
`src/trophy-github-dispatch.js` lance
`pull-alliance-standings-r2.yml` avec `early=true`, sans attendre la fin
des rosters des joueurs. Le contrôle est refait à chaque nouvelle lecture
et toutes les cinq minutes en secours. L'envoi utilise le secret
`ROSTER_GITHUB_DISPATCH_TOKEN` déjà dédié à GitHub ; il est activable
indépendamment par `TROPHY_GITHUB_DISPATCH_ENABLED` (déclaré `true` dans
`wrangler.jsonc`).

L'Action relit l'enveloppe source officielle en R2, vérifie les six
identités et nombres, puis applique son propre verrou de publication :
`LOSP_R2_HISTORY_PUBLICATION_APPROVED=true`. Aucune donnée privée n'est
transmise dans le POST GitHub ; ce dernier ne contient que le jour UTC.
Un dispatch HTTP 204 est un réveil accepté, pas la preuve d'un import réussi.
Les horaires GitHub restent des secours ; aucune modification des autres
tâches de rosters ni aucun appel Scopely supplémentaire.
