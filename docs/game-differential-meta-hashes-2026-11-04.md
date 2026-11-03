# Correction des faux changements /game liés à meta.hashes — 4 novembre 2026

## Constat : mini-audit R2 terminé, échantillon de 24 URL
Campagne du 2 au 3 novembre : `checked=12232`, `changed=9986`,
`unchanged=0`, `failed=2246`.

Rapport d'échantillonnage R2 du 3 novembre :
- 15/24 URL classées `metadata-other-change` : seule variation observée
  dans `meta.hashes.{events,drops,locs,nodes,chars,other,all}`,
  sans modification de `data` ni autre champ ;
- 7/24 `no-linked-previous-version` : aucune comparaison historique
  certifiable et surtout **pas une preuve de changement** ;
- 2/24 `data-change` sur des associations objet/personnage :
  `data.length`, `data[4+]` et `meta.perTotal` changent ;
- aucun défaut de SHA-256 ou de reçu démontré parmi les liens vérifiables.

Les 15 cas constituent des variations de **métadonnées globales**, pas
des modifications observées dans les données propres à la route. Les
proportions de cet échantillon ne sont PAS extrapolées à toute la collecte.

## Changement fonctionnel minimal
`src/game-differential-sync.js` calculait `semanticHash` sur la
réponse complète en ignorant uniquement `meta.asOf`. Il exclut
désormais **uniquement** `meta.asOf` et `meta.hashes`.

Les autres champs, connus ou inconnus, restent inclus :
`data`, `meta.perTotal`, pagination, etc. Une modification dans
`data` ou `meta.perTotal` doit donc encore déclencher `changed`.

`meta.hashes` reste **intégralement conservé dans les JSON officiels
archivés**. Le SHA-256 brut décrit toujours les octets exacts du fichier
R2 ; `observedSha256` décrit toujours les octets renvoyés par le GET
le plus récent. Ignorer ces métadonnées uniquement dans la décision
sémantique ne signifie pas effacer leurs valeurs ni prétendre que
la réponse brute la plus récente est byte-identique à l'objet conservé.

## Compatibilité avec les archives et reçus existants
L'ancienne empreinte excluait `meta.asOf` mais **incluait**
`meta.hashes`. Il est donc interdit de comparer directement une
ancienne empreinte à celle du nouvel algorithme.

Pour garantir une migration transparente :
1. Le nouveau profil est nommé `semanticVersion: 2` dans les nouveaux
   reçus et pointeurs `latest/`.
2. Quand un pointeur historique ne possède pas ce marqueur, le
   différentiel **relit son objet R2** et recalcule la nouvelle
   empreinte depuis son contenu réel. Ce coût R2 est unique pour
   chaque référence migrée et ne génère aucun GET Scopely additionnel.
3. Les anciens reçus/objets/pointeurs historiques ne sont ni
   effacés ni réécrits. Un pointeur courant est mis à jour uniquement
   au rythme normal des campagnes.
4. Si l'objet historique est introuvable/illisible, le différentiel
   reste conservateur : il ne déclare pas « inchangé » sans preuve.
5. Les capacités de reprise journalisée, hashes bruts, budget quotidien,
   Cron, routage et contrôle d'accès restent inchangés.

## Fraîcheur et conservation
Le mécanisme existant de renouvellement physique avant 21 jours et
la rétention du bucket continuent de s'appliquer. Un contrôle
sémantiquement inchangé ne signifie pas que l'objet peut être
conservé éternellement.

## Validation
Tests en mock Scopely + R2 :
- seuls les sept hashes globaux changent : classer `unchanged`
  et réutiliser l'objet existant sans modifier le JSON brut ;
- une référence avec l'ancien hash V1 est recalculée depuis le
  fichier réel, sans fausse modification ni réécriture historique ;
- un changement de `meta.perTotal` ou de `data` reste `changed`;
- le système existant de reprise, les reçus, la récupération 404/472
  et les limites de GET restent soumis aux tests de non-régression.

Ce correctif ne relance aucune campagne. Les compteurs historiques
`changed` ne sont pas retouchés. La prochaine synchronisation
sera la première à utiliser ce profil une fois la PR fusionnée et
déployée ; un rapport ultérieur permettra d'en mesurer l'effet.

## Hors périmètre
- Pas de reconstruction des sept anciens liens de provenance.
- Pas d'exclusion d'autres métadonnées sans preuve.
- Pas de suppression des historiques R2.
- Pas de révision des catalogues déjà publiés.
