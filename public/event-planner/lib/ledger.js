// Registre du stock (MSF.md §7.5) : stock estimé = dernière déclaration + récompenses des paliers réclamés depuis
// − dépenses mesurées depuis (plus grand delta en unités parmi les compteurs soFar de la ressource, jamais la somme).
// Pur : l'état est fourni et renvoyé ; le service le stocke par joueur.
import { RESOURCES, classifyObjective } from './classify.js';

// Ressources de stock utilisables par le plan (or, modules, ions, noyaux) ; jetons et énergies exclus
export const isStockResource = (key) => RESOURCES[key]?.nature === 'stock' && RESOURCES[key]?.preference != null;

/**
 * Relevé d'un événement à jalons de la liste du joueur (texte EN) : compteurs des lignes de dépense plafonnées,
 * ressources de stock demandées, paliers réclamés et récompenses par palier (clés brutes de l'API, sans décalage).
 * rewardsByTier : { [palier]: [{ itemId, quantity }] } (détail de l'événement, mis en cache par le service).
 */
export function observeEvent(event, rewardsByTier = {}) {
    const scoring = event?.milestone?.scoring || {};
    const progress = (event?.milestone?.brackets || []).find((bracket) => bracket.objective?.progress)?.objective?.progress || {};
    const tierProgressKnown = typeof progress.completedTier === 'number' && Number.isFinite(progress.completedTier) && Array.isArray(progress.claimableTiers);
    const counters = [];
    const unknownCounters = [];
    const uses = new Set();
    (scoring.cappedScorings || []).forEach((entry, index) => {
        const methods = entry.methods || [];
        const parsed = methods.map((method) => classifyObjective(method.description));
        const resource = parsed[0]?.resource;
        if (!resource || !isStockResource(resource) || parsed.some((item) => item.kind !== 'spend' || item.resource !== resource)) return;
        uses.add(resource);
        const pointsPerUnit = Math.max(...methods.map((method) => Number(method.points) || 0));
        const counterKey = `${event.id}:${index}`;
        const progressKnown = typeof entry.soFar === 'number' && Number.isFinite(entry.soFar);
        const capKnown = typeof entry.cap === 'number' && Number.isFinite(entry.cap);
        if (pointsPerUnit > 0 && progressKnown && capKnown) counters.push({ key: counterKey, resource, soFar: entry.soFar, cap: entry.cap, pointsPerUnit });
        else unknownCounters.push({ key: counterKey, resource });
    });
    (scoring.methods || []).forEach((method) => {
        const parsed = classifyObjective(method.description);
        if (parsed.kind === 'spend' && isStockResource(parsed.resource)) uses.add(parsed.resource);
    });
    return {
        id: event.id, startTime: Number(event.startTime) || 0, endTime: Number(event.endTime) || 0, counters, unknownCounters, uses: [...uses],
        completedTier: typeof progress.completedTier === 'number' && Number.isFinite(progress.completedTier) ? progress.completedTier : null,
        claimable: Array.isArray(progress.claimableTiers) ? progress.claimableTiers.map(Number) : null,
        tierProgressKnown, rewardsByTier
    };
}

const claimedTiers = (observed) => !observed.tierProgressKnown ? [] : Array.from({ length: observed.completedTier }, (_, index) => index + 1).filter((tier) => !observed.claimable.includes(tier));
const snapshotClaimed = (observed) => observed.tierProgressKnown ? { upTo: observed.completedTier, unclaimed: observed.claimable } : { unknown: true };
const inSnapshot = (snapshot, tier) => tier <= snapshot.upTo && !snapshot.unclaimed.includes(tier);
const rewardOf = (observed, tier, itemId) => (observed.rewardsByTier[tier] || [])
    .filter((reward) => reward.itemId === itemId).reduce((total, reward) => total + (Number(reward.quantity) || 0), 0);

/** Nouvelle déclaration : compteurs et paliers réclamés actuels deviennent la base. now en ms. */
export function declareResource({ resource, value, now, observations }) {
    const counters = {};
    const claimedAtDeclaration = {};
    observations.forEach((observed) => {
        observed.counters.filter((counter) => counter.resource === resource)
            .forEach((counter) => { counters[counter.key] = { base: counter.soFar, last: counter.soFar, cap: counter.cap, pointsPerUnit: counter.pointsPerUnit }; });
        claimedAtDeclaration[observed.id] = snapshotClaimed(observed);
    });
    return { declared: value, declaredAt: now, counters, claimedAtDeclaration, received: {} };
}

/**
 * Mise à jour à chaque visite : dernier soFar des compteurs (un événement terminé garde sa dernière valeur), compteurs
 * nouveaux (base 0 si l'événement a commencé après la déclaration), récompenses des paliers réclamés depuis, comptées une fois.
 */
export function refreshResource(state, resource, observations) {
    const itemId = RESOURCES[resource]?.itemId;
    const counters = { ...state.counters };
    const claimedAtDeclaration = { ...state.claimedAtDeclaration };
    const received = { ...state.received };
    observations.forEach((observed) => {
        const startedAfter = observed.startTime * 1000 > state.declaredAt;
        observed.counters.filter((counter) => counter.resource === resource).forEach((counter) => {
            const known = counters[counter.key];
            counters[counter.key] = known ? { ...known, last: counter.soFar, cap: counter.cap }
                : { base: startedAfter ? 0 : counter.soFar, last: counter.soFar, cap: counter.cap, pointsPerUnit: counter.pointsPerUnit };
        });
        // Les récompenses ne sont suivies que lorsque les deux champs de palier sont présents.
        // Une première observation inconnue devient la base lors de la première observation complète.
        if (!claimedAtDeclaration[observed.id]) claimedAtDeclaration[observed.id] = { unknown: true };
        if (claimedAtDeclaration[observed.id].unknown) {
            if (!observed.tierProgressKnown) return;
            claimedAtDeclaration[observed.id] = startedAfter ? { upTo: 0, unclaimed: [] } : snapshotClaimed(observed);
            return;
        }
        if (!observed.tierProgressKnown) return;
        if (!itemId) return;
        claimedTiers(observed).forEach((tier) => {
            const key = `${observed.id}:${tier}`;
            if (key in received || inSnapshot(claimedAtDeclaration[observed.id], tier)) return;
            const amount = rewardOf(observed, tier, itemId);
            if (amount > 0) received[key] = amount;
        });
    });
    return { ...state, counters, claimedAtDeclaration, received };
}

/** Stock estimé : { value, source, spentSince, earnedSince, declaredAt } ; un compteur plafonné sur la période est écarté. */
export function estimateResource(state) {
    const spentSince = Object.values(state.counters)
        .filter((counter) => counter.last < counter.cap && counter.last >= counter.base)
        .reduce((max, counter) => Math.max(max, Math.floor((counter.last - counter.base) / counter.pointsPerUnit)), 0);
    const earnedSince = Object.values(state.received).reduce((total, amount) => total + amount, 0);
    return {
        value: Math.max(0, state.declared + earnedSince - spentSince),
        source: spentSince > 0 || earnedSince > 0 ? 'estimated' : 'declared',
        spentSince, earnedSince, declaredAt: state.declaredAt
    };
}

/** Ressources de stock demandées par les événements actifs non skippés, dans l'ordre du catalogue de ressources. */
export function resourcesInUse(observations, skipped = []) {
    const used = new Set(observations.filter((observed) => !skipped.includes(observed.id)).flatMap((observed) => observed.uses));
    return Object.keys(RESOURCES).filter((key) => used.has(key));
}
