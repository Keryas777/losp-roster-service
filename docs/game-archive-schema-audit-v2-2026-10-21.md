# Audit R2 V2 — couverture des familles et des types de routes

## Pourquoi remplacer la stratégie V1 ?

Le relevé du 20 octobre à 22:39 UTC comptait **632 reçus indexés** et **16 familles**, mais seulement **24 JSON effectivement inspectés**. Sept familles, dont `events`, `characters` et `traits`, avaient zéro échantillon malgré des reçus valides.

La cause est confirmée dans le code V1 : six lectures JSON étaient réparties directement parmi les reçus de chaque page R2 ; les familles déjà inspectées avaient consommé le budget **avant** la découverte de familles tardives.

## Modifications de V2

Lancement administrateur inchangé : `POST /admin/api/game-archive-schema-audit` (`{"action":"start"}`), après les mêmes contrôles Cloudflare Access et Origin. Cron existant inchangé. **Aucun appel supplémentaire à Scopely.**

L'état est désormais enregistré dans un fichier **distinct** :
`game-archive/v1/runs/{runId}/schema-audit/v2-progress.json`.
Le précédent `schema-audit/progress.json` V1 **reste conservé** et n'est ni écrasé ni rechargé comme état V2.

**Passe 1 — indexing :** examine uniquement les reçus R2 (200/minute, 5 GET simultanés maximum). Identifie les familles, la forme des routes (`collection`, `detail`, `nested`) et conserve jusqu'à huit candidats distincts **par forme de route**, sélectionnés de manière bornée et déterministe sur l'ensemble du parcours. Exemples :

- `events` contre `events/{id}` ;
- `items/{id}` contre `items/{id}/characters` ;
- `episodics/otherEvent` contre `episodics/unlockEvent/{id}` ;
- `analysis/teamOrder` est traité comme une route de collection.

**Passe 2 — sampling :** inspecte au plus six JSON et douze tentatives (HEAD/tailles/erreurs) par minute. Priorité aux **familles puis aux routes les moins inspectées**. Les reçus `events` et les nombreuses fiches `items` ne privent plus les autres familles d'échantillons.

Le rapport inclut `version:2`, `runId`, `phase`, et pour chaque famille des statistiques par route : `receipts`, `inspected`, `attempted`, `tooLarge`, `unreadable`, `state`.

Les clés R2 privées, le contenu et les valeurs des JSON ne quittent pas le stockage privé. L'administration ne reçoit que des formes, types, comptages et chemins d'exemple déjà autorisés. Le préfixe `oauth-captains` et les données joueur restent hors périmètre.

**Chemins imbriqués :** les niveaux numériques sont normalisés en `{n}` : `data.striker.levels.{n}.description` au lieu de vingt chemins uniques. Profondeur 7, exploration limitée (6 éléments par tableau, 40 clés par objet, 240 chemins par famille).

## Limites explicites

- Chaque famille utilise au plus 16 formes de route et 48 JSON inspectés. Chaque route fournit au plus huit candidats. Les routes et variantes non sélectionnées ne sont pas certifiées absentes.
- Les blobs supérieurs à 1,25 Mo et les objets `raw/` non indexés sont signalés, **pas analysés**.
- Une famille dont tous les candidats sont trop grands, absents ou non indexés peut toujours terminer avec `inspected:0`; le rapport indique le problème, sans inventer une couverture.
- Les valeurs et vrais identifiants d'alliances, de joueurs ou de rosters ne sont ni étudiés ni exposés.
- L'API `CharacterInstance` expose quatre **niveaux numériques de capacité**, mais une instance `/game/v1/` n'est pas l'état d'un personnage d'un compte. Pour établir le nombre d'améliorations T4 d'un joueur, il faut interroger `/player/v1/roster` avec le consentement approprié et vérifier la sémantique sur l'affichage en jeu.
- Une V2 terminée pendant la collecte officielle est un **instantané temporaire**, pas un inventaire final. Relancer **V2 seulement** quand la collecte générale est terminée, sans redémarrer la collecte.

## Validation

Tests `node --test tests/*.test.mjs`, incluant un scénario reproduisant le relevé réel **632 reçus / 16 familles**, l'assurance d'au moins une tentative pour chaque route éligible, les cas `events`, `characters`, ISO-8, listes contre détails, sécurité et reprise après fermeture de navigateur.
