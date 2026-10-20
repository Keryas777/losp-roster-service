# Audit approfondi automatique de l'archive officielle MSF R2

## Portée

Cette évolution complète l'inspecteur ponctuel de la PR #65.
Elle ne touche ni la collecte Scopely, ni les rosters OAuth, ni la PWA,
ni la WebApp GitHub Pages, ni les objets JSON bruts en R2.

- `POST /admin/api/game-archive-schema-audit` avec
  `{"action":"start"}` initialise un audit pour le **runId actif** ;
- `GET /admin/api/game-archive-schema-audit` lit le rapport privé ;
- Tous deux passent par l'authentification Cloudflare Access
  déjà présente sur `/admin` et utilisent les contrôles CSRF
  du Worker pour le POST ;
- Le Cron `* * * * *` existant exécute l'audit **après la collecte**
  du minuteur, avec des opérations **R2 uniquement** ;
- Aucune demande à Scopely, aucun jeton de joueur et aucune écriture
  sous `receipts/`, `objects/`, `raw/`, `progress.json` de
  la collecte, `queue/` ou `phase2-seen/`.

## Accélération des reçus (PR suivante)

La taille du lot augmente de 35 à **200 reçus maximum par minute**.
Les petits fichiers de reçus sont lus avec **cinq requêtes R2 simultanées
au maximum**, sans modifier la profondeur d'analyse, les six documents
maximum ou la provenance des données. Les opérations R2 sont des
sous-requêtes internes Cloudflare (limite publiée : 1 000 par
invocation, même sur Free). Une passe d'audit doit rester sous
ce plafond, y compris après les lectures du collecteur réalisées
plus tôt dans la même invocation.

Le curseur déjà sauvegardé et le `runId` **ne sont pas réinitialisés**.
Le taux de 200/minute est une capacité maximale, pas un engagement de
durée en cas d'erreur R2 ou de latence Cloudflare. Si la campagne
de collecte continue, le rapport final reste un instantané non exhaustif.

## Stockage de l'audit

`game-archive/v1/runs/{runId}/schema-audit/progress.json`.

Ce fichier contient uniquement un curseur de reçus, des compteurs,
des noms et types de champs, des signatures de structures et des
chemins d'exemple de ressources générales du jeu. Les réponses
originales, leurs valeurs métiers et les secrets ne sont pas copiés.
La future politique de rétention du préfixe devra englober ces
rapports dérivés conformément aux conditions API Scopely.

## Bornes et méthode

À chaque passage :

- 200 reçus au plus de `runs/{runId}/receipts/` ;
- Six documents JSON décodés au plus après `R2.head` ;
- Taille maximale inspectée : **1,25 Mo** par document ;
- 48 échantillons inspectés maximum **par famille** ;
- 150 chemins de champs et 20 signatures de structures conservés
  maximum par famille ;
- Profondeur jusqu'à sept niveaux, exploration de six éléments
  par tableau, 40 clés au maximum par objet ;
- Priorité aux familles qui n'ont **pas encore** d'échantillon.
  Les très nombreux reçus `events` ne doivent pas empêcher
  l'analyse de `raids`, `traits` ou `iso8Abilities`.

Le rapport compte les reçus de toutes les familles parcourues, mais
les **fréquences de champs** portent exclusivement sur les documents
effectivement analysés. Les documents trop grands, non indexés,
non lisibles, ou dont le reçu indique une clé extérieure au run
sont comptés séparément. Aucun échantillonnage ne constitue une
preuve d'exhaustivité du schéma ou des relations : il faut ensuite
valider les champs utiles sur des exemples de valeurs autorisées.

Les signatures sont calculées sur les clés principales et les
types de `data` rencontrés. Elles permettent de repérer des
variantes telles que `events` avec `milestone` ou `details`,
sans imposer un schéma uniforme.

## Expérience administrateur

La section **Audit automatique des structures JSON R2** propose :

1. « Lancer l'audit des structures » : une action unique ;
2. « Actualiser le rapport » : état après progression du Cron,
   toujours disponible même après fermeture du navigateur ;
3. Sélectionner une famille pour examiner ses variantes et ses
   chemins imbriqués ;
4. « Copier le rapport JSON » pour analyser les résultats.
   Le rapport est limité aux structures, pas aux valeurs des
   données officielles.

L'audit termine à l'état `snapshot-complete` lorsque le curseur
R2 atteint la fin de liste. **Si la collecte est encore active**
à cet instant, le rapport l'indique et il faut relancer manuellement
l'audit après la fin de la campagne. Il n'invente pas un état
`exhaustive` et n'affirme pas une cohérence transactionnelle
sur une liste modifiée pendant la progression du scan.

## Travaux ultérieurs

- Inspecter autrement les grandes réponses `raw-unindexed` et
  les JSON supérieurs à 1,25 Mo, avec lecture streaming contrôlée ;
- Établir les liens d'identifiants en validant leurs **valeurs**
  sous protection admin (cet audit n'expose que les clés/types) ;
- Construire les vues normalisées dans R2 après qualification
  de la qualité et de la couverture ;
- Réactualiser les données API au maximum tous les 30 jours
  et supprimer les dérivés devenus obsolètes selon les règles
  contractuelles.
