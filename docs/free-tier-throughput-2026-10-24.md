# Accélération des collectes sur Workers Free — 24 octobre 2026

## Périmètre
Dépôt `Keryas777/losp-roster-service`. Cette évolution complète la PR #85 déjà fusionnée. Aucun changement de compte Cloudflare, aucun plan payant, aucune route publique de téléchargement et aucun élargissement des scopes OAuth.

## Limites Cloudflare réellement applicables
Documentation officielle (mise à jour le 12 octobre 2026) : https://developers.cloudflare.com/workers/platform/limits/

- Workers Free : **50 sous-requêtes externes par invocation** ; **1000 sous-requêtes internes** vers R2, Durable Objects, etc.
- **6 connexions HTTP sortantes simultanées**, par invocation.
- **10 ms de CPU** par exécution : ce n'est **pas** le temps total de réseau ; le dépassement CPU réel doit être surveillé en production.
- **5 déclencheurs Cron** par compte Free. Notre service en conserve **4** : `15 * * * *`, `15 3 * * *`, `* 2-3,14-15 * * *` et `* * * * *` ; le cinquième créneau reste disponible pour un autre Worker du même compte.
- Les erreurs `429` Scopely continuent de déclencher les délais existants. Aucune limite journalière Scopely n'est déduite des quotas Cloudflare.

## Rosters
- Les collectes automatiques existantes (PR #85 : jusqu'à deux alliances par minute, désormais huit coéquipiers partagés par lot (six auparavant), plus un passage pour le titulaire OAuth) sont conservées.
- Chaque lot peut maintenant lire **trois rosters en parallèle** (`parallelMembers:true`) en utilisant le même compteur de GET, sans modifier le contrat des rosters, le contrôle d'effectif, `since`/`344` ou le format R2.
- Le résultat est **remis dans l'ordre stable d'origine** avant tout archivage ; si une seule lecture échoue, aucun roster partiel n'est retourné. Les lots manuels et pilotes restent séquentiels.
- Les deux alliances d'un même tick sont traitées l'une après l'autre : trois connexions parallèles maximum côté collecteur, pas six par alliance.

## /player/v1
- Réutilisation du Cron existant `* * * * *` : jusqu'à **trois actions sérielles `/player`** par minute, chacune plafonnée à dix GET Scopely.
- Le même Cron traite aussi au maximum **12 GET `/game`** par minute. Enveloppe théorique : **30 GET `/player` + 12 GET `/game` = 42 GET**, sous le plafond de 50 sous-requêtes externes. Les appels OAuth éventuels conservent une marge ; les appels R2/DO sont des sous-requêtes internes distinctes.
- Le plafond artificiel de 1000 GET `/player` quotidiens est supprimé comme barrière. Le compteur UTC persiste pour les métriques et conserve une réservation pessimiste de dix GET par action pour tolérer les interruptions.
- Les contrôles sur les scopes et le partage des équipes d'alliance, ainsi que l'arrêt sur `429`, continuent de s'appliquer **à chaque action**.
- Durée théorique pour 140 à 250 actions sans latence excessive ni rate-limit : **environ 47 à 84 minutes** (trois actions par minute), contre un cycle potentiel de plusieurs jours provoqué par la barrière de 100 actions par jour. Ce n'est pas une mesure de production.

## /game/v1
- Collecteur initial : douze GET par minute au lieu de six, sans modifier la validation de pagination, la provenance, les reçus R2 et la reprise.
- Différentiel hebdomadaire : douze GET par minute au lieu de trois ; la phase de recensement R2 passe de douze à **32 reçus examinés par minute**, sans appel Scopely supplémentaire.
- Suppression du **plafond spécifique de 1500 GET différentiels/jour**, qui interrompait les contrôles malgré la disponibilité de l'API. Le différentiel reste sous le garde-fou **global historique de 9000 GET `/game`/jour**, partagé avec la collecte initiale.
- La conservation des octets bruts et des versions modifiées demeure inchangée. Il reste indispensable de vérifier la conformité de la rétention aux conditions Scopely.

## Exemples de projection
- `/game` sur 7428 URLs : 7428 / 12 = **619 minutes (~10 h 19)** pour les seules vérifications API, contre 2476 minutes à trois GET/minute **et** plusieurs jours imposés par les 1500 GET/jour précédents. Il faut **ajouter la phase d'indexation R2** : jusqu'à 7428 / 32 ≈ **233 minutes** si tous les reçus sont présents et doivent être parcourus, plus les découvertes et les cas complexes. Ce n'est pas une mesure de production.
- Les deux campagnes /roster planifiées restent celles de l'application ; on ne crée pas de troisième campagne ni de second stockage.

## Critères de validation après déploiement
1. Dans Cloudflare Observability, contrôler `Exceeded CPU Time Limits` / erreur **1102** : risque réel du Free à 10 ms CPU lorsqu'on augmente la taille des ticks.
2. Vérifier le Cron `* * * * *`, le partage de charge `/player` + `/game`, et l'absence de GET Scopely superflus.
3. Observer `429` et `472` ; confirmer pauses et repli sur pagination sans publier de séries partielles.
4. Mesurer séparément durée `/player`, `/game`, `rosters`, le nombre de GET et les opérations/volume R2 avant/après. Aucun gain chiffré n'est certifié sans ces mesures.
5. Conserver les tests Node `node --test tests/*.test.mjs` et vérifier GitHub Actions avant fusion.
