# Diagnostic de couverture des rosters en R2 — 21 octobre 2026

## Objectif

Vérifier la **couverture réelle** des alliances LoSP déjà approuvées, après
activation des deux campagnes automatiques, sans réinterroger Scopely ni
relancer aucun lot. Ne remplace ni le préflight live des sessions OAuth,
ni la logique du collecteur.

La liste est tirée exclusivement du registre privé
`roster-sync/v1/approved-alliances.json` : aucun nom ni identifiant
d'alliance n'est codé en dur.

## Accès et sécurité

- `GET /admin/api/roster-r2-coverage` : synthèse de toutes les alliances approuvées.
- `GET /admin/api/roster-r2-coverage?fingerprint=<sha256>` : vérification
  des fichiers R2 de **cette seule alliance**.
- Les deux routes héritent du **contrôle JWT signé Cloudflare Access**
  et de la liste des administrateurs, comme les autres routes `/admin/api/`.
- Le module n'utilise que `CAPTAIN_BUCKET.get` et `CAPTAIN_BUCKET.head` :
  **aucun GET Scopely, refresh OAuth, verrou, POST, écriture ou suppression R2**.
- Les résultats ne comportent que le nom approuvé, l'empreinte, des compteurs,
  des statuts et des dates ; ni token, ni PID, ni nom de joueur, ni JSON de roster.
- Les réponses privées ont `Cache-Control: private, no-store`.
- La vue mobile dans `/admin` effectue la synthèse et jusqu'à une lecture
  détaillée par alliance approuvée ; un bouton permet de copier ce rapport
  **agrégé**, sans les contenus des rosters.

## Interprétation des résultats

La **progression actuelle** correspond à
`roster-batches/v1/<fingerprint>/progress.json` :

- `completed / eligibleCoMembers` représente les coéquipiers dont les rosters
  ont été enregistrés au cours de cette campagne ;
- `noShareCount = observedMembers - eligibleCoMembers - 1` est le nombre de
  membres sans partage, **uniquement lorsque le décompte est présent** ;
- `personalRosterCollected` correspond à `selfCompleted`, mais
  `personalFilePresent` vérifie séparément l'objet `member-self.json` ;
- `complete` suppose tous les membres éligibles collectés, le personnel
  enregistré et aucun consentement manquant ;
- `partial-consent` signifie que les rosters autorisés peuvent être présents
  sans prétendre à une alliance intégralement couverte ;
- `in-progress`, `expired`, `invalid`, `not-started` sont distincts.

Le **dernier manifeste complet** est contrôlé séparément à
`roster-batches/v1/<fingerprint>/latest-complete.json` :

- distinguer `missing`, `invalid`, `expired`, `valid` ;
- valider la cohérence du format, de l'empreinte, du runId, des compteurs,
  du digest d'effectif, du roster personnel et des dates ;
- distinguer une base complète **antérieure** d'une campagne actuelle
  encore incomplète (`matchesCurrentProgress=false`) ;
- en vue synthétique, seul le fichier du roster personnel est vérifié ;
  **`verified=null` ne signifie PAS que tous les fichiers existent** ;
- en lecture détaillée, effectuer des HEAD R2 (groupes de 5) sur chaque
  `member-N.json` et `member-self.json` du manifeste :
  `verified=true` seulement si le manifeste est valide/non expiré et si
  tous les fichiers attendus sont présents. Contrôler aussi les fichiers
  enregistrés dans la campagne en cours, indépendamment de l'ancien manifeste.

Un HEAD confirme la **présence de l'objet**, pas le contenu intégral de son
JSON ni le maintien du consentement au moment de la consultation. Le diagnostic
ne garantit pas qu'une alliance possède encore aujourd'hui le même effectif.
Il n'inspecte pas les enveloppes originales `provider-source/`.

## Production et rétention

Le diagnostic est uniquement une photographie du contenu R2 restant au
moment de la requête. Une expiration à 7 jours peut supprimer les objets ;
un manifeste complet expiré ne doit jamais être présenté comme une couverture
actuelle valide.

Après fusion et déploiement, ouvrir `/admin`, sélectionner
**« Vérifier les alliances en R2 »**, puis **« Copier le diagnostic JSON »**.
Comparer les résultats pour Zeus, Athéna, Kronos, Dionysos et Poséidon et
investiguer uniquement les écarts réellement observés.

## Validation

Tests : cinq alliances dynamiques, consentement partiel, campagne en cours,
base complète antérieure, absence d'un objet membre/personnel, expiration,
fichiers invalides, validation des paramètres, contrôle admin Access, absence
de données joueur et absence d'appels Scopely/écritures.
