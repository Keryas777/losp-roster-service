# Optimisation majeure des lectures de rosters — 18 octobre 2026

## Observation et décision

La documentation officielle Scopely [OpenAPI beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json)
expose deux fonctions déjà disponibles pour `GET /player/v1/roster/member/{memberId}` :

- **Sans `perPage`**, « If unspecified, all results are returned ». On demande
  donc d'abord le roster complet dans **un seul GET**, au lieu de 4 GET pour
  les 383 personnages du pilote Zeus. La réussite sur le serveur réel dépend
  de ses limites de réponse et doit être confirmée en production.
- **`since=<meta.asOf>`** : en cas d'absence de changement, Scopely retourne
  **HTTP 344 UNCHANGED**. Cela évite de télécharger les fiches en entier,
  mais **compte toujours pour une requête API**.

Les références sont les sections `components.parameters.perPage`,
`components.parameters.since`, `components.schemas.Meta.asOf`,
`paths./player/v1/roster/member/{memberId}` et le statut `344`.

## Comportement dans le service

1. Les collectes **manuelles par micro-lots** demandent d'abord chaque roster
   sans `perPage`. Vérification stricte de `data`, `meta.perTotal`,
   doublons de personnages et données typées.
2. Si Scopely refuse le résultat complet (`472`, réponse trop lourde) ou si
   `meta.perTotal` révèle une réponse partielle, **repli sur des pages de 200**.
   Le collecteur réduit la pagination en cas de `472` supplémentaire, puis
   conserve les gardes-fous de l'ancien moteur.
3. Le `meta.asOf` d'une lecture complète est conservé uniquement dans son
   snapshot **privé R2** avec les personnages.
4. Quand une **série entière est terminée**, l'administrateur peut lancer
   explicitement une *nouvelle vérification* (`refresh:true`) de l'alliance.
   Nouveau `runId` isolé. Chaque roster peut utiliser le `since` précédent,
   **uniquement** si le roster R2 est présent, non expiré, lisible,
   avec le **même membre temporaire** et la même empreinte d'effectif.
5. Si Scopely répond `344`, les personnages précédemment validés sont
   réutilisés, et la vérification ne télécharge **aucune page de personnages**.
   Si Scopely répond `200`, les nouvelles données remplacent entièrement
   les précédentes ; le 344 n'est jamais traité comme une mise à jour partielle.
6. Si l'effectif, les IDs temporaires ou les autorisations de partage changent,
   **aucune donnée ancienne n'est associée à un autre joueur**. On refuse la
   série avec `membership-changed-restart-required`.
7. Le service mémorise dans **R2 privé** uniquement la **clé opaque**
   de la session OAuth ayant déjà servi une alliance. Une relecture de
   `/alliance/card` vérifie **à chaque lot** son appartenance actuelle.
   Si l'autorisation n'est plus valide, on efface l'indice et on redécouvre
   les sessions. Aucun jeton n'est stocké dans cette mémoire de sélection.
8. Le bilan admin inclut désormais les `requestsThisBatch` de Scopely :
   appels de découverte, lectures de roster, effectif initial et final,
   vérification finale de l'alliance. Les GET `344` sont inclus.

Aucun cron de collecte n'est activé. Aucun GET public de snapshots.
Aucune écriture dans la WebApp, GitHub, Google Sheets ou dans les PID.

## Coût API : projection honnête

Ancien calcul **8 × 120 × 2 = 1920** : ce n'était pas le coût réel du
collecteur par micro-lots, puisque les contrôles étaient mutualisés par lot.
En revanche, l'ancien collecteur utilisait 4 GET de pages pour les 383
personnages d'Unhappy Miky.

- Dans le **meilleur cas observé après validation**, un roster complet
  revient à **un seul GET**, et un roster inchangé à **un GET `344`**.
- Avec deux membres par lot, un bilan typique comporte 2 GET rosters,
  2 GET effectifs, 1 GET carte d'alliance au départ **avec indice de session
  valide**, puis 1 GET de vérification finale. Soit **6 GET par lot de 2**,
  sans compter les appels OAuth et les erreurs/réessais.
- Sur 115 coéquipiers (23 par alliance), environ **60 lots** : ordre de
  grandeur **360 GET par passe**, soit **720 par jour pour deux passes**,
  plus les cinq rosters personnels non intégrés à ce stade.
- Optimiser les contrôles en toute sécurité et tester des micro-lots de 3
  pourraient encore réduire cette estimation, mais ce n'est pas validé ici.
- Si les réponses complètes sont trop grandes, des GET supplémentaires
  restent nécessaires. Aucun chiffre fixe n'est garanti en production.

La lecture d'un roster changé n'est **pas** une « mise à jour différentielle » :
un `200` renvoie un nouvel ensemble complet, pas seulement les modifications.

## Validation nécessaire

Après fusion, reprendre une alliance sans série en cours, ou terminer d'abord
sa série actuelle. Le **premier run** ne peut pas utiliser de `asOf` absent
des anciens snapshots, mais profite de la tentative en un GET.

Puis terminer cette série et cliquer dans `/admin` sur
**« Vérifier les changements (since / 344) »**. Tester une passe où les
rosters sont inchangés, puis où au moins un roster a été modifié :
`unchangedThisBatch`, `pagesThisBatch` et `requestsThisBatch`
permettent de confirmer les économies. Le numéro de PID n'est pas concerné.

Conserver les règles de cycle de vie R2 de **7 jours** sur
`roster-batches/v1/` et `roster-pilot/v1/latest/`, afin de supprimer les
anciennes séries, y compris orphelines.
