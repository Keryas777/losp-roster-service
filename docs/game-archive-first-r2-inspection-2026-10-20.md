# MSF — Première exploration du contenu R2 (lecture seule)

Date : 20 octobre 2026. Dépôt : `Keryas777/losp-roster-service`.

## Pourquoi cette étape

La collecte `/game/v1/` continue de remplir le bucket privé
`losp-roster-sessions`, sous le préfixe `game-archive/v1/`.
Le dépôt décrit comment les octets et les reçus sont stockés, mais
**le code GitHub ne permet pas de connaître le contenu exact des
JSON déjà présents dans R2**. Il faut interroger ce bucket en lecture
seule avant de définir un modèle d'exploitation fiable.

## Échantillonneur R2

Le nouvel endpoint **administrateur** `GET /admin/api/game-archive-inspect`
utilise le même contrôle Cloudflare Access que l'admin existante.
Il ne télécharge rien de Scopely et n'écrit ni ne supprime d'objet R2.

Pour chaque demande :
- Cherche uniquement les reçus du `runId` désigné par
  `game-archive/v1/active.json` ;
- Parcourt au maximum **20 reçus** avec le curseur opaque R2 ;
- Accepte uniquement les reçus HTTP 200 ayant un chemin
  `/game/v1/...` et un `objectKey` interne à
  `runs/{runId}/objects/{sha256}.json` ou
  `runs/{runId}/raw/{uuid}.json` ;
- Lit au maximum **quatre petits JSON** de familles différentes
  par demande. La taille est vérifiée par `R2.head` avant lecture ;
  les objets de plus de **750 ko** ne sont pas chargés ;
- Renvoie la famille, la route, la taille, l'horodatage de récupération,
  le type de `data` et les **noms** des champs racine, `data`,
  premier élément de liste et `meta` (plus trois identifiants
  d'exemple validés). Aucune valeur arbitraire, JSON intégral, clé R2
  privée, jeton ou réponse joueur n'est envoyée au navigateur ;
- Distingue `indexed` de `raw-unindexed` sans présenter le second
  comme analysé.

Le navigateur peut parcourir les lots successifs et **copier un
rapport JSON cumulatif** des familles vues et de deux structures
d'exemple par famille. Ce rapport est un **échantillon**, jamais
un inventaire total ou une certification d'exhaustivité.

## Ce que l'on saura après un échantillonnage réel

1. Quelles familles de ressources renvoient des objets, tableaux,
   dictionnaires ou formes mixtes ;
2. Quelles clés et structures existent vraiment par famille ;
3. Quels champs de pagination, date, identifiant et métadonnées sont
   fournis dans les objets rencontrés ;
4. Quelles familles méritent d'être traitées en priorité et lesquelles
   nécessitent un parsing en streaming.

Ce qui **ne sera pas démontré** : le nombre total d'objets du bucket,
leur schéma complet, le taux de couverture de toute l'API, la
reconstitution des réponses 472, ni le succès d'une conversion
`CSV/JSON` de toutes les données.

## Architecture cible après inspection

Séparer trois responsabilités :

- **Source brute et provenance** : conserver temporairement les
  JSON officiels et leurs reçus datés, sous la règle contractuelle
  maximale de 30 jours ;
- **Index de ressources** : associer `family`, `resourceId`,
  `queryVariant`, `sourceTimestamp`, `observedAt`,
  `status` et l'empreinte du document, sans copier inutilement
  les blobs ;
- **Vues dérivées** : un format par domaine (personnages, capacités,
  objets, iso8, raids, événements, etc.) et une table de relations
  explicites avec provenance/qualité. Les dérivés contenant des
  données API doivent respecter **eux aussi** leur durée contractuelle.

Ne pas fusionner aveuglément plusieurs variantes partielles en une
pseudo-réponse `full` ; gérer les champs manquants. Conserver les
types d'origine et consigner les règles de transformation. Éviter
une base SQL, un framework ou des dépendances côté client. Un
générateur incrémental Worker/R2 peut ensuite fournir de petits JSON
statiques pour la WebApp (sous réserve de l'autorisation de
publication et de la politique de conservation Scopely).

## Sécurité et exploitation

- Aucun changement du Cron toutes les minutes, de la file de tâches,
  des quotas Scopely, du stockage des rosters ou de GitHub Pages ;
- Le texte des propriétés affichées est injecté avec `textContent`
  exclusivement ; pas d'évaluation d'objet distant ;
- Déclenchement manuel uniquement, sans boucle navigateur
  automatique et sans rafraîchissement en arrière-plan ;
- Le rapport de copie reste local au navigateur et demande une action
  explicite. Il contient uniquement des structures d'API jeu,
  pas de données personnelles ;
- La documentation contractuelle MSF API Terms of Use (03/03/2022)
  prévoit un maximum de 30 jours pour les données obtenues via
  les Developer APIs : cet outil **n'autorise aucune archive perpétuelle**.

## Prochaines vérifications

Après déploiement :
1. Cliquer « Examiner les premières archives » dans `/admin`.
2. Parcourir quelques lots de reçus (bouton « lot suivant »).
3. Copier le résumé JSON dans ChatGPT pour une analyse des **champs réellement obtenus**.
4. Concevoir ensuite le convertisseur et son index de provenance à
   partir de ce rapport, pas d'une structure supposée.
