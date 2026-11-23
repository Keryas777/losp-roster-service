// Plan sans stock : palier assuré, leviers d'abord, ordre de préférence avec bascule au plafond, lignes cumulées,
// alternatives, reste non couvrable, lissage jusqu'à la veille de la fin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDays, planEvent, unitsFor } from '../../public/event-planner/lib/index.js';

const DAY = 86400;
const NOW = 1_800_000_000;
const tiers = (...goals) => goals.map((goal, index) => ({ tier: index + 1, goal }));
const spend = (index, resource, pointsPerAction, remaining) => ({ index, kind: 'spend', status: 'resource', resource, pointsPerAction, remaining, doablePoints: 0 });
const base = (overrides = {}) => ({
    event: { points: 100, currentTier: 1, endTime: NOW + 10 * DAY + 3600 },
    actions: [], tiers: tiers(100, 200, 300, 400, 500, 600), levers: [], uncappedResources: [],
    ...overrides
});

test('palier assuré : actuels + faisables (combats, connexion) + énergies du jour', () => {
    const plan = planEvent(base({
        actions: [
            { index: 0, kind: 'login', status: 'doable', doablePoints: 50 },
            { index: 1, kind: 'fight', status: 'doable', doablePoints: 30 },
            { index: 2, kind: 'spendEnergy', status: 'resource', resource: 'ENERGY_PREHISTORIC', pointsPerAction: 1, remaining: 40, doablePoints: 0 },
            { index: 3, kind: 'fight', status: 'blocked', doablePoints: 0, remaining: 500 }
        ]
    }), { now: NOW });
    assert.deepEqual(plan.secure, { points: 220, tier: 2, fromDoable: 80, fromEnergy: 40 });
    assert.deepEqual(plan.steps.map((step) => [step.tier, step.missing]), [[3, 80], [4, 180], [5, 280]]);
});

test('ordre de préférence : or d’abord, bascule sur les modules quand le plafond d’or est atteint', () => {
    const plan = planEvent(base({ actions: [spend(0, 'CORE', 1000, 1_000_000), spend(1, 'GOLD', 1, 150), spend(2, 'TRAINING_MODULE_L4', 50, 10_000)] }), { now: NOW });
    const [toTier2, , toTier4] = plan.steps;
    assert.deepEqual(toTier2.shortfall.map((item) => [item.resource, item.units, item.capReached]), [['GOLD', 100, false]]);
    // Palier 4 : 300 pts ; or plafonné à 150, puis 150 pts en modules à 50 pts = 3 modules
    assert.deepEqual(toTier4.shortfall.map((item) => [item.resource, item.units, item.points, item.capReached]), [['GOLD', 150, 150, true], ['TRAINING_MODULE_L4', 3, 150, false]]);
    assert.equal(toTier4.uncovered, 0);
});

test('alternatives : autres ressources qui couvriraient seules le même manque, dans la limite de leur plafond', () => {
    const plan = planEvent(base({ actions: [spend(0, 'GOLD', 1, 1_000_000), spend(1, 'TRAINING_MODULE_L4', 5000, 300_000), spend(2, 'CORE', 1000, 50_000)] }), { now: NOW });
    const step = plan.steps[0];
    assert.deepEqual(step.shortfall.map((item) => [item.resource, item.units]), [['GOLD', 100]]);
    assert.deepEqual(step.alternatives.map((item) => [item.resources, item.units]), [[['TRAINING_MODULE_L4'], 1], [['CORE'], 1]]);
    const far = planEvent(base({ tiers: tiers(100, 200_000), actions: [spend(0, 'GOLD', 1, 1_000_000), spend(2, 'CORE', 1000, 50_000)] }), { now: NOW });
    assert.deepEqual(far.steps[0].alternatives, [], 'noyaux plafonnés à 50 000 pts : pas une alternative pour 199 900');
});

test('ions en alternative : une seule ligne, toutes sortes confondues', () => {
    const plan = planEvent(base({ actions: [spend(0, 'GOLD', 1, 1000), spend(1, 'ION_P2_L1', 1, 1000), spend(2, 'CORE', 10, 1000), spend(3, 'ION_P3_L4', 2, 1000)] }), { now: NOW });
    assert.deepEqual(plan.steps[0].alternatives, [
        { resources: ['ION_P2_L1', 'ION_P3_L4'], units: 50, perDay: 5, resourceLabel: 'ions (toutes sortes confondues)', stock: null, extra: false },
        { resources: ['CORE'], units: 10, perDay: 1, resourceLabel: 'noyaux d’énergie', stock: null, extra: false }
    ]);
});

test('affichage : plan complet, dernier palier assuré, palier suivant bloqué', () => {
    assert.equal(planEvent(base({ actions: [spend(0, 'GOLD', 1, 1000)] }), { now: NOW }).display, 'full');
    assert.equal(planEvent(base({ event: { points: 600, currentTier: 6, endTime: NOW + DAY * 5 } }), { now: NOW }).display, 'lastTierSecured');
    assert.equal(planEvent(base(), { now: NOW }).display, 'nextTierBlocked');
});

test('lignes d’une même ressource : une unité crédite toutes les lignes non plafonnées', () => {
    // 2 lignes d'or : 1 pt/unité plafonnée à 10, et 1 pt/unité plafonnée à 600 → 2 pts par unité jusqu'à 10 unités
    const lines = [{ pointsPerUnit: 1, remaining: 10 }, { pointsPerUnit: 1, remaining: 600 }];
    assert.equal(unitsFor(lines, 20), 10);
    assert.equal(unitsFor(lines, 30), 20);
    assert.equal(unitsFor(lines, 611), null);
    const plan = planEvent(base({ actions: [spend(0, 'GOLD', 1, 10), spend(1, 'GOLD', 1, 600)] }), { now: NOW });
    assert.deepEqual(plan.steps[0].shortfall[0].assumptions, ['shared-spend']);
    // Palier 2 (100 pts) : 10 unités à 2 pts, puis 80 à 1 pt
    assert.equal(plan.steps[0].shortfall[0].units, 90);
});

test('dépense sans plafond : utilisable sans limite à son rang', () => {
    const plan = planEvent(base({ uncappedResources: [{ index: 0, resource: 'ION_P3_L1', pointsPerUnit: 1 }] }), { now: NOW });
    assert.deepEqual(plan.steps[2].shortfall.map((item) => [item.resource, item.units, item.capReached]), [['ION_P3_L1', 300, false]]);
});

test('reste non couvrable quand tous les plafonds sont atteints', () => {
    const plan = planEvent(base({ actions: [spend(0, 'GOLD', 1, 120), spend(1, 'CORE', 10, 50)] }), { now: NOW });
    const step = plan.steps[1];
    assert.deepEqual(step.shortfall.map((item) => [item.resource, item.capReached]), [['GOLD', true], ['CORE', true]]);
    assert.equal(step.uncovered, 30);
});

test('leviers d’abord, sans compter deux fois un seuil ; palier couvert par les leviers', () => {
    const levers = [
        { kind: 'iso', character: { id: 'A' }, gain: 80, crossed: [{ kind: 'iso', threshold: 15, points: 30 }, { kind: 'iso', threshold: 18, points: 50 }], unlockedActions: [], assumptions: ['iso-levels-per-tier'] },
        { kind: 'iso', character: { id: 'B' }, gain: 30, crossed: [{ kind: 'iso', threshold: 15, points: 30 }], unlockedActions: [], assumptions: ['iso-levels-per-tier'] },
        { kind: 'gearTier', character: { id: 'C' }, gain: 40, crossed: [{ kind: 'gearTier', threshold: 21, points: 40 }], unlockedActions: [], assumptions: [] }
    ];
    const plan = planEvent(base({ levers, actions: [spend(0, 'GOLD', 1, 10_000)] }), { now: NOW });
    const [toTier2, toTier3] = plan.steps;
    assert.equal(toTier2.coveredByLevers, true);
    assert.equal(toTier2.leverPoints, 120, 'A (80) ne suffit pas pour 100 : C (40) s’ajoute, B ne rapporte rien');
    assert.deepEqual(toTier2.shortfall, []);
    // Palier 3 : 200 pts ; leviers A (80) + C (40), B ne rapporte rien de plus (seuil 15 déjà compté)
    assert.equal(toTier3.leverPoints, 120);
    assert.deepEqual(toTier3.shortfall.map((item) => [item.resource, item.units]), [['GOLD', 80]]);
    assert.deepEqual(plan.levers.map((lever) => [lever.character.id, lever.points]), [['A', 80], ['C', 40]]);
});

test('lissage jusqu’à la veille de la fin (J-1), au moins 1 jour', () => {
    assert.equal(planDays(NOW + 10 * DAY + 3600, NOW), 10);
    assert.equal(planDays(NOW + 3 * DAY, NOW), 2);
    assert.equal(planDays(NOW + 12 * 3600, NOW), 1);
    assert.equal(planEvent(base({ event: { points: 100, currentTier: 1, endTime: NOW + 12 * 3600 } }), { now: NOW }).lastDay, true);
    assert.equal(planEvent(base(), { now: NOW }).lastDay, false);
    const plan = planEvent(base({ actions: [spend(0, 'GOLD', 1, 10_000)] }), { now: NOW });
    assert.equal(plan.planDays, 10);
    assert.equal(plan.eveTime, plan.endTime - DAY);
    assert.deepEqual(plan.steps.map((step) => step.shortfall[0].perDay), [10, 20, 30]);
});

test('moins de 3 paliers près du dernier ; aucun au-delà du dernier', () => {
    assert.equal(planEvent(base({ event: { points: 450, currentTier: 4, endTime: NOW + DAY * 5 } }), { now: NOW }).steps.length, 2);
    assert.deepEqual(planEvent(base({ event: { points: 600, currentTier: 6, endTime: NOW + DAY * 5 } }), { now: NOW }).steps, []);
});
