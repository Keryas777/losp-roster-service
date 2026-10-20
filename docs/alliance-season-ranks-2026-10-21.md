# Capture ponctuelle des classements d'alliances — avant le 25 octobre 2026

## Objectif urgent

Les classements guerre et raid peuvent changer au renouvellement des
saisons du jeu. Cette petite fonctionnalité permet, **avant la transition**,
d'enregistrer les valeurs renvoyées par Scopely pour chaque alliance
ayant une session de capitaine OAuth valide dans le Worker.

Cette collecte est **indépendante** de l'exploration `/game/v1/`
et de l'audit de structures R2. Elle ne touche ni aux rosters, ni aux
workflows ou quotas du collecteur général.

## Source et sémantique

GET `/player/v1/alliance/card`, via les sessions déjà autorisées
`m3p.f.ar.pro`. La réponse est un `AllianceCard` officiel.

Sauvegarder uniquement :
- l'empreinte privée et stable d'identité d'alliance (SHA-256 du stable AID),
- son nom retourné par l'API,
- `warRank` et `raidRank` (rangs récents),
- `warTrophies` et `warLeague.id/name`,
- le nombre de sessions autorisées pour l'alliance et les indicateurs
  de couverture de capture,
- la date exacte UTC `capturedAt`.

Ne **pas** déclarer que la fiche contient un score de saison raid :
aucun champ vérifié de ce type n'est disponible.
`warTrophies` n'est pas une somme de points saisonniers de guerre.
Le JSON `AllianceCard` ne fournit pas l'identifiant de saison :
`seasonId:null`, `seasonVerified:false`. Vérifier le libellé
affiché dans MSF avant d'associer la capture à une saison.

## Exécution

Après merge et déploiement du Worker :

1. Ouvrir `/admin`, section « Sauvegarde des classements raid / guerre ».
2. Appuyer sur **« Capturer les classements maintenant »**.
   La route effectue au plus 12 GET `AllianceCard` officiels,
   avec les jetons de sessions existantes. Aucun jeton n'est enregistré
   dans la capture ni rendu au navigateur.
3. Vérifier les noms des alliances et les compteurs
   `connectedAlliances`, `unavailableSessions` et
   `completeSessionScan`. Une alliance non connectée
   **n'est pas récupérée et ne doit pas être annoncée comme sauvée**.
   La liste n'impose aucun nombre ni aucun nom d'alliance codé en dur.
4. « Copier la capture JSON » pour une revue avant le changement
   de saison ; vérifier sa cohérence avec le classement affiché
   dans le jeu.
5. Faire une deuxième capture plus proche de dimanche si utile,
   après le délai anti-duplicata de dix minutes.

Un clic répété dans les dix minutes n'appelle pas Scopely de nouveau :
le dernier relevé déjà obtenu est retourné.

## Conservation R2

`roster-batches/v1/season-ranks/latest.json` et
`roster-batches/v1/season-ranks/captures/*.json`.

Ces fichiers bénéficient de la règle de suppression **7 jours**
déjà vérifiée pour `roster-batches/v1/`. Il n'y a
pas de nouvelles règles R2 à configurer. Ne pas déplacer ces captures
sur un préfixe non soumis à un TTL sans solution contractuelle de
rétention. Après l'expiration, les captures seront supprimées ;
la copie/export doit respecter les conditions MSF API.

## Sécurité

- L'API administrative est derrière l'authentification Cloudflare Access
  existante, plus vérification d'origine et `application/json`
  pour les POST.
- Aucune route publique, liste mondiale, scrape d'alliance extérieure
  ou accès à un roster joueur.
- GET relit uniquement la dernière capture R2, zéro appel fournisseur.
- L'administration utilise `textContent`, y compris sur les noms colorés.
- Les comptes non autorisés ou indisponibles restent visibles dans
  les indicateurs ; pas de faux zéro, pas de garantie de cinq alliances
  ou de classement mondial.
