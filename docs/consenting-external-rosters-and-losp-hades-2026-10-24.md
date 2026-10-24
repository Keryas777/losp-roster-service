# Collectes LoSP et comptes extérieurs — 24 octobre 2026

## Règle validée
- **Une alliance LoSP approuvée** est collectée par le pipeline collectif existant : tous les membres **qui partagent effectivement leur roster**, sans quota fixe de deux membres. Le roster propre au titulaire OAuth est collecté séparément dans la même campagne, et l'achèvement n'est publié qu'après validation.
- **Hadès** est une alliance LoSP à intégrer dans ce registre comme les autres. Son effectif actuel de deux joueurs n'est PAS un plafond technique.
- **Une alliance extérieure** reste détectée dans l'annuaire privé Admin, mais ses membres ne sont **jamais** collectés en masse. À chaque nouvelle connexion de joueur autorisant `m3p.f.pr.ros`, seul son roster personnel est capturé automatiquement dans R2 privé pour sept jours ; les listes d'effectif sont utilisées transientement pour valider `isSelf` et ne sont pas archivées.
- Les comptes d'une alliance extérieure sont exclus de la campagne LoSP plus riche `/player/v1` (inventaire, souhaits, événements, équipes partagées). Les anciennes sessions LoSP sans entrée d'annuaire font l'objet d'un rattrapage d'identification au lieu d'être abandonnées.
- Les **rangs de guerre**, **rangs de raid** et **trophées de guerre**, ainsi que la ligue retournée par AllianceCard, ne sont archivés que pour les alliances LoSP approuvées.

## Intégration d'Hadès (une fois)
1. Déployer le commit sur Cloudflare Workers (pas de workflow automatique de déploiement dans le dépôt).
2. Ouvrir `/admin#rosters`, section *Alliances connectées automatiquement*.
3. Cliquer sur **Inclure Hadès dans les collectes LoSP**. Le Worker refait une vérification Scopely et **ajoute** l'empreinte stable à `roster-sync/v1/approved-alliances.json` sans modifier les autres entrées.
4. Les prochains créneaux de collectes rosters existants incluront alors Hadès et **tous ses membres partageant leur roster**. L'absence de partage n'est jamais contournée.
5. Les captures privées des classements de toutes les alliances LoSP approuvées ont lieu **deux fois par jour**, à 03:15 et 15:15 UTC, via le cron horaire déjà présent. Une capture manuelle reste possible dans Admin.

## Sécurité et non-régression
- Aucun nom d'alliance ni limite d'effectif hardcodé.
- L'affichage dans Admin ne signifie jamais qu'une alliance extérieure est autorisée à la collecte collective.
- La collecte personnelle n'utilise pas `/player/v1/roster/member/{id}` et conserve seulement le roster propre au titulaire du consentement.
- Aucun changement à `/game/v1`, à la cadence de campagne des rosters collectifs, à la fusion des fichiers sur GitHub Pages ni aux paramètres payants Cloudflare.
- Les anciennes collectes en cours gardent leurs checkpoints R2. La distinction LoSP/externe est vérifiée avant d'effectuer les prochaines lectures `/player`.
- Aucun nouveau cron Cloudflare Free.
- Ne pas qualifier les trophées de guerre de « points de saison » : les champs `warTrophies`, `warRank` et `raidRank` proviennent directement de `AllianceCard`.

## Validation post-déploiement
Vérifier Hadès dans `/admin#rosters` après son intégration ; contrôler `latest-complete.json` et la présence des rosters autorisés dans R2, ainsi que la capture `season-ranks/latest.json`. Les erreurs 429 et les dépassements CPU de Workers Free restent à surveiller. La présence effective de Hadès en production ne peut pas être confirmée uniquement depuis GitHub.
