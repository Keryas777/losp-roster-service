import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIsoCrystalMatrix, parseIsoCrystalId } from '../../public/event-planner/lib/iso-crystals.js';

test('parses the observed ISOITEM example and marks other valid combinations as derived', () => {
  assert.deepEqual(parseIsoCrystalId('ISOITEM_GREEN_SUPPORT_HEALTH_1'), {
    status: 'observed-example',
    id: 'ISOITEM_GREEN_SUPPORT_HEALTH_1',
    tier: 'P1',
    color: 'green',
    characterClass: 'Soutien',
    characterClassCode: 'SUPPORT',
    category: 'Vie',
    categoryCode: 'HEALTH',
    level: 1
  });
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_FOCUS_5').status, 'nomenclature-derived');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_FOCUS_6').reason, 'level');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_UNKNOWN_FOCUS_1').reason, 'character-class');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_UNKNOWN_1').reason, 'category');
});

test('builds the owner supplied P4 level 1 synthetic matrix totaling 117 crystals', () => {
  const items = [
    { id: 'ISOITEM_ORANGE_BLASTER_HEALTH_1', quantity: 16 },
    { id: 'ISOITEM_ORANGE_BLASTER_DAMAGE_1', quantity: 26 },
    { id: 'ISOITEM_ORANGE_BLASTER_ARMOR_1', quantity: 17 },
    { id: 'ISOITEM_ORANGE_BLASTER_FOCUS_1', quantity: 42 },
    { id: 'ISOITEM_ORANGE_BLASTER_RESIST_1', quantity: 16 }
  ];
  const matrix = buildIsoCrystalMatrix(items, 'P4', 1);
  const row = matrix.cells.Tireur;
  assert.deepEqual(matrix.classes, ['Cogneur','Tireur','Contrôleur','Protecteur','Soutien']);
  assert.deepEqual(matrix.categories, ['Vie','Dégâts','Armure','Focalisation','Résistance']);
  assert.deepEqual([
    row.Vie.quantity, row['Dégâts'].quantity, row.Armure.quantity,
    row.Focalisation.quantity, row.Résistance.quantity
  ], [16,26,17,42,16]);
  assert.equal([row.Vie,row['Dégâts'],row.Armure,row.Focalisation,row.Résistance]
    .reduce((sum, cell) => sum + cell.quantity, 0), 117);
  assert.equal(matrix.cells.Cogneur.Vie.state, 'unknown');
});

test('distinguishes explicit zero from missing and avoids duplicate double counting', () => {
  const matrix = buildIsoCrystalMatrix([
    { id: 'ISOITEM_GREEN_BRAWLER_HEALTH_1', quantity: 0 },
    { id: 'ISOITEM_GREEN_BRAWLER_HEALTH_1', quantity: 0 },
    { id: 'ISOITEM_GREEN_BRAWLER_DAMAGE_1', quantity: 3 },
    { id: 'ISOITEM_GREEN_BRAWLER_DAMAGE_1', quantity: 4 },
    { id: 'ISOITEM_GREEN_SUPPORT_HEALTH_1', quantity: 'unknown' },
    { id: 'ISOITEM_GREEN_UNKNOWN_HEALTH_1', quantity: 12 }
  ], 'P1', 1);
  assert.deepEqual(matrix.cells.Cogneur.Vie, {
    state: 'known', quantity: 0, ids: ['ISOITEM_GREEN_BRAWLER_HEALTH_1']
  });
  assert.equal(matrix.cells.Cogneur['Dégâts'].state, 'unknown');
  assert.equal(matrix.cells.Soutien.Vie.state, 'unknown');
  assert.deepEqual(matrix.unknownIds, ['ISOITEM_GREEN_UNKNOWN_HEALTH_1']);
});

test('normalizes numeric-string quantities and case-insensitive duplicate IDs without double counting', () => {
  const matrix = buildIsoCrystalMatrix([
    { id: 'ISOITEM_GREEN_BRAWLER_HEALTH_1', quantity: '7' },
    { id: 'isoitem_green_brawler_health_1', quantity: 7 },
    { id: 'ISOITEM_GREEN_BRAWLER_DAMAGE_1', quantity: '3' }
  ], 'P1', 1);
  assert.equal(matrix.cells.Cogneur.Vie.quantity, 7);
  assert.deepEqual(matrix.cells.Cogneur.Vie.ids, ['ISOITEM_GREEN_BRAWLER_HEALTH_1']);
  assert.equal(matrix.cells.Cogneur['Dégâts'].quantity, 3);
  assert.deepEqual(matrix.conflictingIds, []);
});


test('eligibility requires five known positive crystal categories and stays separate from assigned class level and cost', () => {
  const { evaluateIsoClassEligibility } = await import('../../public/event-planner/lib/iso-crystals.js');
  const items = ['HEALTH','DAMAGE','ARMOR','FOCUS','RESIST'].map((category, i) => ({
    id: `ISOITEM_ORANGE_BLASTER_${category}_1`, quantity: i + 1
  }));
  const eligible = evaluateIsoClassEligibility(items, 'BLASTER', 'P4', 1, { active: 'raider', raider: 10 });
  assert.equal(eligible.status, 'eligible');
  assert.equal(eligible.eligibleCombatIsoLevel, 16);
  assert.equal(eligible.assignedCombatIsoClass, 'raider');
  assert.equal(eligible.assignedCombatIsoLevel, 10);
  assert.equal(eligible.costs, null);
  const missing = evaluateIsoClassEligibility(items.slice(0, 4), 'BLASTER', 'P4', 1);
  assert.equal(missing.status, 'unknown');
  const zero = evaluateIsoClassEligibility(items.map((item, i) => i ? item : { ...item, quantity: 0 }), 'BLASTER', 'P4', 1);
  assert.equal(zero.status, 'ineligible');
});
