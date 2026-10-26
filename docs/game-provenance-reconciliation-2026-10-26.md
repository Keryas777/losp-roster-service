# Rapprochement des orphelins R2 — 26 octobre 2026

## Point de départ
Campagne ced5b23f-504c-428b-9ca8-02171f2a21ef : 7 169 objets, 632 reçus,
6 537 orphelins, dont 6 450 vérifiés SHA-256 et 87 trop volumineux.
L'audit précédent était achevé au 23 octobre 2026.

Les anciennes collisions de clés de reçus sont corrigées depuis la PR #71.
Les anciens reçus écrasés restent irrécupérables sans preuves supplémentaires.

## Portée exacte de ce chantier
Un SHA et une signature de structure JSON ne prouvent pas quelle URL historique
a produit ce fichier. Ce chantier constitue une association démontrable entre
un objet historique et une réponse officielle **ultérieure aux octets identiques**.

Conditions : pointeur différentiel /game/v1 exact, reçu V2 correspondant,
SHA des octets réellement observés égal au nom de l'objet historique, objet
source présent en R2, dates de stockage et de vérification connues et âgées de
moins de 30 jours, un seul chemin distinct trouvé pour cette empreinte.

Un lien porte explicitement historicalOriginalRequest = not-proven :
ce n'est PAS un reçu historique restauré. Plusieurs URLs avec le même SHA
donnent un statut ambigu, sans attribution d'une provenance exclusive.
Les 87 anciens objets trop volumineux sont volontairement non certifiés.
Une date d'upload manquante ou expirée empêche toute association certifiée.

## Activation
Après fusion de la PR et déploiement Cloudflare effectivement confirmé :
ouvrir /admin → Archives R2 → Rapprochement prouvé des provenances R2 ;
cliquer une fois sur « Lancer le rapprochement R2 ».
Le Cron existant continue par lots de 100 entrées R2 (lecture des sources parallèle et écriture groupée par préfixe SHA), même onglet fermé. La taille des lots n'a aucune incidence sur les quotas Scopely : cette étape ne fait aucun GET officiel.
« Actualiser le rapprochement » lit le checkpoint privé R2.
Le démarrage exige l'ancien audit snapshot-complete de la même campagne.
Les doubles clics ne relancent pas ni ne remettent à zéro.

## Artefacts créés
Uniquement sous :
game-archive/v1/runs/<runId>/provenance-reconciliation/v1/

- progress.json : compteurs, phase et curseur persistants ;
- evidence/<2 caractères du SHA>.json : index des reçus différentiels validés ;
- matches/<sha256>.json : lien vers endpoint attesté par octets identiques,
  reçu V2, dates et limite de preuve historique.

Aucun ancien reçu, objet, queue, active.json ou pointeur différentiel latest
n'est réécrit. Aucune API Scopely, aucun roster ni OAuth n'est interrogé.
Les plafonds API et la fréquence Cron restent inchangés.
L'index est rejouable après interruption, avec verrou Durable Object distinct.

## Limitations et sécurité
Il s'agit d'un snapshot des pointeurs différentiels existants. Quand les
prochaines vérifications apporteront de nouvelles preuves, une version
explicitement renouvelée de l'analyse sera nécessaire.
La fraîcheur ne se déduit jamais d'une correspondance enregistrée : le
consommateur futur doit revérifier objet, reçu, date et TTL. Les règles
Cloudflare de suppression physique à 30 jours doivent être auditées séparément.

La campagne ne sera considérée exécutée en production qu'après confirmation
du déploiement, lancement administrateur et statut snapshot-complete.
Un rapport 0 association exacte peut être un résultat valide : les preuves
disponibles ne permettent pas de certifier l'origine de tous les orphelins.

## Correctif de débit du 26 octobre 2026
Le premier déploiement avait un lot arbitraire de 20 sources puis 20 objets par minute : plus de 7 420 sources examinées après plusieurs heures, alors qu'aucune limite externe n'était atteinte. Ce lot est désormais de 100, avec lecture concurrente bornée et écriture groupée par shard SHA (au lieu d'un read/write R2 pour chaque source). Le checkpoint, son curseur opaque, les compteurs et les preuves déjà écrites sont réutilisés tels quels, **sans redémarrer la campagne**. Les nouveaux tests couvrent explicitement la reprise après les 20 anciennes entrées et le traitement de plus de 200 sources/objets.

Les 1 662 sources « rejected » déjà comptées ne démontrent PAS une erreur API : le compteur agrège aussi les réponses dont seul `meta.asOf` a fait diverger le hash des octets observés, ainsi que les pointeurs/reçus ne pouvant pas fournir une preuve exacte. Leur cause précise n'est pas déductible du seul compteur agrégé et n'est pas modifiée rétroactivement.
