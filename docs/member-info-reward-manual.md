# Relevé Infos récompenses : déclenchement manuel

Complément indépendant à la collecte automatique existante de **17:01 Europe/Paris**.

## Depuis l'administration

Sur la page sécurisée `/admin`, rubrique **Relevé Arène — Infos après 17 h** :

1. **Collecter les Infos maintenant** : enregistre dans R2 privé une demande
   portant exclusivement sur la journée française courante.
2. **Voir la progression R2** : vérifie le nombre d'alliances approuvées
   disposant d'un reçu complet pour la journée, sans appel Scopely.

La demande est autorisée **à partir de 17:01 heure française**.
Avant ce seuil, le service répond `409 before-reward-cutoff`.
Les dates/alliance ne peuvent pas être choisies dans l'appel.

L'API privée est `/admin/api/reward-infos-manual` :
- `GET` : statut agrégé privé (aucun appel Scopely).
- `POST` `{}` : lance ou reprend la campagne.
- `POST` `{"action":"collect","index":n}` : exécute immédiatement
  une alliance approuvée après vérification du jour, de l'intention
  et de l'authentification Cloudflare Access.
- Le jeton Cloudflare Access est vérifié **avant** d'atteindre ces routes
  via `handleAdmin` ; aucune route publique ne permet le lancement.

## Architecture et contraintes

Le POST initial `{}` crée ou réutilise une intention temporaire dans
`roster-batches/v1/reward-manual/YYYY-MM-DD.json`.

**Mode rapide :** l'interface enchaîne immédiatement les requêtes POST
`{"action":"collect","index":0}`, puis `index:1`, etc. Elle lance
**deux alliances en parallèle**, sans attendre une minute entre elles.
Chaque requête indépendante possède son propre plafond Cloudflare Free
de 50 requêtes externes. L'index désigne uniquement une entrée dans
la liste d'alliances approuvées résolue côté serveur. Le client ne peut
pas choisir une date ou un identifiant d'alliance arbitraire.

Les micro-lots partiels peuvent être poursuivis immédiatement.
Chaque alliance conserve son verrou Durable Object et ses checkpoints.

Si l'onglet est fermé ou qu'une requête échoue, le cron Cloudflare
**déjà existant** `* * * * *` continue les reprises une fois par minute.
Pas de nouveau cron ni de modification des campagnes AM/PM.

Cette protection est une contrainte du plan Cloudflare, **pas** une
obligation de temporisation imposée par Scopely.

La fenêtre de reprise manuelle dure **45 minutes** après le lancement.
Cliquer à nouveau pendant une campagne en cours ne la redémarre pas ;
les relevés d'alliances déjà terminés sont conservés sans réinterrogation.
En cas d'expiration avec des alliances non terminées, un nouveau
déclenchement peut reprendre le travail.

**Aucun changement** aux crons, aux collectes Infos AM/PM, aux rosters,
au pipeline /player ou à l'import GitHub Infos.

La campagne porte sur les données obtenues **au moment réel de chaque
lecture après le clic**, et non sur les rangs exactement figés à 17:00.
Elle n'invente jamais une heure d'observation antérieure.

Les reçus quotidiens sont dans R2 privé et soumis à la règle
de conservation déjà prévue pour les fichiers Infos.

## Vérification

```sh
node --check src/member-info-reward.js
node --check src/admin-routes.js
node --check public/admin-reward-info-manual.js
node --test tests/member-info-reward.test.mjs tests/member-info-reward-manual.test.mjs
```

La fusion de la PR n'est **pas** un déploiement Cloudflare automatique
dans ce dépôt. Après revue, déployer le Worker, puis accéder à
l'administration pour lancer la campagne du jour.
