# Mini-audit des comparaisons différentielles MSF — 3 novembre 2026

## Pourquoi
La campagne /game du 2–3 novembre 2026 s'est achevée avec
12 232 URL traitées, 9 986 résultats `changed`, 0 `unchanged`
et 2 246 `failed`. Ces chiffres ne prouvent pas qu'autant de réponses
ont véritablement changé. Le collecteur compare déjà les empreintes
sémantiques en ignorant uniquement `meta.asOf`, et ses tests locaux
valident une deuxième collecte identique.

Ce diagnostic **n'attribue aucune cause à la campagne réelle avant
l'exécution du mini-audit sur R2**.

## Fonctionnement
Depuis l'administration Cloudflare Access :
**Archives R2 → Comparer les versions différentielles → Démarrer**.

- Démarrage sur POST explicite, origine et JSON contrôlés.
- Le Cron existant continue les lectures R2 par lots de **3 URL par
  minute** avec un verrou Durable Object propre à l'audit.
- Échantillon déterministe, plafonné à **24 URL**, **8 par famille**
  (personnages, objets, listes et autres), et **600 pointeurs**
  examinés maximum ; ces nombres ne prétendent pas former
  un échantillon statistiquement représentatif.
- Le checkpoint est conservé dans
  `game-archive/v1/diff/comparison-audit/v1/progress.json`,
  **seul emplacement écrit** par ce diagnostic.
- Aucun nouvel appel Scopely ; aucun changement des données,
  reçus, archives, pointeurs `latest/`, quotas ni checkpoints.
- Le rapport reste disponible après fermeture de Safari ; aucun
  chargement automatique de l'audit à l'ouverture de l'administration.

## Preuves nécessaires pour comparer
Pour chaque pointeur `latest/<sha(path)>.json` :

1. Vérifier le chemin, la campagne et le hash du chemin.
2. Lire le reçu courant `receiptKey` et vérifier la concordance
   de l'URL, du SHA-256 déclaré et de l'objet référencé.
3. Lire **`sourceReceipt`** depuis le reçu courant. Si ce champ
   manque, on classe `no-linked-previous-version`, sans inventer une
   association avec l'archive initiale.
4. Vérifier le reçu antérieur, son chemin et son objet R2.
5. Relire les deux objets officiels et recalculer le SHA-256 des
   **octets conservés** (limite de 512 Ko par objet).
6. Calculer les deux empreintes avec **exactement la fonction
   utilisée par le collecteur**, via `gameSemanticHash`. Ne
   pas créer une deuxième logique de normalisation différente.
7. Comparer les classements réellement enregistrés : une empreinte
   identique avec `status=changed` constitue un faux positif
   démontrable ; une empreinte différente avec `status=unchanged`
   constitue un changement manqué.
8. Si les empreintes diffèrent, distinguer changements de `data`
   et changements de métadonnées hors `meta.asOf`. Afficher
   **uniquement les chemins des champs différents**, limités à 12.

## Catégories du rapport
- `false-change` : l'ancien et le nouveau contenu sémantique sont
  identiques alors que le reçu actuel indique `changed`.
- `missed-change` : contenu sémantiquement différent malgré
  `unchanged`.
- `byte-identical`, `only-asof-or-order` : inchangé confirmé.
- `metadata-other-change` : réponse dont `data` est identique,
  mais d'autres métadonnées (non ignorées par le collecteur) évoluent.
- `data-change` : changement détecté dans les données métier.
- `no-linked-previous-version` : pas de lien prouvé ; aucune
  comparaison historique possible.
- Autres anomalies explicites : reçu absent ou incohérent, objet
  inexistant/trop volumineux, SHA erroné, enveloppe invalide,
  empreinte sémantique incohérente.

Les octets JSON, valeurs des champs, jetons et données joueur ne
sont jamais copiés dans le rapport. Les seules URL exposées sont
les chemins officiels `/game/v1/` déjà accessibles aux
administrateurs. Aucun contenu n'est publié sur GitHub.

## Précautions
- La lecture R2 est bornée : jusqu'à 12 pointeurs listés,
  trois analysés par tick, max 512 Ko par version.
- Si une lecture R2 échoue, l'avancement du checkpoint n'est pas
  validé et le tick suivant peut reprendre proprement.
- La liste `latest/` peut évoluer pendant l'analyse ;
  le rapport compare le checkpoint source début/fin et signale
  `sourceChanged`. Il ne revendique pas d'instantané atomique.
- L'absence d'un vieux fichier après son expiration R2 n'est
  pas une preuve de corruption historique.
- Le simple fait d'avoir beaucoup de `changed` ne justifie
  pas d'ajouter des champs à une liste d'exclusion.
  **Aucune modification des règles de comparaison n'est effectuée
  dans cette PR.** Toute correction ultérieure devra être
  motivée par des preuves et des tests ciblés.

## Validation
Tests locaux simulant R2 et Cloudflare Access :
faux changement `meta.asOf`, changement `data`, variation
d'autres métadonnées, octets identiques, provenance absente,
hash incohérent, erreur R2/reprise durable, changement d'état
source, plafond de lecture, contrôle CSRF et UI manuelle.
Aucune activité Scopely en production pendant les tests.

## Exploitation
Fusionner la PR après CI, vérifier son déploiement Cloudflare,
puis lancer le diagnostic dans l'administration.
Lire le résumé et copier le rapport JSON. Si l'échantillon
manque de liens `sourceReceipt`, il faut reconnaître le manque
de provenance au lieu de déduire un pourcentage de changement.
