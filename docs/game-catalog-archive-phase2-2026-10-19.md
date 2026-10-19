# MSF /game/v1 — découverte des données liées (phase 2, 19 octobre 2026)

Source de référence : [Scopely OpenAPI beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json).

## Principe

Les 17 familles initiales de `/game/v1` et les 11 services du site
avaient été étudiées en phase 1. **Une réponse 200 ne garantit jamais
l'exhaustivité de toutes les variantes et relations.**

Cette phase 2 ajoute des ressources GET documentées. Elle ne crée aucun
flux OAuth joueur, ne modifie pas les rosters et ne publie rien dans
`Keryas777/msf`. La vérité est la réponse brute archivée en R2 privé.

## Activation et reprise de la campagne

`GAME_ARCHIVE_PHASE2_ENABLED=true` est versionné dans Wrangler. Lorsque
l'état R2 actif est `completed` ou `completed-with-gaps` **et n'a
pas encore de marqueur `phase2`**, le Cron toutes les minutes réactive
**le même runId** pour un balayage des reçus de phase 1.

Le parcours lit six reçus R2 maximum par invocation sans GET Scopely ;
un curseur R2 et les compteurs sont enregistrés dans `progress.json`.
Des erreurs de lecture R2 laissent la campagne en mode scanning et sont
retentées ; elles ne produisent pas un statut complet inventé.

Les nouvelles tâches sont dérivées uniquement de chemins et propriétés
officiels réellement présents dans les réponses :
- `Item.id`, `ItemQuantity.item` (objet ou ID), `itemId`, `isOrb`
  → `items/{itemId}`, `items/{itemId}/characters`,
  `orbRewards/{itemId}` lorsque l'objet est bien un orbe ;
- `NodeInfo.combatId` → `nodeCombats/{combatId}` ;
- les six `episodicType` officiels → listes `episodics/{type}` ;
  `EpisodicInfo.id` et `numChapters`, puis
  `ChapterInfo.numTiers` → détails de missions, chapitres et paliers ;
- `EventInfo.episodic` → identifiants épisodiques documentés ;
- fiches personnages et raids → paramètres d'expansion officiels
  supplémentaires afin de récupérer des champs omis par défaut.

**Aucun ID candidat n'est inventé à partir d'une plage ou d'une
combinaison de niveaux d'instances.** Seules des routes `GET /game/v1`
prévisibles et validées sont formées ; aucune action de jeu.

La file est stockée sous le même run R2, avec débordement en
`queue/` et déduplication exacte dans `phase2-seen/`, par fragments.
Les réponses précédemment archivées ne sont pas retéléchargées pour
en découvrir les relations.

## Contrôles de complétude

La sortie de `/admin/api/game-archive` renseigne `phase2.status`,
`phase2.scannedReceipts` et `phase2.discovered`, en plus des
compteurs de phase 1.

Les collections avec pagination n'enregistrent leurs tâches enfants
qu'après validation des pages et des totaux. L'arrêt arbitraire à la
page 1 000 a été supprimé ; incohérences et recouvrements entraînent
un nouveau passage temporisé, sans faux statut `completed`.

La borne de 8 Mo pour `/game/v1` reste un **seuil mémoire**, non une
limite de téléchargement : les réponses plus grandes vont en multipart
R2 avec reçu `indexed:false` et écart explicite.
Le testeur des onze services complémentaires utilise désormais le même
principe et retourne `archived-unindexed` au lieu de `too-large`.
Un archive brute non indexée ne garantit pas que ses relations ont
été découvertes ; elle ne doit pas être classée exhaustive.

## Ce qui reste à faire

- Analyser et indexer progressivement les gros JSON multipart sans
  relire intégralement leurs octets en mémoire.
- Récupérer les fichiers CSV de localisation référencés par les réponses
  officielles, en validant destinations et politiques d'accès.
- Auditer les paramètres `flexFields`, langues, autres expansions et
  raccourcis statistiques admissibles route par route.
- Évaluer les relations des raids, salles, challenges et événements
  qui ne portent pas d'identifiant exploitable dans les réponses connues.
- Certifier les disponibilités des endpoints uniquement sur des retours
  HTTP réels Cloudflare, et non sur les tests simulés.
- Ajouter ensuite la surveillance différentielle des versions et `344`
  lorsqu'un support `since` est explicitement documenté.

**Cette PR ne prétend pas que l'ensemble du jeu MSF est déjà archivé.**
Les collections OAuth de joueurs et les anciennes ressources Unity/CDN
restent des systèmes séparés.
