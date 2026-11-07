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
2. **Rangs et trophées courants** : lecture officielle de `/player/v1/alliance/card` par `chooseAccount` et `discoverAlliance`, avec contrôle de l'alliance réelle. Archive les rangs Guerre/Raid via la projection existante ; stocke le **total de trophées actuel**, à sa date réelle, dans un objet R2 privé.
3. **Arène** : capture à partir des vrais reçus Infos. La première observation porte `sourceKind: onboarding` et `attribution: onboarding-current-observation` ; elle ne simule pas le relevé quotidien après récompenses. Le vrai relevé `reward` remplace ce point lorsqu'il existe.
4. **Rosters partagés** : relance ciblée du collecteur incrémental existant dans sa campagne AM/PM réelle, sous verrou, limite initiale de 20 GET par tick. Le respect de `rosterShare`, de la liste réelle des membres et de la rétention reste inchangé. Le mécanisme existant publie les rosters invités complets via GitHub Actions lorsque la publication est autorisée.

La file **n'invente aucune date historique** : les points de trophées post-guerre restent collectés aux jours prévus et les premiers vrais checkpoints hebdomadaires d'Évolution ont lieu le dimanche. La connexion OAuth et le partage de roster restent nécessaires pour les membres concernés.

## Administration et diagnostic

Dans **Rosters → Alliances connectées**, après l'association WebApp confirmée en R2, les boutons « Voir le rattrapage initial » et « Relancer les collectes initiales » consultent ou réinitialisent explicitement la file.

- `GET /admin/api/guest-initial-sync?fingerprint=<sha256>` : statut et phase, aucune donnée privée.
- `POST /admin/api/guest-initial-sync?fingerprint=<sha256>` avec `{"action":"restart"}` : relance **après validation Cloudflare Access** et vérification des approbations.
- État : `queued`, `running`, `complete`, `stopped`, `failed` ; phase `infos`, `ranks`, `arena`, `roster`, `done`.

Aucune URL de capture non authentifiée n'est créée. Les endpoints invités WebApp continuent d'exiger une session Discord signée, l'association `allianceKey` et les autorisations R2 actuelles.

## Questionable Propriety

L'alliance `questionable-propriety` (rôle Discord `1568752859137318963`, couleur `#FFFFFF`) est déjà déclarée par la PR WebApp #545. **Ne pas démarrer de collecte avant son appartenance Scopely vérifiée et son approbation invitée**. L'approbation d'ENDGAME rouge est indépendante et peut être conservée pour son successeur.
