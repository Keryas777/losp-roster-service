# Projection publique des rangs Arène (R2 privé)

GET /api/public/arena-history

Ce service n'appelle jamais Scopely. Il lit uniquement les reçus privés
déjà présents dans R2, puis expose un JSON réduit :
date, sourceDay, attribution, pseudo, alliance, arenaRank positif
et, si disponible, l'heure précise de lecture du joueur.
Aucun token, ID membre temporaire, roster, empreinte d'alliance
ou renseignement OAuth n'est publié.

Les données de classement sont déjà publiques dans la Web-app Infos.
CORS permet les appels depuis GitHub Pages.

## Deux dates de départ, sans fausse provenance

- 2026-10-31 : attribution rétrospective explicite depuis la campagne
  réelle 2026-11-01-am. Ce n'est PAS une mesure du 31 octobre.
- 2026-11-01 : campagne réelle 2026-11-01-reward, après 17:01 Paris.

Une date n'est considérée complète que si toutes les alliances
approuvées possèdent un reçu valide ; les rangs manquants sont omis.

## Rétention et récupération

Le cron Cloudflare existant toutes les minutes est réutilisé à
20:17 et 22:17 (heure de Paris) pour une opération R2 uniquement.
Il conserve une projection glissante de 30 dates au maximum, sans
réécriture des points déjà publiés.

Objet R2 : roster-batches/v1/arena-history/rolling.json
Conserver la règle de suppression après sept jours d'inactivité
sur le préfixe roster-batches/v1/, afin d'éviter toute conservation
indéfinie si les crons cessent de fonctionner.

Tant que les reçus source existent en R2, le GET peut présenter
le jour courant et la veille, et le premier AM du 1er novembre,
avant même le premier archivage. La source AM initiale doit être
archivée avant son expiration de sept jours.

Aucun historique permanent de données API n'est ajouté à GitHub.

Après fusion, le Worker Cloudflare doit être déployé explicitement.
