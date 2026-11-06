# Associations Discord ↔ MSF — administration privée

## Usage

Dans le Roster Service (site Cloudflare Access), ouvrir **/admin → Rosters → Associations Discord / MSF**.

1. Cliquer « Charger les membres et joueurs », puis choisir l'alliance.
2. Sélectionner un pseudo MSF issu de l'annuaire LoSP ou des rosters invités déjà publiés/validés dans R2.
3. Sélectionner un compte Discord. Seuls les membres portant un rôle du groupement choisi sont proposés.
4. Cliquer « Associer les comptes ». Une association peut être remplacée ou supprimée depuis le tableau.
5. Après connexion Discord à la WebApp, War Counters et Attack Checker présélectionnent l'alliance et le joueur du compte identifié.

Les associations ne sont **pas inférées** à partir de pseudonymes similaires. Un compte Discord peut avoir plusieurs associations, au maximum une par alliance. Un joueur MSF ne peut pas être lié à deux comptes Discord dans la même alliance.

## Prérequis et déploiement

- Conserver la politique Cloudflare Access et la liste d'e-mails administrateurs existantes couvrant **/admin** et **/admin/***.
- Ajouter au Worker **losp-roster-service** le secret Cloudflare **DISCORD_BOT_TOKEN** correspondant au bot Discord déjà autorisé à consulter le serveur LoSP. Ne jamais le mettre dans GitHub ni dans le navigateur.
- Vérifier que le bot est bien membre du serveur et qu'il possède l'intent privilégié **Server Members / GUILD_MEMBERS**, nécessaire à la liste paginée des membres Discord. Si la liste est refusée par Discord, l'administration affiche une indisponibilité et aucune association n'est enregistrée.
- Déployer d'abord le Roster Service. Tester sous Cloudflare Access l'onglet d'administration et une association volontaire.
- Fusionner/déployer ensuite la PR de WebApp contenant le lecteur client signé : le lecteur ignore les erreurs serveur et conserve la sélection manuelle habituelle.
- Aucun nouveau Cron, OAuth Scopely, collecte, publication R2 vers GitHub, règle de saison ou traitement de roster n'est ajouté.

## Sécurité

- **GET/POST /admin/api/player-links** : validé par le contrôle Cloudflare Access existant de chaque requête. POST vérifie également l'origine et le Content-Type JSON.
- Les menus Discord sont récupérés côté serveur sur demande, avec le bot. Les noms et IDs Discord ne sont jamais écrits dans le dépôt public.
- Les associations sont enregistrées sous **identity-links/v1/mappings.json** dans le bucket privé CAPTAIN_BUCKET existant, en dehors des préfixes de snapshots de rosters à courte rétention. Il s'agit de configuration manuelle d'identité, à supprimer si le lien n'est plus nécessaire.
- **GET /api/secure/player-links** : accepte uniquement une session Discord HMAC valide et soumet son token au binding interne **LOSP_AUTH /signed-access** (rôles réévalués). Retourne uniquement les paires {alliance,player} du compte Discord vérifié et autorisées par ses rôles actuels.
- Les sessions historiques non signées, autres origines, rôles révoqués et absence de configuration refusent la lecture privée. L'absence d'association retourne une liste vide.
- Les collisions de pseudo MSF sont bloquées et une révision SHA-256 est vérifiée avant chaque écriture. Une seule administration humaine devrait modifier le registre à la fois ; cette vérification optimiste ne constitue pas un verrou atomique inter-requêtes.
- Le mode « Voir comme » est une simulation d'interface : la présélection sécurisée n'y est pas déclenchée.

## Données d'entrée et limites connues

- LoSP : annuaire public existant **data/joueurs.json**, contrôlé par **data/alliances.json**.
- Invités : shard **data/rosters_<sourceKey>.json** ; si indisponible, projection des seuls rosters invités déjà approuvés et complets depuis R2 privé. Une alliance sans roster exploitable ne peut pas encore être associée.
- Rôles de groupement : **data/access-groups.json**. ENDGAME possède un rôle de groupement commun aux alliances Red et Orange ; l'administrateur choisit explicitement l'alliance correspondante.
- La liste des membres Discord exige un accès autorisé au bot et peut être indisponible ou trop volumineuse. Les erreurs doivent être corrigées à la source, jamais contournées en proposant des identités non vérifiées.
- Le nom MSF n'est pas un ID joueur officiel immuable. Lors d'un changement de pseudo ou d'alliance, l'administrateur doit mettre à jour l'association.

## Contrôles manuels recommandés

- Un membre LoSP lié se retrouve sur sa propre alliance dans les deux outils.
- Un invité MARINES lié ne voit pas une association Zeus.
- Un invité ENDGAME est présélectionné Red ou Orange selon la paire validée.
- Une première connexion sur un navigateur neuf retrouve la même identité, sans dépendre du localStorage de sélection.
- Changement manuel de joueur toujours possible.
- Dissociation ou révocation du rôle Discord : la prochaine ouverture ne propose plus cette association.
- Échec Discord/R2/session signée : aucune exposition d'une autre identité ; sélecteurs manuels existants conservés.
