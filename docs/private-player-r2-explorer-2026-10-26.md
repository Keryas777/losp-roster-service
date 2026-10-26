# Explorer les archives privées `/player/v1` — 26 octobre 2026

## But

Consulter **les octets JSON effectivement conservés dans Cloudflare R2**,
pas une simulation de l'OpenAPI ni une simple liste de compteurs.
**Aucun appel Scopely** ni nouvelle copie publique vers `Keryas777/msf/docs`.
L'accès reste réservé à l'administrateur, derrière **Cloudflare Access JWT
signé + allowlist d'emails**, déjà vérifiés par `src/admin-routes.js`.

## Où trouver l'outil

**Admin → Archives R2 → Explorer les vrais fichiers privés /player (R2)**.

1. Cliquer **Charger les comptes et alliances depuis R2**. Le tableau
   affiche des sessions OAuth sous empreinte et les alliances approuvées
   connues du registre R2, sans requête réseau Scopely.
2. Choisir **Familles personnelles et équipes partagées** puis un compte,
   une famille et **Lister les fichiers R2**. Lire le statut : archivé,
   page manquante, expiré, manifeste invalide, permission absente.
3. **Ouvrir ce fichier R2** affiche le JSON réellement enregistré. Les
   tableaux source sont affichés par tranches de **20 éléments** ;
   le numéro de la **page R2** est distinct de l'offset de visualisation.
   Les champs inconnus du fournisseur sont conservés dans l'aperçu.
4. Choisir **Rosters des alliances**, une alliance approuvée et la nature
   des fichiers :
   - **Rosters normalisés** : `member-N.json` et `member-self.json`
     de la dernière campagne complète encore valide ;
   - **Réponses originales Scopely** : `provider-source/{capture}/...`
     du même `runId`, avec `data`, `meta` et champs inconnus.
5. La page indique l'horodatage, l'expiration, le total réel des entrées
   du JSON, le dernier manifeste et la progression actuelle. Elle
   avertit si **l'archive complète de la veille** existe mais que la
   **nouvelle campagne** n'est pas terminée.

## Contrat API privé

`GET /admin/api/player-r2-explorer` ; chaque mode est strictement
borné, et n'accepte **aucun chemin R2 arbitraire** :

- `view=accounts` : inventaire R2 des empreintes de sessions et
  registre des alliances approuvées ;
- `view=extra&session=<SHA256>&family=<enum>` : statut, preuve
  physique HEAD des pages et dernières erreurs enregistrées ;
- `view=extra-file&session=<SHA256>&family=<enum>&target=self|<SHA256>&page=1..8&offset=0,20,...` :
  lecture d'une page provenant du `latest.json` vérifié ;
- `view=roster&fingerprint=<SHA256>` : manifeste, progression et dernier
  résultat Cron R2 de l'alliance approuvée ;
- `view=roster-file&fingerprint=<SHA256>&member=self|<index>&offset=...` :
  lecture des caractères d'un roster de la dernière campagne complète ;
- `view=roster-sources&fingerprint=<SHA256>` : inventaire borné des
  réponses originales sous le `runId` approuvé ;
- `view=roster-source&fingerprint=<SHA256>&source=<capture>/<nom-validé>&offset=...` :
  lecture d'une enveloppe Scopely effectivement stockée.

Les listing multi-objets utilisent un curseur opaque borné. L'outil
vérifie les chemins reconstruits, la source familiale, l'expiration de
sept jours, la cohérence du `runId`, la présence réelle des pages et
la validité du consentement OAuth **encore enregistré** avant lecture
des familles personnelles. Une limite de taille et une pagination
d'affichage protègent Cloudflare Workers et les navigateurs mobiles.

Les éventuels champs nommés `access_token`, `refresh_token`,
`authorization`, `cookie`, `client_secret`, `password` sont masqués
**dans l'affichage uniquement**. Les objets R2 d'origine ne sont
jamais altérés.

## Erreurs et limites

- `missing` : absence de fichier ou de pointeur ; ce n'est **pas**
  la preuve d'un refus de Scopely.
- `missing-pages` : pointeur présent, une ou plusieurs pages R2 absentes.
- `expired` : source périmée ; ne pas la présenter comme actuelle.
- `invalid-json` / `invalid-manifest` / `source-inconsistent` :
  format ou provenance incohérente ; le fichier n'est pas déclaré fiable.
- `scope-not-granted` : la permission personnelle correspondante n'est
  pas contenue dans le compte OAuth encore enregistré.
- `page-budget`, `provider-unavailable`, `rate-limited`, etc. :
  causes historisées **à partir du prochain déploiement** dans la
  campagne `/player` (maximum 60 entrées bornées dans son checkpoint).
- Les erreurs antérieures à ce journal ne peuvent pas être reconstituées.
  De même, le refus actuel d'un coéquipier ne peut pas être revérifié
  **sans une nouvelle requête Scopely**. L'explorateur indique seulement
  le consentement attesté au moment de l'archive.
- Les membres partagés sont identifiés par leur empreinte de cible,
  pas par leurs IDs transitoires. Il n'y a pas de nouveau registre
  d'identités persistantes.
- Les fichiers R2 `roster-batches/v1/` restent soumis à leur règle
  de rétention existante (sept jours).
- Les données privées ne sont jamais envoyées à des utilisateurs
  non administrateurs ni incluses dans les fichiers GitHub Pages.

## Hors périmètre

Aucune nouvelle collecte, aucun rafraîchissement OAuth, aucune modification
des quotas, des scripts d'import public, des transformations /game ou des
règles d'accès utilisateur. Ce chantier est un **lecteur administrateur** ;
les vues privées destinées aux joueurs eux-mêmes nécessiteront un contrôle
d'autorisation spécifique par joueur avant déploiement.

## Vérification réelle après déploiement

Sans accès au bucket R2 de production depuis la PR, les tests ne peuvent
pas prétendre lire les objets privés réels. Ouvrir le panneau protégé
après fusion/déploiement, choisir une famille avec `archived`,
ouvrir une page source, vérifier la réponse Scopely et le compteur
d'entrées ; pour un roster, comparer le dernier manifeste et les
fichiers source existants. Les tests fournissent uniquement une R2 simulée
et valident l'intégrité des chemins et les accès.
