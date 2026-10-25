# Diagnostic privé des échecs du différentiel /game — 26 octobre 2026

## Besoin
Les compteurs `changed/unchanged/failed` du différentiel sont **cumulatifs**
par campagne. `failed` compte des événements et peut aussi inclure des
erreurs de découverte : il ne correspond pas au nombre de ressources distinctes
définitivement perdues. Les alternatives HTTP 472 sont enregistrées
indépendamment et ne résolvent pas automatiquement la route source.

## Emplacement
Administration protégée par Cloudflare Access → **Archives R2** →
« Diagnostic des échecs /game différentiels ».

- Déclenchement **uniquement au clic** « Analyser les échecs (R2) ».
- Endpoint GET privé `/admin/api/game-differential-failures`.
- Aucune lecture automatique à l'ouverture de la page.
- Aucun appel Scopely, aucune écriture R2, aucun Cron supplémentaire,
  aucune modification du différentiel ni des campagnes existantes.
- Au plus **40 entrées de registre R2 par requête**, avec pagination par
  curseur R2 opaque et affichage de la progression.
- Le navigateur assemble les pages, déduplique par URL et propose un filtrage
  par famille d'erreur et état. Il limite une action à 100 pages (4 000 entrées) ;
  si le registre est plus grand, le bouton permet de poursuivre.

## Source et interprétation des chiffres
Source R2 : `game-archive/v1/diff/recovery/pending/<sha256(URL)>.json`
et état agrégé `game-archive/v1/diff/state.json`.

Une ligne du registre représente une **URL**, et non un nombre de tentatives.
Le diagnostic donne :
- Registre : URL uniques avec état conservé, toutes campagnes confondues.
- Échecs par **motif le plus récemment enregistré** et grande catégorie.
- **En attente** : `status=pending`, y compris les URL avec variante réussie.
- **Tentatives épuisées** : sous-ensemble des URL `pending` avec
  `attempts >= 3`. Pas de nouvel essai automatique infini.
- **URL d'origine résolue** : `status=resolved` (succès de cette URL précis).
- **Avec variantes récupérées** : nombre d'URL parents possédant au moins
  une entrée `recoveredParts`. **Ne prouve pas** que le JSON original refusé
  a été reconstitué ou que la route source est de nouveau disponible.
- Progression du rattrapage des reçus historiques (`recoveryBackfill`).
  Tant que la lecture des anciens échecs n'est pas attestée terminée,
  les résultats sont explicitement présentés comme **partiels**.

**Ne pas calculer** `failed - pending` comme « URL récupérées » : il peut
y avoir des erreurs de découverte, des événements multiples sur la même URL,
des anciennes campagnes, et des lignes pas encore reprises.

Les objets et hashes de réponses officielles ne sont pas ouverts par cet
endpoint. Les informations R2 renvoyées sont strictement limitées aux
chemins officiels `/game/v1/`, aux motifs, compteurs, dates et statuts ;
aucune clé R2 interne, aucun jeton ou donnée joueur.

## Limites connues
Ce diagnostic est une photographie progressive du **registre de récupération**
et non un audit transactionnel global de toutes les écritures R2 ni un
histogramme de tous les événements d'échec historiques. Si les compteurs
d'une campagne évoluent entre deux pages, l'interface signale que la
photographie n'est pas homogène.

Le registre contient les échecs récents et ceux repris des anciens reçus.
Il n'inclut pas nécessairement les anomalies de découverte dont aucune URL
n'a été inscrite en récupération. Les anciennes archives orphelines restent
hors périmètre.

## Validation
Tests synthétiques R2 et protection Access :
- motifs HTTP 472/404/503 et erreur réseau ;
- états pending, resolved, exhausted ;
- variantes de récupération dédupliquées sans faux succès original ;
- pagination 40 entrées, contrôle strict des curseurs ;
- entrées invalides signalées et secrets non exposés ;
- lecture R2 en erreur signalée (pas de faux rapport vide) ;
- aucun GET Scopely, aucun `put` R2 ;
- déclenchement explicite et navigation mobile existante préservée.

Les tests n'interrogent ni l'API Scopely ni le bucket R2 de production.
