# Couverture multi-alliances via OAuth — préparation (octobre 2026)

Cette phase est **une découverte privée et non une synchronisation des rosters**. Le dépôt MSF possède déjà les sources de vérité `docs/data/alliances.json`, `docs/data/rosters_<alliance>.json` et le merge `scripts/merge-rosters.mjs`. Aucun de ces fichiers publics n'est modifié ici.

## Pourquoi cette phase

Un même capitaine peut changer d'alliance, et plusieurs capitaines peuvent avoir accordé l'accès à une même alliance. Les autorisations restent attachées à chaque **compte MSF**, indépendamment de l'alliance.

L'API officielle décrit `AllianceCard.id` comme `{aid}:{member_version}`. La version change quand un joueur arrive/quitte ; le préfixe `aid` est la partie stable utilisée **en mémoire uniquement** pour regrouper les autorisations durant chaque scan. Ne jamais dédupliquer sur un nom d'alliance (collisions possibles) ni sur la version d'effectif (instable). La synthèse R2 n'enregistre que le SHA-256 de `aid`.

## Ce que réalise le code

- Nouveau module `src/alliance-coverage.js` testé : lit le préfixe existant `oauth-captains/v1/` du bucket privé `CAPTAIN_BUCKET` ; pour chaque session, demande le jeton au coordinateur de refresh existant et appelle `GET /player/v1/alliance/card`.
- Regroupe les sessions **par `aid` stable**, sans hardcode Zeus/Athéna/Kronos/Dionysos/Poséidon et sans dépendre de `joueurs.json`.
- Pour une alliance donnée, `GET /player/v1/alliance/members` est normalement appelé **une seule fois**, via une session active ; si la requête échoue, tente une seconde session de la même alliance. Exige exactement un `isSelf` valide, des membres uniques et un booléen `rosterShare` explicite pour compter les partages. Ne lit aucun roster de personnage.
- Écrit uniquement un état agrégé privé, `oauth-coverage/v1/latest.json` dans R2 : date, nom d'alliance, empreinte SHA-256 de son identifiant stable, nombre de connexions, membres, partages et absences de partage, éventuellement les rangs documentés si Scopely les retourne. **Aucun nom de joueur, identifiant membre, token, contenu de roster ou inventaire.**
- Le scan est limité à **12 sessions par exécution** pour respecter un budget conservateur d'appels du Worker. Si la couverture est incomplète ou Scopely indisponible, `complete=false` ; ne jamais afficher un total comme exhaustif dans ce cas.
- Une deuxième entrée cron `15 3 * * *` (03:15 UTC) est préparée, mais **la découverte ne démarre pas** tant que la variable texte Cloudflare `CAPTAIN_COVERAGE_ENABLED=true` n'est pas activée. Le renouvellement OAuth horaire existant reste distinct et inchangé.

## Activation — pas pendant cette PR

1. **D'abord valider en production le renouvellement effectif d'un `refresh_token` Scopely**, puis les accès individuels des cinq alliances.
2. Configurer dans R2 une règle de durée de vie sur le préfixe `oauth-coverage/v1/`, suppression après **30 jours** depuis la dernière écriture. Ne jamais utiliser cette règle pour `oauth-captains/v1/` (qui suit sa propre conservation de 365 jours).
3. Vérifier que le bucket `losp-roster-sessions` reste strictement privé et que le binding `CAPTAIN_BUCKET` pointe au bon bucket.
4. Activer uniquement la variable Cloudflare `CAPTAIN_COVERAGE_ENABLED=true` puis la synchroniser dans `wrangler.jsonc` pour que les déploiements automatiques ne l'effacent pas.
5. Inspecter via le tableau de bord R2 **sans le rendre public** le fichier `oauth-coverage/v1/latest.json` après le cron quotidien. Son contenu est volontairement un bilan agrégé.
6. Désactiver la variable en cas d'anomalie. Les jetons personnels restent en place.

## À faire avant la synchronisation réelle des rosters

- Registre privé des alliances LoSP **approuvées**, associé aux identifiants stables officiels ; la liste `docs/data/alliances.json` est la référence des noms/couleurs mais **ne prouve pas qu'une alliance homonyme est bien une alliance LoSP**.
- Autorisation administrative des comptes ayant qualité pour représenter l'alliance ; une permission OAuth seule n'accorde pas ce rôle métier.
- Politique de sélection et de repli entre plusieurs capitaines d'une même alliance, contrôle des changements d'alliance au moment de chaque collecte et suppression des données anciennes en cas de retrait des partages.
- Téléchargement complet des seuls rosters explicitement partagés, pagination et budget d'appels, respect des limites de Scopely.
- Stockage privé de snapshots datés avec expiration ≤30 jours, audit de consentement et mécanisme de publication/synchronisation **distinct**. Aucune écriture automatique dans `docs/data/rosters_*.json` ou `rosters.json` avant validation de la forme, des règles de fusion et des autorisations.

**Ce module n'est pas une preuve de bon fonctionnement du refresh Scopely ni d'identité/qualité de capitaine.** Les tests couvrent le comportement local avec des réponses API simulées.
