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

1. **Infos enrichies** : réutilisation de `runMemberInfoTick`, avec au plus 8 fiches par passage au lieu des 2 habituelles. Crée un reçu AM/PM vérifié, sans toucher au collecteur quotidien ni publier les données privées dans GitHub.
3. **Rangs Guerre/Raid de la saison précédente** : lecture officielle de `/player/v1/alliance/card` par `chooseAccount` et `discoverAlliance`, avec contrôle de l'alliance réelle. Archive les rangs Guerre/Raid via la projection existante, qui les rattache à la **dernière saison terminée** grâce au calendrier JSON dynamique ; stocke le **total de trophées actuel** dans un objet R2 privé, avec son heure réelle de récupération.
4. **Arène** : capture à partir des vrais reçus Infos. La première observation porte `sourceKind: onboarding` et `attribution: onboarding-current-observation` ; elle ne simule pas le relevé quotidien après récompenses. Le vrai relevé `reward` remplace ce point lorsqu'il existe.
2. **Rosters partagés** : relance ciblée du collecteur incrémental existant dans sa campagne AM/PM réelle, sous verrou, limite initiale de 20 GET par tick. Le respect de `rosterShare`, de la liste réelle des membres et de la rétention reste inchangé. Le mécanisme existant publie les rosters invités complets via GitHub Actions lorsque la publication est autorisée.

À la fin de la collecte Infos, la file déclenche également le workflow GitHub Actions déjà existant `publish-guest-joueurs.yml` pour publier le répertoire minimal des pseudos invités sans attendre l'heure programmée. Le dispatch ne transmet aucun pseudo ni roster au service GitHub et n'empêche pas les autres phases si GitHub est indisponible.

5. **Trophées — rattachement initial** : réutilise le total réel extrait de la première AllianceCard, sans second appel Scopely. Le point est intégré **à la dernière date de collecte groupée réelle enregistrée** dans l’historique partagé. L’heure d’observation Scopely reste celle de la collecte initiale : `capturedAt` ne subit aucun antidatage. Le relevé groupé original et les autres alliances sont préservés ; une répétition ne remplace pas un point déjà enregistré. Si aucune collecte groupée réelle n’existe, la file retente depuis R2, sans fabriquer une date.

Les futurs relevés post-guerre restent collectés selon la cadence habituelle et les premiers checkpoints hebdomadaires d’Évolution ont lieu le dimanche. La connexion OAuth et le partage de roster restent nécessaires pour les membres concernés.

## Administration et diagnostic

Dans **Rosters → Alliances connectées**, après l'association WebApp confirmée en R2, les boutons « Voir le rattrapage initial » et « Relancer les collectes initiales » consultent ou réinitialisent explicitement la file.

- `GET /admin/api/guest-initial-sync?fingerprint=<sha256>` : statut et phase, aucune donnée privée.
- `POST /admin/api/guest-initial-sync?fingerprint=<sha256>` avec `{"action":"restart"}` : relance **après validation Cloudflare Access** et vérification des approbations.
- État : `queued`, `running`, `complete`, `stopped`, `failed` ; phase `infos`, `roster`, `ranks`, `arena`, `trophies`, `done` ; le statut expose aussi l’envoi éventuel du workflow d’annuaire invité.

Aucune URL de capture non authentifiée n'est créée. Les endpoints invités WebApp continuent d'exiger une session Discord signée, l'association `allianceKey` et les autorisations R2 actuelles.

## Questionable Propriety

L'alliance `questionable-propriety` (rôle Discord `1568752859137318963`, couleur `#FFFFFF`) est déjà déclarée par la PR WebApp #545. **Ne pas démarrer de collecte avant son appartenance Scopely vérifiée et son approbation invitée**. L'approbation d'ENDGAME rouge est indépendante et peut être conservée pour son successeur.
