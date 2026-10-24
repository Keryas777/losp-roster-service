# Intégrité transactionnelle du différentiel MSF — reprise après Work (2026-10-23)

## Contexte et exclusions
Après la PR #79, l'archive différentielle existait déjà. Le rapport de reprise
Work a mis en évidence 3 problèmes : hash brut observé différent du hash
réellement stocké pour une réponse `meta.asOf`-only, publication prématurée
d'un pointeur avant le reçu, et absence de contrôle d'existence du blob.

Le présent correctif travaille **uniquement** sur le différentiel `/game/v1`.
Il ne relance ni collecte initiale ni audit de récupération historique.
Aucune lecture de production R2 ou requête réelle Scopely n'a été réalisée.
Les quotas, OAuth, lock Durable Object et fréquences de Cron sont inchangés.

## Format du pointeur `game-archive/v1/diff/latest/<SHA256(path)>.json`
La version 2 distingue explicitement :
- `sha256` : SHA-256 des octets **effectivement conservés** sous `objectKey`.
  La clé se termine obligatoirement par `/objects/<sha256>.json`.
- `observedSha256` : SHA-256 de la réponse du dernier GET. Il peut différer
  de `sha256` si seul `meta.asOf` a changé.
- `semanticHash` : hash de la réponse entière sans `meta.asOf`.
  Les autres champs officiels, connus ou inconnus, sont conservés.
- `storedAt` : date de conservation des octets pointés, **pas** date du
  dernier GET. Cette date ne peut pas être rafraîchie artificiellement.
- `checkedAt`, `lastChangedAt`, `changed`, `refreshed`.
- `receiptKey` : reçu durable correspondant à la dernière vérification.
- `runId`, `path` : provenance de la vérification.

Les pointeurs V1 restent lisibles. S'ils contiennent une discordance
`sha256/objectKey`, désignent un objet absent, ou n'ont pas de date de stockage
fiable, le prochain GET officiel repasse par un enregistrement certifié plutôt
que de réutiliser silencieusement l'objet douteux.

## Commit idempotent et ordre de persistance
Dans le verrou exclusif de la campagne :
1. Lire la tâche et un éventuel **reçu déjà commité au même ordinal** ;
   si présent et valide, terminer cette tâche directement à partir de R2,
   **sans nouveau GET Scopely ni nouveau débit de quota**.
2. Sinon réserver le budget, GET autorisé, calculer hash brut et sémantique.
3. Si nouvelle donnée, référence manquante ou stockage âgé : écrire
   l'objet et confirmer sa visibilité par `HEAD R2`. Sinon réutiliser
   l'objet vérifié.
4. Écrire un **reçu V2** `runs/<runId>/checks/<ordinal>.json`, déterministe,
   avant tout nouveau pointeur.
5. Vérifier l'objet du reçu. Mettre ensuite à jour `latest/`.
6. Rejouer de façon sûre la découverte de chemins officiels.
7. Incrémenter les compteurs, déplacer le curseur et écrire `state.json`.

Ainsi, une coupure après (4) reprend à partir du journal sans appel Scopely
additionnel. Une coupure avant (4) peut rejouer le GET sous les budgets normaux,
mais **ne publie jamais un pointeur sans reçu**.

Les échecs définitifs sont conservés sous un préfixe distinct `failures/`
avec nom UUID ; ils ne peuvent écraser un reçu de succès préexistant.
Un journal invalide ou un objet de journal absent empêche de déclarer le
contrôle réussi ; le bilan du run devient partiel.

## Fraîcheur et TTL contractuel
Le fichier local des conditions MSF fourni pour le projet énonce :
**maximum 30-day TTL pour toute Data obtenue via API** (section « You must
refresh your data no less frequently than every thirty (30) days »).

Le différentiel renouvellera un objet de stockage avant qu'il dépasse
**21 jours** s'il est observé identique sémantiquement ; l'objet est
ré-enregistré avec de nouveaux octets officiels et `storedAt` actuel,
avec `status=unchanged` et `refreshed=true`. Le renouvellement physique
n'est pas confondu avec un changement métier (`changed`).

**Limite explicite :** cela ne purge pas les objets anciens, qui sont
immuables. Les règles de durée de vie R2 du bucket doivent donc être
inspectées et configurées **séparément dans Cloudflare** pour supprimer
les anciens octets dans les 30 jours, en préservant les autres préfixes
et règles propres aux sessions OAuth. La conformité du bucket n'est PAS
établie par Wrangler. Un run hebdomadaire long ne garantit pas non plus
l'absence d'objet expiré entre deux vérifications.

La lecture future d'un catalogue doit contrôler `storedAt`, l'existence
de l'objet et la validité du reçu avant de déclarer un élément « frais ».
Cette publication dérivée est une étape distincte. N'utiliser ni
`checkedAt` ni une mise à jour du pointeur pour prolonger `storedAt`.

## Tests
Les tests locaux mockent Scopely, R2, les checkpoints et les Durable Objects :
- métadonnée `meta.asOf` seule : SHA de stockage intact et SHA observé distinct ;
- objet réel trop ancien : ré-archivage sans faux changement métier ;
- reçu impossible à écrire : aucun pointeur publié, aucun succès annoncé ;
- pointeur impossible à écrire après reçu : reprise du journal sans second GET ;
- anciennes références de hash incorrect : pas de réutilisation non certifiée ;
- tests précédents : découverte de nouveaux personnages, pagination, budgets,
  HTTP 429, cadence hebdomadaire, sécurité Access et absence de token exposé.

Les validations R2 en production, politiques de bucket et permissions Cloudflare
ne sont pas déduites d'une CI verte.

## Contrat minimal pour les futurs catalogues
Une ressource est éligible à un catalogue « validé » uniquement si
`sha256` correspond à `objectKey`, si `receiptKey` référence bien un
reçu confirmé, si l'objet existe et si `storedAt` respecte la période de
conservation et de fraîcheur applicable. Ne pas remplacer la disponibilité
du contenu par l'existence d'un `latest/` seul. Ce chantier ne publie
aucun catalogue dans la WebApp.

## Points volontairement non réalisés
- Reconstitution des 6 537 provenances historiques perdues ;
- nouvelle collecte complète ou appel Scopely de production ;
- suppression destructive d'archives historiques ;
- modification des règles R2 de production ;
- création des catalogues personnages/équipements/ISO ;
- déploiement ou merge de la PR.


## HTTP 472 et file de récupération (25 octobre 2026)

**Réutilisation stricte des alternatives déjà validées dans le collecteur initial :**

- Racine officielle avec IDs de détail finis (`upgradeData`,
  `iso8Abilities`, `analysis/teamOrder`) : appeler ces IDs exacts.
- Détail `characters/{id}` refusé : réutiliser
  `characterRecoveryTasks()` ; pour une variante `abilities` refusée,
  réutiliser `splitFailedAbilities()` (basic, special, ultimate, passive).
- Liste paginée refusée : réduire `perPage` de moitié et repartir de
  la page 1, sans fabriquer de données partielles ni ignorer des pages.

Les variantes sont ajoutées à **la file R2 existante** avec son ensemble de
déduplication par URL. Les métadonnées `recoveryOf/recoveryPart` sont
préservées. On ne recommence jamais la campagne ni ses checkpoints. Une
réponse 472 n'est **plus** traitée comme une erreur réseau temporaire
justifiant trois GET identiques séparés par 15 minutes.

Chaque échec final reçoit une entrée privée distincte, durable, par SHA
de l'URL dans `game-archive/v1/diff/recovery/pending/`.
Elle contient uniquement la route publique de jeu, le motif, la campagne,
les dates et le nombre de tentatives par campagne. Après trois campagnes
ayant échoué, l'URL reste signalée mais n'est plus automatiquement
réessayée : pas de boucle infinie. Le prochain passage hebdomadaire
examine les URL encore éligibles dans cet index R2, indépendamment de
la présence d'un pointeur `latest/`.

**Reprise rétroactive :** la campagne différentielle en cours avant
l'installation du correctif conserve intégralement ses compteurs, son
`runId`, son `readIndex` et son `readOffset`. Les anciennes entrées
`runs/<runId>/checks/<ordinal>.json` marquées `failed` sont examinées
**huit par passage**, sans GET Scopely, puis inscrites dans l'index
durable ; les 472 déclenchent les mêmes alternatives bornées.
Le curseur `recoveryBackfill` est sauvegardé pour reprendre cette lecture.
Les reçus historiques ne sont ni réécrits ni effacés.

**Traçabilité prudente :** réussir une variante n'est pas considéré comme
la réussite de la route initiale qui répondait 472. La vérification
différentielle reste `partial` lorsque des URL ont échoué ; un compteur
`recoveryQueued` distingue les tâches de récupération des contrôles
réussis. Une URL redevient `resolved` dans son index uniquement si
**sa propre requête** réussit. Les sauvegardes de ces métadonnées R2
restent privées, dans le préfixe `game-archive/v1/` soumis à la politique
de cycle de vie du bucket.

**Compatibilité avec PR #86 :** le différentiel conserve douze GET par
passage, la limite générale commune de 9 000 GET par jour et l'absence
de l'ancienne barrière spécifique de 1 500 GET par jour. Les HTTP 429
continuent de provoquer une pause d'une heure. Aucun appel Scopely
réel n'a été nécessaire à la validation.
