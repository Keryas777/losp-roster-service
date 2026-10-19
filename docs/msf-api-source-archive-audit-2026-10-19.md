# Inventaire de collecte MSF et préservation des données source (19 octobre 2026)

## Principe validé

**Collecter intégralement les informations effectivement accessibles et autorisées, conserver leurs champs et métadonnées inconnus, trier ensuite.**
Le présent état ne signifie PAS que toutes les routes listées sont actuellement opérationnelles en production.
L'API développeur et le service Web Playable constituent des familles distinctes et ne partagent pas nécessairement leurs authentifications.

## Sources de vérité et niveaux de preuve

| Famille | Source | Statut |
| --- | --- | --- |
| API développeur | [OpenAPI Scopely beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json) | Routes et paramètres documentés, non testés avec les autorisations de production dans cette PR |
| Service web MSF | [Pipeline LoSP](https://github.com/Keryas777/msf/blob/main/MSF_CAPABILITIES_PIPELINE.md) et [fetch-characters.mjs](https://github.com/Keryas777/msf/blob/main/scripts/fetch-characters.mjs) | Onze noms répertoriés, certains utilisés dans le dépôt ; disponibilité et autorisation à confirmer |
| Service web MSF, extensions communautaires | [msf-ocr-hud](https://github.com/piouscott/msf-ocr-hud) | Six hypothèses d'URLs testées dans le code tiers, **pas six routes validées** |
| Ressources client Unity | Pipeline LoSP, catalogue `/rules/asset-lists`, CDN `/bulky_rules/` | Route dépendante d'une session du client du jeu ; à traiter par le pipeline existant, pas par l'OAuth développeur |
| CDN | `assets.marvelstrikeforce.com/imgs/` | Ressources versionnées, pas une API JSON de joueur |

## Familles officielles à couvrir

La liste exhaustive de référence a été fournie par le responsable du projet. Elle comprend :

- `/game/v1/languages`, `localizations`, `decorations`, `upgradeData`, `iso8Abilities`, `analysis/teamOrder`;
- `traits`, `characters` (y compris `array/{characterIdArray}`), `characterInstances`, `characterInstanceCaps`, les raccourcis d'instances paramétriques ;
- `orbRewards/{itemId}`, `items/{itemId}`, `items/{itemId}/characters`;
- `nodeCombats`, `episodics`, `dds`, `raidGroups`, `raids`, `pickYourPoisons`, `survivalTowers`, `events`, `scopes` et leurs détails ;
- `/player/v1/card`, `roster`, `squads`, `inventory`, `itemWishlist`, `events`;
- `/player/v1/alliance/card`, `alliance/members`, leurs variantes `/{allianceId}`, et leurs informations de recrutement ;
- `card/member/{memberId}`, `roster/member/{memberId}`, `squads/member/{memberId}`, ressources applicant/requester/recruits/invites ;
- verbes mutateurs (`DELETE /auth/consents`, `POST /promocode/.../claim`, `POST /alliance/invite/...`, `POST /alliance/action/...`, `POST /util/v1/gatedRefresh`) : **inventoriés, jamais exécutés par le collecteur en lecture seule**.

**Attention à la cardinalité :** un modèle paramétrique `/characterInstances/{level}/{yellow}/...` décrit une fonction de calcul et non une liste finie de ressources ; l'exhaustivité concerne les définitions, les paramètres documentés et les instances pertinentes, pas un balayage combinatoire illimité.

## Les 11 compléments du site (à valider)

Hôte `api-prod.marvelstrikeforce.com`, préfixe `/services/api/` :

`getCharacterList`, `getCharacterAbilities`, `getCharacterAbilityCaps`,
`getCharacterInstanceCaps`, `getCharacterMaxStatCaps`, `getTraits`,
`getTraitsByCategory`, `getIso8Abilities`, `getGear`,
`getUpgradeTokens`, `getLocalization`.

Autres hypothèses à NE PAS qualifier d'actives sans preuve HTTP :
`getOffers` (historique), `characters`, `getCharacters`,
`getAllCharacters`, `getPlayerRoster`, `squads`, `getGameData`.

## Ce que la PR #54 capture, sans aucun GET supplémentaire

La collecte existante appelle déjà les routes OAuth autorisées d'alliance et de roster. Après les vérifications de consentement, stabilité de l'effectif et approbation, elle préserve désormais sous `roster-batches/v1/` :

- enveloppe JSON entière de `/player/v1/alliance/card` ;
- enveloppe JSON entière des **deux** lectures `/player/v1/alliance/members` ;
- enveloppe JSON entière de **chaque page de roster** partagé ou personnel réellement lue ; un `344` est enregistré comme un reçu sans corps, et le précédent roster reste dans le stockage normalisé ;
- source exacte (chemin de requête et statut HTTP), horodatage, alliance et session de collecte ; clés privées immuables par passage.

Le JSON est préservé **sémantiquement** (tous les champs, `meta`, champs inconnus), mais l'espacement et l'ordre textuel exact des octets HTTP ne sont pas garantis. Aucune clé OAuth, aucun secret ni journal de joueur n'est créé.

Le préfixe bénéficie actuellement de la règle de rétention **7 jours** décidée pour les rosters. Ce n'est donc **pas encore une archive historique permanente**. Tout changement de durée ou de portée de conservation devra être décidé explicitement.

La collecte existante conserve la protection `429`, les verrous Durable Objects, les validations de partage, les budgets Cron et les profils LoSP inchangés. Aucun POST mutateur Scopely n'est appelé.

## Ce qui reste à implémenter pour l'exhaustivité

1. **Jeu statique** : vérification GET avec autorisation client-credentials, options d'expansion et pagination ; copie privée complète par version, sans collisions avec le pipeline `Keryas777/msf` existant.
2. **OAuth personnel** : capturer `card`, `squads`, `inventory`, `itemWishlist`, `events` et les détails accessibles pour chacun des neuf comptes connectés, en respectant les scopes effectivement accordés.
3. **Données partagées** : fiches et squads des membres explicitement autorisés, profils d'alliance, détails autorisés du recrutement ; ne jamais convertir un `rosterShare:false` en permission de lire un roster.
4. **Vérification technique** : relever pour chaque route l'authentification requise, les réponses `200/401/403/404/429/472`, les paramètres, le coût et la taille, et ne marquer « validé » que sur preuve de réponse réelle.
5. **Couverture testable** : compteur `collecté / autorisé / indisponible / non vérifié`, suivi des champs et des changements de schéma, et versionnage de catalogues sans aspiration des raccourcis combinatoires.
6. **Conservation** : confirmer avec le responsable du projet la durée des données OAuth archivées avant toute extension de rétention. La confidentialité R2, l'absence de PUSH et l'absence de modification des PIDs Google Sheets restent intangibles.

## Important : limites de preuve au 19 octobre

La spécification officielle est publiquement consultable ; les réponses authentifiées des services tiers et leurs scopes ne peuvent pas être testés depuis cette session. Les propositions de futures routes ne constituent ni un test réel ni une autorisation de collecte.
