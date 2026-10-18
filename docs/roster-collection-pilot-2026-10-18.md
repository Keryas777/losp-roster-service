# Phase pilote : lecture complète d'un roster partagé vers R2 privé

Ce chantier suit la PR #45 : autorisation privée explicite des alliances LoSP.
**Il ne réalise PAS encore la collecte automatique des cinq alliances**.

## Exécution manuelle

Dans `/admin` (Cloudflare Access), cliquer « Vérifier les alliances connectées »,
puis « Tester 1 roster » sur une alliance **déjà approuvée**.

Le Worker :
1. Contrôle le JWT administrateur signé, le `POST` et l'en-tête `Origin`.
2. Relit le registre privé `roster-sync/v1/approved-alliances.json`, et vérifie
   l'empreinte stable de l'alliance choisie.
3. Énumère au plus 12 sessions OAuth privées et découvre la **vraie alliance
   actuelle** de chacune depuis Scopely. Une liste tronquée est refusée.
4. Pour le premier compte de l'alliance approuvée, demande l'effectif actuel,
   valide un unique membre `isSelf`, puis choisit le **premier coéquipier**
   partageant explicitement son roster. Aucun membre dont
   `card.rosterShare !== true` n'est lu.
5. Lit **toutes les pages** de son roster avec le collecteur existant
   (`/player/v1/roster/member/{memberId}`), `charInfo=full`.
   Pagination incohérente, réponse vide, limite ou erreur Scopely :
   **aucune donnée partielle n'est enregistrée**.
6. Relit l'effectif après pagination pour détecter changement de `memberId`
   ou retrait du partage, puis relit l'alliance actuelle et l'approbation
   administrative juste avant l'écriture.
7. Stocke un seul JSON privé : `roster-pilot/v1/latest/{fingerprint}.json`.
   Chaque nouveau pilote réussi de la même alliance **remplace** le précédent.
   Le rapport de retour admin ne contient que pseudo, nombre de personnages,
   pages, appels, date et expiration ; aucune fiche de personnage ni token.

Le roster du **compte connecté lui-même** n'est pas inclus dans cette phase :
sa future lecture doit utiliser `/player/v1/roster` et son scope personnel.

## Sécurité et conservation

- Prérequis : session capitaine chiffrée déjà présente, autorisation de partage
  officielle et alliance LoSP approuvée via la PR #45.
- Le pilote stocke les objets personnages **bruts** uniquement dans le bucket
  privé lié à `CAPTAIN_BUCKET` ; aucun objet n'est public.
- Conserver au maximum **7 jours** : `capturedAt`, `expiresAt` dans le
  document, puis purge quotidienne par le cron **déjà existant** `15 3 * * *`.
  Les snapshots dont l'alliance a été retirée des approbations sont purgés,
  même s'ils ne sont pas encore expirés.
- **Défense complémentaire recommandée dans Cloudflare R2** :
  configurer une règle de suppression après 7 jours sur le préfixe exact
  `roster-pilot/v1/latest/`, afin de couvrir les périodes où le cron n'est
  pas exécuté. Vérifier le préfixe : ne pas toucher à `oauth-captains/v1/`.
- Le `memberId` conservé dans ce pilote est explicitement **volatile**.
  Il n'est ni un PID ni une clé d'identité permanente.
- La taille du snapshot JSON est plafonnée à 3 Mo et le pilote concerne **un
  seul** coéquipier partagé ; ce plafond ne concerne pas les futurs lots.

## Interdictions conservées

Aucun endpoint public de téléchargement de rosters ; aucun `GET` de lecture
des snapshots pilotes n'est ajouté, même dans `/admin`.
**Aucun push vers GitHub, GitHub Pages, Google Sheets ou la WebApp.**
Aucun cron de téléchargement : le seul ajout à la tâche quotidienne est
le nettoyage R2, sans requête de roster à Scopely.
Aucune modification de la colonne PID ni des fichiers
`Keryas777/msf/docs/data/rosters_*.json`.

## Validation avant la prochaine étape

- Les tests GitHub Actions sont des simulations, pas une collecte réellement
  exécutée avec l'API Scopely en production.
- Après fusion, lancer **manuellement** le pilote sur une alliance approuvée,
  puis constater le nombre de personnages et de pages dans `/admin`.
- Comparer le JSON brut R2 à un CSV exporté depuis Scopely pour un joueur
  connu (étoiles, diamonds, gear, ISO-8, ISO orange, etc.).
- En cas de `429`, ne pas créer de boucle agressive de réessai.
- Une fois l'essai confirmé, introduire les **micro-lots de 1 à 3 joueurs**,
  les checkpoints privés et la validation atomique par alliance.
- La WebApp effectuera plus tard ses propres lectures HTTP GET depuis LoSP
  Roster Service ; ce chantier ne prévoit pas ces endpoints.
