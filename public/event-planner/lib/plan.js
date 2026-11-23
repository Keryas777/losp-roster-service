// Plan sans stock d'un événement à jalons (MSF.md §7.6, étape 2) : palier assuré par les actions sans coût de stock,
// puis, pour les paliers suivants, leviers du roster d'abord et dépenses dans l'ordre de préférence des ressources.
// Sans stock connu, les dépenses sont des besoins, pas des recommandations. Entrée : la sortie de l'analyse d'un événement.
import { RESOURCES, isIon } from './classify.js';

const DAY_SECONDS = 24 * 3600;
const NEXT_TIERS = 3;
const SHARED_SPEND = 'shared-spend';

const tierFor = (tiers, total) => tiers.filter((tier) => tier.goal <= total).reduce((best, tier) => Math.max(best, tier.tier), 0);

// Jours de plan : jusqu'à la veille de la fin (un jour de marge), au moins 1
export const planDays = (endTime, now) => Math.max(1, Math.ceil((endTime - DAY_SECONDS - now) / DAY_SECONDS));

// Points obtenus en dépensant `units` : une unité crédite toutes les lignes non plafonnées de la ressource
const pointsFor = (lines, units) => lines.reduce((total, line) => total + Math.min(units * line.pointsPerUnit, line.remaining), 0);
const capacityOf = (lines) => lines.reduce((total, line) => total + line.remaining, 0);

// Plus petit nombre d'unités qui rapporte au moins `target` points ; null si les plafonds ne le permettent pas
export function unitsFor(lines, target) {
    if (target <= 0) return 0;
    if (capacityOf(lines) < target) return null;
    let active = lines.filter((line) => line.remaining > 0)
        .map((line) => ({ ...line, capUnits: line.remaining / line.pointsPerUnit }))
        .sort((a, b) => a.capUnits - b.capUnits);
    let units = 0;
    let points = 0;
    while (active.length) {
        const rate = active.reduce((total, line) => total + line.pointsPerUnit, 0);
        const nextUnits = active[0].capUnits;
        if (points + (nextUnits - units) * rate >= target) {
            const needed = Math.ceil(units + (target - points) / rate - 1e-9);
            return pointsFor(lines, needed) >= target ? needed : needed + 1;
        }
        points += (nextUnits - units) * rate;
        units = nextUnits;
        active = active.filter((line) => line.capUnits > nextUnits);
    }
    return null;
}

// Lignes de dépense de stock regroupées par ressource, dans l'ordre de préférence (puis d'apparition)
function spendGroups(analysis) {
    const groups = new Map();
    const add = (resource, line) => {
        const meta = RESOURCES[resource];
        if (!meta || meta.nature !== 'stock' || meta.preference == null || line.remaining <= 0) return;
        if (!groups.has(resource)) groups.set(resource, { resource, label: meta.label?.fr || resource, preference: meta.preference, order: groups.size, lines: [] });
        groups.get(resource).lines.push(line);
    };
    analysis.actions.filter((action) => action.status === 'resource' && action.kind === 'spend' && action.pointsPerAction > 0)
        .forEach((action) => add(action.resource, { index: action.index, pointsPerUnit: action.pointsPerAction, remaining: action.remaining }));
    (analysis.uncappedResources || []).filter((source) => source.pointsPerUnit > 0)
        .forEach((source) => add(source.resource, { index: `u${source.index}`, pointsPerUnit: source.pointsPerUnit, remaining: Infinity }));
    return [...groups.values()].sort((a, b) => (a.preference - b.preference) || (a.order - b.order));
}

// Leviers pris par gain décroissant ; un seuil franchi ou une action débloquée n'est compté qu'une fois
function leverGains(levers) {
    const counted = new Set();
    return levers.map((lever) => {
        const parts = [...(lever.crossed || []).map((item) => [`${item.kind}:${item.threshold}`, item.points]),
            ...(lever.unlockedActions || []).map((item) => [`action:${item.index}`, item.points])];
        const points = parts.filter(([key]) => !counted.has(key)).reduce((total, [, value]) => total + value, 0);
        parts.forEach(([key]) => counted.add(key));
        return { lever, points };
    }).filter((item) => item.points > 0);
}

// Alternatives : toutes les sortes d'ions en une seule ligne (le moins d'unités), à la place de la première sorte
const ION_ALTERNATIVE_LABEL = 'ions (toutes sortes confondues)';
function groupAlternatives(alternatives) {
    const ions = alternatives.filter((alternative) => isIon(alternative.resource));
    const merged = alternatives.filter((alternative) => !isIon(alternative.resource))
        .map(({ resource, resourceLabel, units, perDay, stock, extra }) => ({ resources: [resource], units, perDay, resourceLabel, stock: stock || null, extra }));
    if (ions.length) {
        const best = ions.reduce((min, alternative) => (alternative.units < min.units ? alternative : min));
        // Stock restant des ions : somme des sortes déclarées (null si aucune) ; « de plus » si une sorte est déjà prise
        const known = ions.filter((alternative) => alternative.stock);
        const stock = known.length ? { value: known.reduce((total, alternative) => total + alternative.stock.value, 0), source: known.length === ions.length ? 'declared' : 'partial' } : null;
        const ionEntry = { resources: ions.map((alternative) => alternative.resource), units: best.units, perDay: best.perDay, resourceLabel: ions.length > 1 ? ION_ALTERNATIVE_LABEL : best.resourceLabel, stock, extra: ions.some((alternative) => alternative.extra) };
        const position = alternatives.findIndex((alternative) => isIon(alternative.resource));
        merged.splice(alternatives.slice(0, position).filter((alternative) => !isIon(alternative.resource)).length, 0, ionEntry);
    }
    return merged;
}

/**
 * Plan d'un événement analysé : { endTime, eveTime, planDays, secure, levers, steps }.
 * secure : points actuels + actions sans coût de stock (combats, modes, connexion, énergies du jour).
 * steps : les 3 paliers suivants, chacun depuis le palier assuré : manque, points des leviers, dépenses dans l'ordre
 * de préférence (complément si plafond atteint), alternatives qui couvriraient seules le même manque, reste non couvrable.
 */
export function planEvent(analysis, { now = Math.floor(Date.now() / 1000), stock = null } = {}) {
    const { event, actions, tiers } = analysis;
    const endTime = Number(event.endTime) || null;
    const days = endTime ? planDays(endTime, now) : 1;
    const fromDoable = actions.reduce((total, action) => total + (action.doablePoints || 0), 0);
    const fromEnergy = actions.filter((action) => action.status === 'resource' && action.kind === 'spendEnergy').reduce((total, action) => total + action.remaining, 0);
    const securePoints = event.points + fromDoable + fromEnergy;
    const secure = { points: securePoints, tier: Math.max(event.currentTier, tierFor(tiers, securePoints)), fromDoable, fromEnergy };

    const gains = leverGains(analysis.levers || []);
    const groups = spendGroups(analysis);
    const perDay = (units) => Math.ceil(units / days);
    // Stock connu d'une ressource ({ value, source }), ou null si non déclaré
    const stockOf = (resource) => (stock?.[resource] && stock[resource].value != null ? stock[resource] : null);
    const assumptionsOf = (group) => (group.lines.length > 1 ? [SHARED_SPEND] : []);
    const usedLevers = new Set();

    const steps = tiers.filter((tier) => tier.goal > securePoints).slice(0, NEXT_TIERS).map((tier) => {
        const missing = tier.goal - securePoints;
        let leverPoints = 0;
        gains.forEach((item) => {
            if (leverPoints >= missing) return;
            leverPoints += item.points;
            usedLevers.add(item.lever);
        });
        const manque = Math.max(0, missing - leverPoints);
        const base = { tier: tier.tier, goal: tier.goal, missing, leverPoints, coveredByLevers: manque === 0 };
        if (manque === 0) return { ...base, verdict: null, spends: [], shortfall: [], alternatives: [], uncovered: 0 };

        // 1. Stock déclaré consommé dans l'ordre de préférence, jusqu'à la première ressource sans stock déclaré
        const used = new Map();
        const spends = [];
        let rest = manque;
        const firstUndeclared = groups.findIndex((group) => !stockOf(group.resource));
        groups.slice(0, firstUndeclared === -1 ? groups.length : firstUndeclared).forEach((group) => {
            if (rest <= 0) return;
            const take = Math.min(rest, pointsFor(group.lines, stockOf(group.resource).value));
            const units = unitsFor(group.lines, take);
            if (!units) return;
            used.set(group.resource, units);
            spends.push({ resource: group.resource, resourceLabel: group.label, units, points: pointsFor(group.lines, units), fromStock: true, assumptions: assumptionsOf(group) });
            rest -= take;
        });
        // Aucun stock pour la ressource préférée : besoin, pas recommandation (comportement sans stock)
        const verdict = rest <= 0 ? 'feasible' : firstUndeclared === 0 ? 'need' : 'short';

        // 2. Reste : dans la ressource la mieux placée qui a encore de la place sous son plafond, puis les suivantes
        const usedPoints = (group) => pointsFor(group.lines, used.get(group.resource) || 0);
        const extraUnits = (group, points) => {
            const total = unitsFor(group.lines, usedPoints(group) + points);
            return total == null ? null : total - (used.get(group.resource) || 0);
        };
        const shortfall = [];
        let open = rest;
        groups.forEach((group) => {
            if (open <= 0) return;
            const room = capacityOf(group.lines) - usedPoints(group);
            if (room <= 0) return;
            const take = Math.min(open, room);
            const units = extraUnits(group, take);
            shortfall.push({ resource: group.resource, resourceLabel: group.label, units, points: take, perDay: perDay(units), capReached: room <= open, assumptions: assumptionsOf(group) });
            open -= take;
        });
        const first = shortfall[0]?.resource;
        // Alternatives : unités en plus de la part déjà prise dans ton stock (extra), stock restant après cette part
        const remainingStock = (resource) => {
            const known = stockOf(resource);
            return known && { ...known, value: Math.max(0, known.value - (used.get(resource) || 0)) };
        };
        const alternatives = rest > 0 ? groupAlternatives(groups.filter((group) => group.resource !== first)
            .map((group) => ({ group, units: extraUnits(group, rest) }))
            .filter(({ units }) => units != null)
            .map(({ group, units }) => ({ resource: group.resource, resourceLabel: group.label, units, perDay: perDay(units), stock: remainingStock(group.resource), extra: used.has(group.resource) }))) : [];
        return { ...base, verdict, spends, shortfall, alternatives, uncovered: Math.max(0, open) };
    });

    const levers = gains.filter((item) => usedLevers.has(item.lever)).map(({ lever, points }) => ({
        kind: lever.kind, character: lever.character, from: lever.from, to: lever.to, fromIso: lever.fromIso || null, toIso: lever.toIso || null,
        points, assumptions: lever.assumptions || []
    }));
    // lastDay : la veille de la fin est passée, tout se joue avant la fin
    const eveTime = endTime ? endTime - DAY_SECONDS : null;
    // display : plan complet seulement si un palier a au moins un levier ou une dépense ; sinon une ligne
    const display = steps.length === 0 ? 'lastTierSecured'
        : steps.some((step) => step.leverPoints > 0 || step.spends.length > 0 || step.shortfall.length > 0) ? 'full' : 'nextTierBlocked';
    return { endTime, eveTime, lastDay: eveTime != null && eveTime <= now, planDays: days, display, secure, levers, steps };
}
