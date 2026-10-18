# Collecte automatique privée des rosters LoSP — PR #49

## Objectif et périmètre

LoSP Roster Service collecte les **rosters autorisés** des alliances
explicitement approuvées en R2, conserve les données et les contrôles
de progression exclusivement en R2 privé.

**Aucune donnée n'est envoyée depuis le service vers GitHub, Google Sheets,
la WebApp, Discord ou un autre stockage externe.** Les PID pérennes de la
colonne C de Google Sheets ne sont ni consultés ni modifiés.

L'automatisation comprend le roster personnel du compte OAuth via
`GET /player/v1/roster` (autorisation `m3p.f.pr.ros`), et les
coéquipiers ayant activé leur partage via
`GET /player/v1/roster/member/{memberId}`.

## Planification

L'expression Cloudflare Worker Cron est :

```
*/2 2-5,14-17 * * *
```

Elle définit deux fenêtres UTC :
- **02:00–06:00 UTC**, campagne `YYYY-MM-DD-am` ;
- **14:00–18:00 UTC**, campagne `YYYY-MM-DD-pm`.

Chaque invocation traite **au maximum une alliance**, choisie en alternance
parmi les alliances approuvées, dans l'ordre des empreintes SHA-256.
Chaque alliance traite **au maximum deux rosters de coéquipiers par passage**,
puis son roster personnel. Les fenêtres de quatre heures offrent 24
occasions par alliance si cinq alliances sont approuvées.

L'invocation de cron n'active pas le renouvellement de jetons OAuth :
les cron horaires existants conservent seuls ce rôle. Pas de doublon
de renouvellement toutes les deux minutes.

**Important :** les fenêtres sont en UTC, donc l'heure affichée en France
change selon les heures d'été/d'hiver.

## Activation volontaire, après rétention R2

La PR est volontairement **désactivée par défaut** et ne peut pas démarrer
par un simple merge :

- `ROSTER_AUTO_ENABLED="false"` ;
- `ROSTER_RETENTION_CONFIRMED="false"`.

Avant de passer les DEUX paramètres à `"true"`, configurer dans
Cloudflare R2 (bucket **losp-roster-sessions**) une règle de cycle de vie
qui supprime, à 7 jours, les objets dont la clé commence par :

```
roster-batches/v1/
```

Le préfixe est primordial : il ne faut **jamais** appliquer une expiration
globale qui supprimerait les sessions OAuth `oauth-captains/v1/`.

La suppression des snapshots orphelins et des anciennes séries est
assurée par la règle R2. Les champs `expiresAt` dans les objets R2
protègent également contre la réutilisation logique après expiration.
Le pilote `roster-pilot/v1/latest/` doit aussi avoir sa propre
règle de suppression à 7 jours s'il reste utilisé.

Après avoir vérifié la règle R2 et l'état de la PR, passer à `true`
les deux variables `vars` du `wrangler.jsonc`, puis déployer.
Cela lance automatiquement la première campagne lors de la
prochaine fenêtre planifiée, sans cliquer sur « Collecter le prochain lot ».
Le statut de l'automatisation figure dans `/admin`.

**Ne pas activer** avant de vérifier le comportement en production de la
lecture personnelle et du roster complet sans `perPage` : les tests
de GitHub Actions utilisent des réponses simulées.

## Règles de sécurité et contrôles

- Un verrou Durable Object **global** sérialise les passages de cron,
  en plus du verrou séparé de chaque alliance.
- Un passage déjà traité ne relit pas les rosters.
- Maximum **18 GET Scopely par passage**, **950 GET par jour UTC**.
  Le compteur compte aussi les `344`, les erreurs et les GET de contrôle.
  Ces plafonds ne comprennent pas les appels au fournisseur OAuth Hydra.
- Un `429` produit un délai de **60 minutes** ; les erreurs transitoires
  entraînent une pause de **20 minutes** pour l'alliance concernée.
  Aucune rafale de tentatives.
- Les GET de contrôle des membres et de l'alliance vérifient toujours
  les changements d'effectif et les autorisations.
- La série est validée seulement après la sauvegarde en R2 des
  coéquipiers **ET** du roster personnel.
- Si un membre ne partage pas son roster, l'alliance est
  `partial-consent` : **aucun manifeste complet n'est publié**.
- Si l'effectif change entre deux campagnes, l'ancienne base n'est
  pas silencieusement reprise : le nouveau cycle peut repartir à zéro.
- Les identifiants Scopely des membres sont considérés comme
  **volatils**, jamais utilisés comme PID permanent.
- Les objets sont privés, aucun endpoint public de roster n'existe.

## Snapshots

- `roster-batches/v1/<fp>/<runId>/member-N.json` :
  roster d'un coéquipier partagé ;
- `roster-batches/v1/<fp>/<runId>/member-self.json` :
  roster personnel du compte OAuth ;
- `roster-batches/v1/<fp>/progress.json` : état privé de reprise ;
- `roster-batches/v1/<fp>/latest-complete.json` :
  pointeur privé mis à jour **après** achèvement complet ;
- `roster-auto/v1/days/YYYY-MM-DD.json` : compteurs agrégés
  et verrouillage logique du passage ;
- `roster-auto/v1/cooldown/<fp>.json` : temporisation par alliance.

Ces objets restent réservés au Service. La WebApp viendra
ultérieurement les **lire via un contrat GET authentifié**, mais
aucune partie de ce travail n'implémente cette future interface.

## Validation et limites

Les tests exécutés par GitHub Actions vérifient les scénarios
de campagnes successives, reprises, idempotence, quotas,
consentement, périmètre privé, lecture personnelle,
`since` et réponse `344`.

La vraie exécution Scopely du roster personnel en production et le
comportement réel du cron Cloudflare restent à confirmer après déploiement.
Le premier cycle doit être surveillé avant de considérer le service
comme définitivement opérationnel.
