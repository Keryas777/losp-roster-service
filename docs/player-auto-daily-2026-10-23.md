# Synchronisation quotidienne automatique /player — 23 octobre 2026

## Constat

Auparavant le bouton **Collecter toutes les données /player** déclenchait
manuellement une campagne. Le Cron existant pouvait **poursuivre une campagne
en cours**, mais quand le checkpoint R2 était absent, il renvoyait `idle`.
Ainsi, **« Aucune campagne lancée » ne signifie pas « Collecte terminée »**.

## Fonctionnement corrigé

- `PLAYER_AUTO_ENABLED=true` via Wrangler.
- Cron déjà présent `* * * * *` : **le premier tick démarrera automatiquement**
  une collecte, sous réserve des sessions OAuth enregistrées et de R2 disponible.
  Pas de nouvelle horloge ni de nouveau workflow.
- Une fois la campagne complète ou partielle terminée, une **nouvelle campagne
  est initiée 24 h après l'heure de clôture**, sans recharger l'administration.
- Si une campagne est encore active, elle **reprend par petits lots** et
  ne se superpose jamais à la suivante.
- Si aucun compte OAuth n'est enregistré, le checkpoint ne prétend pas
  à une collecte réussie. Une tentative est reportée au jour suivant.
- Le bouton administrateur devient **Forcer une collecte maintenant** :
  optionnel, sans effet sur le fonctionnement automatique.
- Le panneau lit son statut R2 dès l'ouverture, **sans contact Scopely**,
  et montre l'état, le mode automatique/manuel et la prochaine échéance.

## Autorisations strictement conservées

Sur les capitaines individuellement connectés, seules les familles
personnelles autorisées sont synchronisées : équipes, inventaire,
souhaits et événements/progression. Pour les membres non connectés,
seules les équipes accessibles avec `rosterShare=true` sont collectées,
après vérification du consentement avant ET après la requête.
Les rosters, profils et fiches d'alliance restent sous la collecte existante,
sans duplication.

## Robustesse

- Toujours le **même verrou Durable Object** pour les campagnes et leurs
  lancements manuels.
- Même `PER_TICK_BUDGET=10`, `DAILY_BUDGET=1000` et temporisations
  (notamment HTTP 429).
- **Nouveau compteur de réservation UTC R2**, conservé d'une campagne
  à l'autre. Un lancement manuel ou un nouveau cycle automatique ne
  peut pas contourner le plafond quotidien.
- Pas d'archive publique ni de jetons OAuth exposés au navigateur.
- Les fichiers `roster-batches/v1/player-...` restent dans la
  politique de rétention existante R2 de **7 jours**.

## Suivi et limites

Le statut de la campagne doit distinguer **not-started**, **running**,
**complete**, **partial** et **awaiting-oauth** (résultat du tick).
Les opérations refusées par l'API sont comptées comme absentes ou
échouées, jamais comme copies complètes.

Ce chantier ne contrôle pas directement la configuration déployée
dans Cloudflare ni le contenu du bucket de production. Après fusion et
déploiement, la présence et la réussite du premier cycle sont vérifiables
sur `/admin#archives` via le statut R2 et sur **Vue d'ensemble**
via les manifestes des familles /player présents avec leurs pages.

La synchronisation répète les lectures nécessaires : **aucune API
différentielle universelle /player n'a été supposée**.
