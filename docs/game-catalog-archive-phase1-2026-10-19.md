# Collecte officielle MSF /game/v1 — Phase 1

Source : [Scopely OpenAPI beta 0.2.1](https://developer.marvelstrikeforce.com/beta/msf-api.json), consultée le 19 octobre 2026.

## Contrat de collecte

Le LoSP Roster Service récupère d'abord les JSON originaux, **sans supprimer
de champs**, puis permettra des vues spécialisées ultérieures. Ce chantier
ne change aucune campagne de rosters, aucun PID Google Sheets et aucune page
GitHub Pages. Les seuls endpoints amont appelés sont des `GET /game/v1/...`
documentés et le `POST /oauth2/token` du flux applicatif.

L'OAuth `client_credentials` est officiellement permis par le schéma
`AccessTokenCSB` pour une application serveur, mais l'autorisation de **notre
application** reste à confirmer avec un premier test de production. Aucun jeton
de capitaine ne sert de repli en cas de refus.

## Racines collectées

`languages`, `localizations`, `decorations`, `upgradeData`,
`iso8Abilities`, `analysis/teamOrder`, `traits`, `characters`,
`characterInstances`, `characterInstanceCaps`, `dds`, `raidGroups`,
`raids`, `pickYourPoisons`, `survivalTowers`, `events`, `scopes`.

Les pages de liste sont demandées à `perPage=100`. Une réponse HTTP
`472` ou JSON trop volumineuse diminue ce nombre, avec reprise depuis la
première page du nouveau découpage. La liste est validée à l'aide de
`meta.perTotal` s'il est présent ; les pages identiques répétées,
les changements de `perTotal` et les dépassements de limite bloquent la
campagne sans lui attribuer un faux statut complet.

Pour les racines qui permettent de retrouver des identifiants, le Worker
programme les GET de détail **après la validation de toutes les pages**.
Les clés objet documentées pour `upgradeData`, `iso8Abilities` et
`analysis/teamOrder` sont également parcourues lorsque présentes dans
la réponse. Une fiche de détail inexistante est enregistrée comme **écart**
plutôt que d'être inventée.

## Architecture R2

Préfixe : `game-archive/v1/`

- `active.json` : identifiant opaque de la campagne en cours ;
- `runs/{uuid}/progress.json` : curseur, tâches en attente, état,
  compteurs, écarts et pause ;
- `runs/{uuid}/objects/{sha256}.json` : **octets JSON exacts** reçus
  de Scopely, dédoublonnés selon SHA-256 ;
- `runs/{uuid}/receipts/...` : URL relative exacte appelée, taille,
  horodatage, empreinte et clé du JSON ;
- `budget/YYYY-MM-DD.json` : compteur UTC distinct de celui des rosters.

Les archives sont **privées**. Contrairement aux rosters, ce préfixe ne
se trouve pas sous la règle connue de suppression `roster-batches/v1/`
à 7 jours. La durée effective dépend toutefois des règles R2 déployées :
ne pas affirmer qu'une conservation éternelle est garantie sans les auditer.

## Déclenchement et sécurité

- `/admin/api/game-archive` est protégé par le même Cloudflare Access
  JWT administrateur que l'Explorer.
- `GET` retourne des compteurs sans aucun contenu brut.
- `POST {"action":"start"}` crée une nouvelle campagne, seulement s'il
  n'en existe pas déjà une en cours.
- `POST {"action":"tick"}` exécute immédiatement un passage borné.
- Cron indépendant `* * * * *` : **toutes les minutes, pendant une
  campagne active**, maximum **6 GET MSF par passage**. Capacité maximale
  théorique : **360 GET/h**, **8 640 GET/jour UTC**. Le garde-fou interne
  de **9 000 GET/jour UTC** évite une boucle accidentelle et laisse une
  marge pour des essais administrateur. Ce n'est pas une limite Scopely
  officiellement annoncée, et le `429` reste prioritaire.
- **À l'état `completed` ou `completed-with-gaps`**, le Cron ne fait
  plus d'appels OAuth ni GET `/game/v1`. Il ne lance pas de nouveau
  balayage automatiquement.
- La reprise lit la campagne déjà enregistrée dans R2 : **aucun besoin
  de redémarrer une campagne pour bénéficier du nouveau Cron**, y compris
  si elle a été commencée avant la modification.
- Réutilisation opportuniste du token OAuth applicatif dans la mémoire de
  l'isolat Worker tant qu'il reste valable ; jamais stocké en clair dans
  R2. Un nouvel isolat peut nécessiter une nouvelle authentification.
- Le budget est **entièrement séparé** du plafond de 2 500 GET/jour des
  rosters.
- Une réponse `429` suspend les prochains passages ; les erreurs OAuth,
  réseau, les HTTP non résolus et les volumes non paginables sont signalés,
  sans boucle de requêtes ni substitution de jeton personnel.
- Verrou Durable Object distinct ; aucune mutation de jeu.

## Ce qui reste volontairement non couvert

**Cette PR n'est pas la collecte intégrale de tout MSF.** À partir de ce
socle il reste à traiter :

1. Les données imbriquées (salles, chapitres, tiers, missions, combats),
   avec découverte de leurs identifiants depuis les réponses réelles.
2. Les objets accessibles uniquement par `/items/{itemId}`,
   `/orbRewards/{itemId}`, `/episodics/{episodicType}`, etc.
3. La couverture multi-langues et les variantes d'expansion
   (`abilityKits=full`, `costumes=full`, `pieceInfo=full`,
   `flexFields`, etc.). **Les valeurs par défaut ne suffisent pas**
   nécessairement à tout inclure.
4. Les véritables fichiers CSV pointés par certaines réponses de
   `/localizations/{tableId}`. Leurs liens sont archivés ; pas leurs
   octets à ce stade.
5. Les raccourcis paramétriques de statistiques : pas de balayage
   combinatoire illimité ; établir des paramètres utiles à partir du
   jeu réel avant de les exécuter.
6. La maintenance périodique après une campagne complète, la
   comparaison des versions et un rapport d'exhaustivité vérifiable.

Les statuts `completed` et `completed-with-gaps` s'appliquent donc
uniquement à **cette phase 1 et aux tâches découvertes**. Ils ne signifient
jamais que toutes les ressources de toutes les API MSF ont été récupérées.
