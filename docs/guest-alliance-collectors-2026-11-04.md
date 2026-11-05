# Alliances invitées — collectes privées avec consentement Scopely

Date : 4 novembre 2026. Cette modification étend **le Roster Service** ; elle
n'autorise aucune publication des données invitées par la WebApp actuelle.

## Flux

1. Un chef ou capitaine extérieur se connecte à `/captain` avec Scopely OAuth
   (notamment `m3p.f.pr.ros`, `m3p.f.ar.ros` et `offline` effectivement accordés).
2. Dans `/admin#rosters`, « Autoriser la collecte invitée » procède à un
   recensement Scopely frais. L'alliance doit être actuelle, disponible et
   associée à une session OAuth avec un unique membre `isSelf` vérifié.
   L'approbation nécessite le contrôle Cloudflare Access. Le rang en jeu
   n'est pas une permission OAuth et n'est donc pas un critère bloquant :
   les droits Scopely et `rosterShare` restent vérifiés par les collecteurs.
3. Seul le **fingerprint SHA-256 du stable aid** est inscrit dans
   `roster-sync/v1/approved-guest-alliances.json`. Pas de jeton, pseudo,
   roster, identifiant de membre temporaire ni nom d'alliance dans ce registre.
4. Les collecteurs existants résolvent les alliances LoSP plus les invitées
   via `readCollectibleApprovals`. Avant chaque lot ils utilisent la session
   OAuth active, revalident l'alliance actuelle et le partage `rosterShare` de
   chaque membre. Les membres sans partage ne sont **jamais** lus via
   `/player/v1/roster/member/{id}`. Le roster personnel du compte OAuth est
   lu séparément avec son propre scope.
5. « Révoquer la collecte invitée » retire immédiatement le fingerprint de
   la sélection pour les prochains lots. Les données R2 existantes sont
   limitées par leur durée de vie et doivent être purgées en cas de demande
   de déconnexion/retrait de données selon les conditions Scopely.

## Réutilisations / séparations

- **Rosters :** micro-lots AM/PM avec vérifications actuelles, Durable Object,
  checkpoints, plafonds de requêtes et cooldown. Aucun nouveau Cron.
- **Infos :** collectes AM/PM, puis capture post-récompenses à 17:01 Paris
  pour les rangs d'Arène de tous les membres de l'alliance. Aucune lecture de
  roster d'un membre sans partage pour cette tâche.
- **Arène :** historique glissant **invité privé** sous
  `roster-batches/v1/guest-arena-history/rolling.json`. L'API publique
  `/api/public/arena-history` et son historique LoSP restent inchangés.
- **Guerre / raid :** capture AllianceCard des invités dans
  `roster-batches/v1/guest-season-ranks/`, séparée du
  `roster-batches/v1/season-ranks/` LoSP.
- **Trophées :** les marqueurs AllianceCard des invités sont archivés par
  le collecteur de rosters, mais le déclenchement GitHub du jeudi/samedi
  reste **LoSP seulement**.
- **GitHub :** `dispatchCompleteRosterCampaign` et
  `dispatchCompleteTrophyCards` ne reçoivent que la liste LoSP originale.
  Une alliance invitée en panne ne bloque jamais les publications LoSP.
- **Autres familles /player :** l'archivage individuel enrichi conserve son
  périmètre LoSP ; les permissions invitées n'autorisent pas automatiquement
  inventaire, événements ou données privées supplémentaires.
- **Rétention :** tous les relevés invités ci-dessus restent sous le préfixe
  privé `roster-batches/v1/`, couvert par la règle R2 existante de **7 jours**.
  Ils ne constituent pas un historique permanent. Les autorisations Scopely
  ne permettent pas une conservation illimitée (max. 30 jours).

## Limites de cette PR / suite côté WebApp

Cette PR ne change pas `Keryas777/msf` :
- pas encore de publication ou import des rosters invités ;
- pas encore de snapshots hebdomadaires invités dans la WebApp ;
- pas encore de graphique invité accessible depuis sa page Discord ;
- pas de droit de lecture public des archives privées invitées.

L'intégration suivante devra relier chaque **fingerprint d'alliance
Scopely approuvée** au **groupement Discord autorisé** via un registre
administratif explicite, vérifier ce lien côté serveur sur chaque requête et
utiliser des projections authentifiées : masquer des tuiles en frontend ne
protège pas les rosters. Il faut ensuite produire les snapshots historiques
uniquement dans la fenêtre de conservation autorisée.

## Vérification avant activation

- Déployer cette branche après revue et tests ; aucune action sur la prod
  n'est exécutée par le dépôt ou la PR.
- Vérifier l'apparition de l'alliance invitée dans
  `/admin#rosters` et approuver **en invité**, pas en LoSP.
- Vérifier le statut `collecte invitée approuvée`, puis la présence de
  manifests `roster-batches/v1/{fingerprint}/latest-complete.json` et des
  fiches Infos sous le préfixe existant.
- Constater que les imports GitHub de LoSP ne contiennent aucune alliance
  invitée et que les six alliances LoSP restent complètes.
- Surveiller les erreurs 429, les dépenses en GET et la couverture des
  sessions : la cadence des collecteurs n'augmente pas, mais le nombre
  d'alliances en concurrence augmente.

## Extension du 5 novembre 2026 — rangs Guerre et Raid des invitées

- Les captures `AllianceCard` déjà programmées à 03:15 et 15:15 UTC
  restent privées. Seul le relevé **du lundi 03:15 UTC** est projeté
  dans `roster-batches/v1/guest-season-ranks/rolling.json`.
  Aucun nouvel appel à Scopely, Cron ou import GitHub supplémentaire.
- L’endpoint `GET /api/public/guest-season-ranks` fournit exclusivement
  les rangs Guerre et Raid des invitées encore approuvées et **identifiées**
  par une clé WebApp liée administrativement ou par un `publicId` déjà
  publié par l’historique des trophées. Les empreintes Scopely, identifiants
  des joueurs, jetons et chemins R2 ne sortent jamais de R2.
  La révocation ou la suppression d’une association prend effet au
  prochain GET. La projection conserve au plus 22 jours de captures
  sous la règle R2 existante de sept jours : moins de 30 jours en tout.
- La WebApp déduit **uniquement les saisons terminées** à partir de
  `docs/data/alliance-standings/config.json`. Les lundis intermédiaires
  ne créent aucun point. La première observation doit être réelle :
  une capture antérieure manquante n'est pas reconstruite.
- Dans `/admin#rosters` → Alliances connectées, après
  « Autoriser la collecte invitée », renseigner la **clé WebApp exacte**
  (la clé `key` dans `docs/data/alliances.json`) puis
  « Associer à la WebApp ». Un lien est propre à une seule alliance
  approuvée. Deux alliances affichant le même nom, notamment ENDGAME,
  doivent être associées séparément après vérification de leurs comptes
  connectés : ne **jamais** choisir automatiquement rouge/orange
  d’après le seul nom ou le rang. Effacer le champ et enregistrer
  pour retirer l'association sans révoquer la collecte.
- L’ancien import des six LoSP et les données privées des invités
  (rosters, Infos, Arène) restent inchangés. L’association d'affichage
  ne confère jamais de permission de collecte ou de lecture de roster.
- Déploiement : fusionner d'abord le Roster Service, **déployer son
  Worker Cloudflare**, vérifier l’endpoint sans données privées,
  puis fusionner le correctif WebApp associé. Le dépôt du Worker
  dispose de workflows de validation, mais **aucun déploiement automatique**
  sur `main` dans sa configuration GitHub Actions actuelle.
