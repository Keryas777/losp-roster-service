import * as msfEventLibrary from './index.js';

const DAY_SECONDS = 24 * 3600;
const MAX_LEVERS = 3;
const MAX_PLAYER_LEVEL = 110;   // niveau de joueur maximal du jeu : plafond du niveau des personnages
const TRAIT_SQUAD_SIZE = 5;     // hypothèse trait-fight-full-squad : un combat de trait demande 5 personnages du trait
// ISO : niveau de classe continu (iso8[iso8.active]), 5 niveaux par palier ISO. Confirmé sur un roster réel :
// P3 niv. 4 = raider 14 (hypothèse iso-levels-per-tier).
const ISO_LEVELS_PER_TIER = 5;
const isoThreshold = (isoTier, isoLevel) => (isoTier - 1) * ISO_LEVELS_PER_TIER + isoLevel;
const isoTierLevel = (value) => {
    const isoTier = Math.max(1, Math.ceil(value / ISO_LEVELS_PER_TIER));
    return { isoTier, isoLevel: value - (isoTier - 1) * ISO_LEVELS_PER_TIER };
};

const cleanText = (value = '') => String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Niveau ISO continu d'un personnage du roster : niveau de sa classe active (0 sans classe)
function isoValue(rosterEntry) {
    const iso8 = rosterEntry?.iso8;
    const value = iso8 && typeof iso8 === 'object' ? Number(iso8[iso8.active]) : NaN;
    return Number.isFinite(value) ? value : 0;
}

const ROSTER_FIELDS = { yellowStars: 'activeYellow', redStars: 'activeRed', gearTier: 'gearTier', level: 'level' };
const rosterValue = (kind, rosterEntry) => (kind === 'iso' ? isoValue(rosterEntry) : Number(rosterEntry[ROSTER_FIELDS[kind]]) || 0);

// Première exigence non remplie (ordre : possession, étoiles, équipement, niveau), ou null
function unmetRequirement(rosterEntry, requirements) {
    if (!rosterEntry) return { code: 'notOwned' };
    for (const [code, field] of Object.entries(ROSTER_FIELDS)) {
        if (requirements[code] == null) continue;
        const have = Number(rosterEntry[field]) || 0;
        if (have < requirements[code]) return { code, have, need: requirements[code] };
    }
    return null;
}

function tierRewards(tier) {
    const items = tier?.rewards?.allOf || tier?.rewards?.anyOf || [];
    return items.map((reward) => {
        const item = reward.item || reward;
        return { name: cleanText(item.name || item.id || ''), characterId: item.characterId || null, quantity: reward.quantity ?? null, icon: item.icon || null };
    });
}

// Plusieurs méthodes sous un même plafond : acceptées seulement si aucune n'est liée au roster
function mergeClassified(list) {
    if (list.length === 1) return list[0];
    if (list.length > 1 && list.every((item) => item.kind === 'spend' && item.resource === list[0].resource)) return list[0];
    if (list.length > 1 && list.every((item) => ['free', 'login'].includes(item.kind))) return { kind: 'free' };
    return { kind: 'unknown', reasonCode: list.length > 1 ? 'multiMethod' : 'noText' };
}

function uniqueScoringRows(rows) {
    const seen = new Set();
    return rows.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => {
        const identity = entry?.id ?? entry?.scoringId ?? entry?.key ?? entry?.objectiveId;
        const signature = identity != null ? `id:${identity}`
            : `shape:${JSON.stringify({ soFar: entry?.soFar, cap: entry?.cap, target: entry?.target, method: entry?.method,
                methods: entry?.methods?.map((method) => [method?.description, method?.points]) })}`;
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
    });
}

/**
 * Analyse d'un événement à jalons. Entrées : l'événement en anglais (analyse) et en français (libellés), le roster
 * (/player/v1/roster), le catalogue [{ id, nameEn, nameFr, portrait, traits }], l'heure courante (secondes) et le module
 * lib/msf-events déjà chargé, le stock connu (facultatif). Sortie { supported: false } si l'événement n'a ni progression ni sources de points.
 */
export function analyzeMilestoneEvent({ eventEn, eventFr, roster = [], rosterKnown = true, characters = [], now = Math.floor(Date.now() / 1000), msfEvents = msfEventLibrary, stock = null }) {
    const milestone = eventEn?.milestone;
    const scoring = milestone?.scoring || {};
    const bracketIndex = (milestone?.brackets || []).findIndex((bracket) => bracket?.objective && typeof bracket.objective === 'object');
    const objective = milestone?.brackets?.[bracketIndex]?.objective;
    const capped = uniqueScoringRows(scoring.cappedScorings || []);
    const methods = scoring.methods || [];
    if (!objective || (capped.length === 0 && methods.length === 0)) return { supported: false, reason: 'no-scoring-data' };

    const { classifyObjective, createSubjectResolver, RESOURCES, HYPOTHESES } = msfEvents;
    const frScoring = eventFr?.milestone?.scoring || {};
    const frObjective = eventFr?.milestone?.brackets?.[bracketIndex]?.objective || {};
    const charactersById = new Map(characters.map((character) => [character.id, character]));
    const resolveSubject = createSubjectResolver({ characters, traitIds: [...new Set(characters.flatMap((character) => character.traits || []))] });
    const rosterById = new Map((Array.isArray(roster) ? roster : []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
    const progress = objective.progress && typeof objective.progress === 'object' ? objective.progress : {};
    const offset = Number.isFinite(Number(progress.completionOffset)) ? Number(progress.completionOffset) : 0;
    const progressKnown = typeof progress.points === 'number' && Number.isFinite(progress.points);
    const knownScoringRows = capped.map((row) => row.entry).filter((entry) => typeof entry?.soFar === 'number' && Number.isFinite(entry.soFar));
    const unknownScoringRows = capped.length - knownScoringRows.length;
    // Maddoxx's event view sums capped scoring counters when the aggregate objective score is absent.
    // Use that fallback only when every capped row is numeric; a partial sum is never treated as a total.
    const scoringTotalKnown = capped.length > 0 && unknownScoringRows === 0;
    const scoringTotal = scoringTotalKnown ? knownScoringRows.reduce((total, entry) => total + entry.soFar, 0) : null;
    const points = progressKnown ? progress.points : scoringTotal;
    const pointTotalKnown = progressKnown || scoringTotalKnown;
    const progressState = progressKnown ? 'available' : scoringTotalKnown ? 'estimated' : knownScoringRows.length ? 'partial' : 'unknown';
    const reportedActionPoints = knownScoringRows.length ? knownScoringRows.reduce((total, entry) => total + entry.soFar, 0) : null;
    const completedTierKnown = typeof progress.completedTier === 'number' && Number.isFinite(progress.completedTier);
    const claimableTiersKnown = Array.isArray(progress.claimableTiers);
    const daysLeft = Math.max(0, Math.ceil((Number(eventEn.endTime) - now) / DAY_SECONDS));
    const unparsed = [];

    const characterRef = (id) => {
        const character = charactersById.get(id);
        return { id, name: character?.nameFr || character?.nameEn || id, portrait: character?.portrait || null };
    };
    const resourceFields = (key) => (key ? { resource: key, resourceLabel: RESOURCES[key]?.label?.fr || key } : { resource: null, resourceLabel: null });

    // --- Actions plafonnées ---
    const actions = [];
    capped.forEach(({ entry, index }) => {
        const entryMethods = entry.methods || [];
        const labelEn = entryMethods.map((method) => cleanText(method.description)).join(' / ');
        const label = (frScoring.cappedScorings?.[index]?.methods || []).map((method) => cleanText(method.description)).join(' / ') || labelEn;
        const capKnown = typeof entry.cap === 'number' && Number.isFinite(entry.cap);
        const progressKnown = typeof entry.soFar === 'number' && Number.isFinite(entry.soFar);
        const cap = capKnown ? entry.cap : null;
        const progressSoFar = progressKnown ? entry.soFar : null;
        const remaining = capKnown && progressKnown ? Math.max(0, cap - progressSoFar) : null;
        const parsed = mergeClassified(entryMethods.map((method) => classifyObjective(method.description)));
        const pointsPerAction = Math.max(0, ...entryMethods.map((method) => Number(method.points) || 0));
        // Maddoxx expose isPremium comme indication de la ligne; cela ne décide pas si elle est faisable gratuitement.
        const premium = Boolean(entry.isPremium);
        const skip = (reason) => unparsed.push({ source: 'capped', index, label, labelEn, reason, premium });
        if (parsed.kind === 'unknown') return skip(parsed.reasonCode);
        if (['earn', 'meta', 'upgrade'].includes(parsed.kind)) return skip(parsed.kind === 'upgrade' ? 'unknownForm' : parsed.kind);

        let character = null;
        let subject = null;
        let unmet = null;
        const assumptions = [];
        if (parsed.kind === 'fight') {
            const resolved = resolveSubject(parsed.subject);
            if (resolved.type === 'unknown') return skip(resolved.reasonCode);
            if (resolved.type === 'character') {
                character = characterRef(resolved.id);
                subject = { type: 'character' };
                unmet = rosterKnown ? unmetRequirement(rosterById.get(resolved.id), parsed.requirements) : { code: 'rosterUnavailable' };
            } else if (resolved.type === 'any') {
                subject = { type: 'any' };
                const fits = [...rosterById.values()].some((rosterEntry) => !unmetRequirement(rosterEntry, parsed.requirements));
                if (!rosterKnown) unmet = { code: 'rosterUnavailable' };
                else if (!fits) unmet = { code: 'noCharacter', need: parsed.requirements };
            } else {
                subject = { type: 'trait', traitId: resolved.traitId, team: resolved.team };
                assumptions.push(HYPOTHESES.traitFightFullSquad);
                const have = [...rosterById.values()].filter((rosterEntry) => (charactersById.get(rosterEntry.id)?.traits || []).includes(resolved.traitId)
                    && !unmetRequirement(rosterEntry, parsed.requirements)).length;
                if (!rosterKnown) unmet = { code: 'rosterUnavailable' };
                else if (have < TRAIT_SQUAD_SIZE) unmet = { code: 'traitShort', have, need: TRAIT_SQUAD_SIZE, traitId: resolved.traitId };
            }
        } else if (parsed.kind === 'external') {
            unmet = { code: 'external', detail: parsed.reasonCode };
        }

        const isSpend = parsed.kind === 'spend' || parsed.kind === 'spendEnergy';
        // resource : dépense dont la faisabilité dépend des ressources (inconnues ici), hors points faisables
        const status = remaining === null || unmet?.code === 'rosterUnavailable' ? 'unknown' : remaining === 0 ? 'done' : isSpend ? 'resource' : unmet ? 'blocked' : 'doable';
        const doablePoints = status !== 'doable' ? 0
            : parsed.kind === 'login' ? Math.min(remaining, daysLeft * pointsPerAction) : remaining;
        // Dépenses : progression aussi en unités de la ressource (soFar arrondi en dessous, reste et plafond au-dessus)
        const units = isSpend && pointsPerAction > 0 && remaining !== null ? {
            soFarUnits: Math.floor(progressSoFar / pointsPerAction), capUnits: Math.ceil(cap / pointsPerAction), remainingUnits: Math.ceil(remaining / pointsPerAction)
        } : {};
        actions.push({
            index, kind: parsed.kind, mode: parsed.mode || null, modes: parsed.modes || [], label, labelEn, premium, character, subject, progressState: progressKnown && capKnown ? 'available' : 'unknown',
            requirements: parsed.requirements || {}, ...resourceFields(parsed.resource), pointsPerAction, cap, progress: progressSoFar, remaining, ...units,
            fightsLeft: remaining !== null && pointsPerAction > 0 && !isSpend ? Math.ceil((status === 'doable' ? doablePoints : remaining) / pointsPerAction) : null,
            doablePoints, status, reason: ['blocked', 'unknown'].includes(status) ? unmet : null,
            confidence: assumptions.length ? 'estimate' : 'sure', assumptions
        });
    });

    // Groupes : un combat fait avancer toutes les lignes faisables qu'il remplit (même personnage ou trait, même mode)
    const groupsByKey = new Map();
    actions.forEach((action) => {
        const key = action.character ? `${action.character.id}|${action.mode}`
            : action.subject?.type === 'trait' ? `trait:${action.subject.traitId}|${action.mode}` : `${action.kind}|${action.index}`;
        if (!groupsByKey.has(key)) {
            const rosterEntry = action.character && rosterById.get(action.character.id);
            const stats = rosterEntry ? Object.fromEntries(Object.entries(ROSTER_FIELDS).map(([code, field]) => [code, Number(rosterEntry[field]) || 0])) : null;
            groupsByKey.set(key, { key, kind: action.kind, mode: action.mode, character: action.character, stats, actions: [] });
        }
        groupsByKey.get(key).actions.push(action.index);
    });
    const actionByIndex = new Map(actions.map((action) => [action.index, action]));
    const groups = [...groupsByKey.values()].map((group) => {
        const doable = group.actions.map((index) => actionByIndex.get(index)).filter((action) => action.status === 'doable');
        return {
            ...group,
            status: doable.length ? 'doable' : group.actions.some((index) => actionByIndex.get(index).status === 'unknown') ? 'unknown'
                : group.actions.every((index) => actionByIndex.get(index).status === 'done') ? 'done'
                : group.actions.some((index) => actionByIndex.get(index).status === 'resource') ? 'resource' : 'blocked',
            nextFightValue: doable.reduce((total, action) => total + action.pointsPerAction, 0),
            fightsLeft: doable.length ? Math.max(...doable.map((action) => action.fightsLeft || 0)) : 0,
            doablePoints: doable.reduce((total, action) => total + action.doablePoints, 0)
        };
    }).sort((a, b) => (b.nextFightValue - a.nextFightValue) || (b.doablePoints - a.doablePoints));

    // --- Paliers ---
    const frTiers = frObjective.tiers || {};
    const tiers = Object.entries(objective.tiers || {})
        .map(([key, tier]) => ({ tier: Number(key) + offset, goal: Number(tier.goal) || 0, rewards: tierRewards(frTiers[key] || tier) }))
        .sort((a, b) => a.tier - b.tier);
    const tierFor = (total) => tiers.filter((tier) => tier.goal <= total).reduce((best, tier) => Math.max(best, tier.tier), 0);
    const nextTierAfter = (total) => tiers.find((tier) => tier.goal > total) || null;
    const doablePoints = actions.reduce((total, action) => total + action.doablePoints, 0);
    const projected = pointTotalKnown ? points + doablePoints : null;
    const next = pointTotalKnown ? nextTierAfter(points) : null;
    const afterReachable = pointTotalKnown ? nextTierAfter(projected) : null;

    // --- Sources sans plafond : leviers du roster, dépenses sans plafond, sources hors roster ---
    const uncapped = methods.map((method, index) => ({
        index, points: Number(method.points) || 0,
        label: cleanText(frScoring.methods?.[index]?.description || method.description),
        labelEn: cleanText(method.description),
        parsed: classifyObjective(method.description)
    }));
    uncapped.filter((method) => method.parsed.kind === 'unknown')
        .forEach((method) => unparsed.push({ source: 'uncapped', index: method.index, label: method.label, labelEn: method.labelEn, reason: method.parsed.reasonCode }));
    const thresholdOf = (parsed) => (parsed.target === 'iso' ? isoThreshold(parsed.isoTier, parsed.isoLevel) : parsed.threshold);
    // Niveau des personnages plafonné par le niveau de joueur maximal (110) : les seuils au-delà sont ignorés
    const thresholds = uncapped.filter((method) => method.parsed.kind === 'upgrade'
        && !(method.parsed.target === 'level' && method.parsed.threshold > MAX_PLAYER_LEVEL))
        .map((method) => ({ ...method, kind: method.parsed.target, threshold: thresholdOf(method.parsed) }));
    const levers = [];
    thresholds.forEach((method) => {
        const { kind, threshold } = method;
        const field = ROSTER_FIELDS[kind];
        let best = null;
        rosterById.forEach((rosterEntry, id) => {
            const current = rosterValue(kind, rosterEntry);
            if (current >= threshold || !charactersById.has(id)) return;
            // Toutes les sources du même type franchies entre la valeur actuelle et le seuil
            const crossed = thresholds
                .filter((other) => other.kind === kind && other.threshold > current && other.threshold <= threshold)
                .map((other) => ({ kind, threshold: other.threshold, points: other.points }));
            const uncappedPoints = crossed.reduce((total, other) => total + other.points, 0);
            // Actions plafonnées de ce personnage qui deviennent faisables (aucune action n'exige d'ISO)
            const upgraded = field ? { ...rosterEntry, [field]: threshold } : rosterEntry;
            const unlockedActions = !field ? [] : actions
                .filter((action) => action.character?.id === id && action.status === 'blocked' && !unmetRequirement(upgraded, action.requirements))
                .map((action) => ({ index: action.index, points: action.remaining }));
            const unlockedCappedPoints = unlockedActions.reduce((total, action) => total + action.points, 0);
            const candidate = { kind, character: characterRef(id), from: current, to: threshold, steps: threshold - current, uncappedPoints, unlockedCappedPoints, crossed, unlockedActions };
            if (kind === 'iso') Object.assign(candidate, { fromIso: isoTierLevel(current), toIso: isoTierLevel(threshold) });
            if (!best || candidate.steps < best.steps || (candidate.steps === best.steps && candidate.uncappedPoints + candidate.unlockedCappedPoints > best.uncappedPoints + best.unlockedCappedPoints)) best = candidate;
        });
        if (best) {
            const gain = best.uncappedPoints + best.unlockedCappedPoints;
            levers.push({ ...best, gain, reachableTierAfter: tierFor(projected + gain), assumptions: kind === 'iso' ? [HYPOTHESES.isoLevelsPerTier] : [] });
        }
    });
    levers.sort((a, b) => (b.gain - a.gain) || (a.steps - b.steps));

    // Dépenses sans plafond : affichées avec les ressources, jamais additionnées (pas de plafond)
    const uncappedResources = uncapped.filter((method) => ['spend', 'spendEnergy'].includes(method.parsed.kind))
        .map(({ index, label, labelEn, points: pointsPerUnit, parsed }) => ({ index, label, labelEn, pointsPerUnit, ...resourceFields(parsed.resource) }));
    // Hors roster : achats, orbes, battle pass, gains, sous-événements, et formes liées au roster sans plafond (rares)
    const offRoster = uncapped.filter((method) => !['unknown', 'upgrade', 'spend', 'spendEnergy'].includes(method.parsed.kind))
        .map(({ label, points: methodPoints }) => ({ label, points: methodPoints }));

    const result = {
        supported: true,
        event: {
            id: eventEn.id, type: eventEn.type, milestoneType: milestone.type || null, endTime: Number(eventEn.endTime) || null, daysLeft,
            points, reportedActionPoints, progressState,
            completedTierKnown, claimableTiersKnown,
            currentTier: completedTierKnown ? progress.completedTier + offset : null,
            nextTier: next?.tier ?? null, toNextTier: next ? next.goal - points : null,
            doablePoints, resourcePoints: actions.filter((action) => action.status === 'resource' && action.remaining != null).reduce((total, action) => total + action.remaining, 0),
            reachableTier: pointTotalKnown ? tierFor(projected) : null, toTierAfterReachable: afterReachable ? afterReachable.goal - projected : null,
            claimableTiers: claimableTiersKnown ? progress.claimableTiers.map((tier) => Number(tier) + offset) : null,
            claimableTiersPremium: Array.isArray(progress.claimableTiersPremium) ? progress.claimableTiersPremium.map((tier) => Number(tier) + offset) : null
        },
        actions,
        groups,
        tiers,
        levers: levers.slice(0, MAX_LEVERS),
        uncappedResources,
        offRoster,
        unparsed
    };
    // Plan (étapes 2 et 3) : palier assuré, besoins des paliers suivants, limités par le stock connu ({ [ressource]: { value, source } })
    result.plan = pointTotalKnown ? msfEvents.planEvent(result, { now, stock })
        : { status: 'unavailable', reason: 'progress-unavailable', secure: null, steps: [] };
    return result;
}
