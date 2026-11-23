// Étape 3 : saisie souple, registre (déclaration, dépense mesurée, récompense comptée une fois), plan limité par le stock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { declareResource, estimateResource, observeEvent, parseQuantity, planEvent, refreshResource, resourcesInUse } from '../../public/event-planner/lib/index.js';

test('saisie souple : suffixes, espaces, séparateurs de milliers', () => {
    assert.deepEqual(parseQuantity('18,91 M'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('18.91M'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('18910000'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('18 910 000'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('18 910 000'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('18.910.000'), { value: 18_910_000 });
    assert.deepEqual(parseQuantity('250 K'), { value: 250_000 });
    assert.deepEqual(parseQuantity('250k'), { value: 250_000 });
    assert.deepEqual(parseQuantity('1,3 Md'), { value: 1_300_000_000 });
    assert.deepEqual(parseQuantity(0), { value: 0 });
    assert.equal(parseQuantity('').error, 'empty');
    assert.equal(parseQuantity('-5').error, 'invalid');
    assert.equal(parseQuantity('beaucoup').error, 'invalid');
    assert.equal(parseQuantity('1,5').error, 'invalid', 'pas de décimales sans suffixe');
    assert.equal(parseQuantity('1,2345 M').error, 'invalid', '3 décimales au plus');
});

// Événement de la liste du joueur (texte EN) : or plafonné à 1 pt/unité, noyaux à 1 000 pts/unité, paliers réclamés
const event = ({ id = 'fete', start = 100, gold = 0, cores = 0, completed = 0, claimable = [] } = {}) => ({
    id, startTime: start, endTime: start + 1_000_000,
    milestone: {
        scoring: {
            cappedScorings: [
                { cap: 500_000_000, soFar: gold, methods: [{ description: 'Spend Gold', points: 1 }] },
                { cap: 250_000_000, soFar: cores, methods: [{ description: 'Spend Power Cores', points: 1000 }] },
                { cap: 51, methods: [{ description: 'Log in', points: 3 }] }
            ],
            methods: [{ description: 'Spend 1 Tier 3 Level 1 Ion', points: 1 }]
        },
        brackets: [{ objective: { progress: { completedTier: completed, claimableTiers: claimable } } }]
    }
});
const REWARDS = { 1: [{ itemId: 'SC', quantity: 500_000 }], 2: [{ itemId: 'SC', quantity: 700_000 }, { itemId: 'HC', quantity: 50 }], 3: [{ itemId: 'SC', quantity: 900_000 }] };
const DECLARED_AT = 200_000;   // ms

test('relevé : compteurs des dépenses plafonnées, ressources demandées', () => {
    const observed = observeEvent(event({ gold: 10 }), REWARDS);
    assert.deepEqual(observed.counters.map((counter) => [counter.resource, counter.soFar, counter.pointsPerUnit]), [['GOLD', 10, 1], ['CORE', 0, 1000]]);
    assert.deepEqual(resourcesInUse([observed]), ['GOLD', 'CORE', 'ION_P3_L1']);
    assert.deepEqual(resourcesInUse([observed], ['fete']), []);
});

test('relevé incomplet : un compteur de dépense absent reste inconnu et ne devient pas zéro', () => {
    const observed = observeEvent({id:'unknown-counter',startTime:100,endTime:200,milestone:{
        scoring:{cappedScorings:[{cap:500,methods:[{description:'Spend Gold',points:1}]}]},brackets:[]
    }});
    assert.deepEqual(observed.counters, []);
    assert.deepEqual(observed.unknownCounters, [{key:'unknown-counter:0',resource:'GOLD'}]);
    assert.deepEqual(observed.uses, ['GOLD']);
});

test('registre : déclaration, puis dépense mesurée (plus grand delta en unités)', () => {
    const before = [observeEvent(event({ gold: 1_000_000, cores: 2_000_000 }), REWARDS), observeEvent(event({ id: 'bp', gold: 50 }), {})];
    const declared = declareResource({ resource: 'GOLD', value: 18_910_000, now: DECLARED_AT, observations: before });
    assert.deepEqual(estimateResource(declared), { value: 18_910_000, source: 'declared', spentSince: 0, earnedSince: 0, declaredAt: DECLARED_AT });
    // La Fête voit 2,1 M d'or dépensés, le Battle Pass 1,5 M (même dépense) : on prend le plus grand, jamais la somme
    const after = [observeEvent(event({ gold: 3_100_000, cores: 2_000_000 }), REWARDS), observeEvent(event({ id: 'bp', gold: 1_500_050 }), {})];
    const estimate = estimateResource(refreshResource(declared, 'GOLD', after));
    assert.equal(estimate.spentSince, 2_100_000);
    assert.equal(estimate.value, 16_810_000);
    assert.equal(estimate.source, 'estimated');
    // Noyaux : delta en unités (points ÷ 1 000)
    const cores = declareResource({ resource: 'CORE', value: 5000, now: DECLARED_AT, observations: before });
    assert.equal(estimateResource(refreshResource(cores, 'CORE', after.map((observed, index) => (index === 0 ? observeEvent(event({ cores: 2_425_000 }), REWARDS) : observed)))).spentSince, 425);
});

test('registre : compteur plafonné sur la période écarté, événement terminé garde sa mesure, nouvel événement part de 0', () => {
    const declared = declareResource({ resource: 'GOLD', value: 1000, now: DECLARED_AT, observations: [observeEvent(event({ id: 'a', gold: 499_999_000 }), {})] });
    const capped = refreshResource(declared, 'GOLD', [observeEvent(event({ id: 'a', gold: 500_000_000 }), {})]);
    assert.equal(estimateResource(capped).spentSince, 0, 'plafond atteint : delta non fiable');
    const fresh = refreshResource(declared, 'GOLD', [observeEvent(event({ id: 'b', start: 300, gold: 400 }), {})]);
    assert.equal(estimateResource(fresh).spentSince, 400, 'commencé après la déclaration : base 0');
    const gone = refreshResource(fresh, 'GOLD', []);
    assert.equal(estimateResource(gone).spentSince, 400, 'événement disparu : dernière mesure gardée');
});

test('registre : récompense d’un palier réclamé comptée une seule fois ; paliers réclamés avant la déclaration ignorés', () => {
    const declared = declareResource({ resource: 'GOLD', value: 1_000_000, now: DECLARED_AT, observations: [observeEvent(event({ completed: 1 }), REWARDS)] });
    // Palier 2 atteint mais pas encore réclamé : rien
    const pending = refreshResource(declared, 'GOLD', [observeEvent(event({ completed: 2, claimable: [2] }), REWARDS)]);
    assert.equal(estimateResource(pending).earnedSince, 0);
    // Palier 2 réclamé : +700 000 ; nouvelle visite : toujours 700 000
    const claimed = refreshResource(pending, 'GOLD', [observeEvent(event({ completed: 2 }), REWARDS)]);
    const again = refreshResource(claimed, 'GOLD', [observeEvent(event({ completed: 2 }), REWARDS)]);
    assert.equal(estimateResource(again).earnedSince, 700_000);
    assert.equal(estimateResource(again).value, 1_700_000);
    // Noyaux du palier 2 : comptés pour la ressource CORE seulement
    const cores = declareResource({ resource: 'CORE', value: 0, now: DECLARED_AT, observations: [observeEvent(event({ completed: 1 }), REWARDS)] });
    assert.equal(estimateResource(refreshResource(cores, 'CORE', [observeEvent(event({ completed: 3 }), REWARDS)])).earnedSince, 50);
});

// Analyse minimale : or 1 pt/unité, modules 5 000 pts/unité, ions 1 pt/unité, noyaux 1 000 pts/unité
const DAY = 86400;
const NOW = 1_800_000_000;
const spend = (index, resource, pointsPerAction, remaining) => ({ index, kind: 'spend', status: 'resource', resource, pointsPerAction, remaining, doablePoints: 0 });
const analysis = {
    event: { points: 0, currentTier: 0, endTime: NOW + 13 * DAY },
    tiers: [{ tier: 1, goal: 21_481_990 }, { tier: 2, goal: 46_481_990 }],
    actions: [spend(0, 'GOLD', 1, 400_000_000), spend(1, 'TRAINING_MODULE_L4', 5000, 400_000_000), spend(2, 'ION_P2_L1', 1, 49_000_000), spend(3, 'CORE', 1000, 200_000_000)],
    levers: [], uncappedResources: []
};

test('plan avec stock : 18,91 M d’or déclaré, modules à 0 (inventaire) → il te manque, en or, alternatives annotées', () => {
    const plan = planEvent(analysis, { now: NOW, stock: { GOLD: { value: 18_910_000, source: 'declared' }, TRAINING_MODULE_L4: { value: 0, source: 'api' } } });
    const [step] = plan.steps;
    assert.equal(step.verdict, 'short');
    assert.deepEqual(step.spends.map((item) => [item.resource, item.units, item.fromStock]), [['GOLD', 18_910_000, true]]);
    assert.deepEqual(step.shortfall.map((item) => [item.resource, item.units]), [['GOLD', 2_571_990]]);
    assert.deepEqual(step.alternatives.map((item) => [item.resources[0], item.units, item.stock]), [
        ['TRAINING_MODULE_L4', 515, { value: 0, source: 'api' }], ['ION_P2_L1', 2_571_990, null], ['CORE', 2572, null]
    ]);
});

test('plan avec stock : ressource déjà prise dans ton stock → alternative « de plus », stock restant après cette part', () => {
    const plan = planEvent(analysis, { now: NOW, stock: { GOLD: { value: 18_910_000, source: 'declared' }, TRAINING_MODULE_L4: { value: 40, source: 'api' }, CORE: { value: 30_000, source: 'declared' } } });
    const [step] = plan.steps;
    assert.deepEqual(step.spends.map((item) => [item.resource, item.units]), [['GOLD', 18_910_000], ['TRAINING_MODULE_L4', 40]]);
    assert.deepEqual(step.shortfall.map((item) => [item.resource, item.units]), [['GOLD', 2_371_990]]);
    assert.deepEqual(step.alternatives.map((item) => [item.resources[0], item.units, item.stock, item.extra]), [
        ['TRAINING_MODULE_L4', 475, { value: 0, source: 'api' }, true], ['ION_P2_L1', 2_371_990, null, false], ['CORE', 2372, { value: 30_000, source: 'declared' }, false]
    ]);
});

test('plan avec stock : faisable, et bascule sur la ressource suivante quand le stock préféré est épuisé', () => {
    const feasible = planEvent(analysis, { now: NOW, stock: { GOLD: { value: 50_000_000, source: 'declared' } } });
    assert.deepEqual(feasible.steps.map((step) => step.verdict), ['feasible', 'feasible']);
    assert.deepEqual(feasible.steps[1].spends.map((item) => [item.resource, item.units]), [['GOLD', 46_481_990]]);
    const switched = planEvent(analysis, { now: NOW, stock: { GOLD: { value: 20_000_000, source: 'declared' }, TRAINING_MODULE_L4: { value: 1000, source: 'api' } } });
    // Palier 1 : 20 M d'or puis 1 481 990 pts en modules = 297 modules (stock 1 000) → faisable
    assert.equal(switched.steps[0].verdict, 'feasible');
    assert.deepEqual(switched.steps[0].spends.map((item) => [item.resource, item.units]), [['GOLD', 20_000_000], ['TRAINING_MODULE_L4', 297]]);
    // Palier 2 : 20 M d'or + 1 000 modules (5 M) → il manque 21 481 990 pts, en or
    assert.equal(switched.steps[1].verdict, 'short');
    assert.deepEqual(switched.steps[1].shortfall.map((item) => [item.resource, item.units]), [['GOLD', 21_481_990]]);
});

test('plan avec stock : or non déclaré → besoin (comportement sans stock), stock des autres indiqué en alternative', () => {
    const plan = planEvent(analysis, { now: NOW, stock: { CORE: { value: 30_000, source: 'declared' } } });
    const [step] = plan.steps;
    assert.equal(step.verdict, 'need');
    assert.deepEqual(step.spends, []);
    assert.deepEqual(step.shortfall.map((item) => [item.resource, item.units]), [['GOLD', 21_481_990]]);
    assert.deepEqual(step.alternatives.find((item) => item.resources[0] === 'CORE').stock, { value: 30_000, source: 'declared' });
    // Sans aucun stock : même résultat qu'à l'étape 2
    assert.equal(planEvent(analysis, { now: NOW }).steps[0].verdict, 'need');
});
