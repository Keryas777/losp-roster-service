# Rattrapage initial automatique d'une alliance invitée

Le chemin `/admin#rosters` permet d'approuver une alliance **invitée** et de lui associer sa clé WebApp. Ces deux opérations sont administratives : aucune autorisation de collecte ne provient d'une simple connexion OAuth ou du rôle Discord.

## Déclenchement

Lorsque **l'approbation ET la liaison `allianceKey` sont présentes**, `handleGuestAllianceApproval` enregistre une file `roster-batches/v1/guest-initial-sync/<fingerprint>.json` dans le R2 privé (même règle de rétention de 7 jours).

- Aucun appel Scopely supplémentaire n'est effectué par ce déclencheur.
- Le Cron Cloudflare **déjà existant** (`* * * * *`) reprend une alliance à la fois, même après fermeture du navigateur.
- Une réapprobation sans changement ne relance pas une collecte achevée. La relance explicite est accessible dans l'administration.
- À chaque tick, l'autorisation **et** la liaison de l'alliance sont revérifiées ; leur retrait stoppe la file.
- Une seule phase consomme des appels fournisseur par tick. Si les collecteurs AM/PM, récompenses ou reprises de rosters ont déjà utilisé le quota de la minute, le rattrapage cède leur priorité.
- Le rattrapage expire au bout de 48 heures ou 160 tentatives. Les erreurs/rate limits entraînent des pauses bornées ; le suivi explique l'échec.

## Phases

1. **Rangs Guerre/Raid et trophées dès la première collecte** : lecture officielle de `/player/v1/alliance/card` avec `chooseAccount` et `discoverAlliance`, vérification de l'alliance réelle et de la liaison R2. Les rangs Guerre/Raid sont rattachés à la **dernière saison terminée**, selon le calendrier JSON dynamique `docs/data/alliance-standings/config.json`. Le total réel de trophées est immédiatement rattaché à la dernière date de collecte groupée enregistrée, en conservant son `capturedAt` d'origine.
2. **Infos enrichies** : réutilisation de `runMemberInfoTick`, avec au plus 8 fiches par passage au lieu des 2 habituelles. Crée un reçu AM/PM vérifié, sans toucher au collecteur quotidien ni publier les données privées dans GitHub. Une fois ces Infos complètes, le workflow GitHub Actions `publish-guest-joueurs.yml` est réveillé sans transmettre de pseudos/rosters dans le dispatch.
3. **Rosters partagés** : relance ciblée du collecteur incrémental existant dans sa campagne AM/PM réelle, sous verrou, limite initiale de 20 GET par tick. `rosterShare`, la liste réelle des membres et la rétention restent inchangés. Le mécanisme existant publie les rosters invités complets via GitHub Actions lorsque la publication est autorisée.
4. **Arène** : capture depuis les vrais reçus Infos. La première observation porte `sourceKind: onboarding` et `attribution: onboarding-current-observation`, sans se faire passer pour un relevé après récompenses. Le vrai relevé `reward` remplace ce point lorsqu'il existe.
5. **Trophées — vérification et reprise R2 uniquement** : réutilise le total de la première AllianceCard, sans second appel Scopely. Si le point a déjà été inséré, la phase est immédiatement terminée. Sinon, elle réessaie **à la dernière date de collecte groupée réelle enregistrée**, sans modifier l'heure d'observation de l'alliance et sans écraser les autres points. En l'absence de collecte groupée réelle, la file attend plutôt que de fabriquer une date.

Les futurs relevés post-guerre restent collectés selon la cadence habituelle et les premiers checkpoints hebdomadaires d’Évolution ont lieu le dimanche. La connexion OAuth et le partage de roster restent nécessaires pour les membres concernés.

## Administration et diagnostic

Dans **Rosters → Alliances connectées**, après l'association WebApp confirmée en R2, les boutons « Voir le rattrapage initial » et « Relancer les collectes initiales » consultent ou réinitialisent explicitement la file.

- `GET /admin/api/guest-initial-sync?fingerprint=<sha256>` : statut et phase, aucune donnée privée.
- `POST /admin/api/guest-initial-sync?fingerprint=<sha256>` avec `{"action":"restart"}` : relance **après validation Cloudflare Access** et vérification des approbations.
- État : `queued`, `running`, `complete`, `stopped`, `failed` ; phase `infos`, `roster`, `ranks`, `arena`, `trophies`, `done` ; le statut expose aussi l’envoi éventuel du workflow d’annuaire invité.

Aucune URL de capture non authentifiée n'est créée. Les endpoints invités WebApp continuent d'exiger une session Discord signée, l'association `allianceKey` et les autorisations R2 actuelles.

## Questionable Propriety

L'alliance `questionable-propriety` (rôle Discord `1568752859137318963`, couleur `#FFFFFF`) est déjà déclarée par la PR WebApp #545. **Ne pas démarrer de collecte avant son appartenance Scopely vérifiée et son approbation invitée**. L'approbation d'ENDGAME rouge est indépendante et peut être conservée pour son successeur.
