import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIsoCrystalMatrix, evaluateIsoClassEligibility, parseIsoCrystalId } from '../../public/event-planner/lib/iso-crystals.js';

test('parses the observed ISOITEM example and marks other valid combinations as derived', () => {
  assert.deepEqual(parseIsoCrystalId('ISOITEM_GREEN_SUPPORT_HEALTH_1'), {
    status: 'observed-example',
    id: 'ISOITEM_GREEN_SUPPORT_HEALTH_1',
    tier: 'P1',
    color: 'green',
    internalLevel: 1,
    characterClass: 'Soutien',
    characterClassCode: 'SUPPORT',
    category: 'Vie',
    categoryCode: 'HEALTH',
    level: 1
  });
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_FOCUS_20').level, 5);
  assert.equal(parseIsoCrystalId('ISOITEM_BLUE_CONTROLLER_ARMOR_6').level, 1);
  assert.equal(parseIsoCrystalId('ISOITEM_PURPLE_BLASTER_HEALTH_11').level, 1);
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_DAMAGE_16').level, 1);
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_FOCUS_5').reason, 'tier-level-mismatch');
  assert.equal(parseIsoCrystalId('ISOITEM_BLUE_BLASTER_FOCUS_11').reason, 'tier-level-mismatch');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_FOCUS_21').reason, 'level');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_UNKNOWN_FOCUS_1').reason, 'character-class');
  assert.equal(parseIsoCrystalId('ISOITEM_ORANGE_BLASTER_UNKNOWN_1').reason, 'category');
});

test('recognizes the 100 observed tier/class/category identifiers and rejects mismatched suffixes', () => {
  const colors = [['GREEN', 0], ['BLUE', 5], ['PURPLE', 10], ['ORANGE', 15]];
  const classes = ['BRAWLER', 'BLASTER', 'CONTROLLER', 'PROTECTOR', 'SUPPORT'];
  const categories = ['HEALTH', 'DAMAGE', 'ARMOR', 'FOCUS', 'RESIST'];
  let recognized = 0;
  for (const [color, offset] of colors) {
    for (const characterClass of classes) for (const category of categories) {
      const parsed = parseIsoCrystalId(`ISOITEM_${color}_${characterClass}_${category}_${offset + 1}`);
      assert.notEqual(parsed.status, 'unknown');
      assert.equal(parsed.tier, `P${colors.findIndex(([name]) => name === color) + 1}`);
      assert.equal(parsed.level, 1);
      assert.equal(parsed.internalLevel, offset + 1);
      recognized++;
    }
  }
  assert.equal(recognized, 100);
  for (const [color, offset] of colors) {
    const wrong = color === 'GREEN' ? 6 : offset;
    assert.equal(parseIsoCrystalId(`ISOITEM_${color}_SUPPORT_HEALTH_${wrong}`).reason, 'tier-level-mismatch');
  }
});

test('converts every internal ISO-8 suffix 1–20 into the correct tier and player level', () => {
  const colors = [['GREEN', 0], ['BLUE', 5], ['PURPLE', 10], ['ORANGE', 15]];
  const classes = ['BRAWLER', 'BLASTER', 'CONTROLLER', 'PROTECTOR', 'SUPPORT'];
  const categories = ['HEALTH', 'DAMAGE', 'ARMOR', 'FOCUS', 'RESIST'];
  let converted = 0;
  for (const [color, offset] of colors) for (let level = 1; level <= 5; level++)
    for (const characterClass of classes) for (const category of categories) {
      const parsed = parseIsoCrystalId(`ISOITEM_${color}_${characterClass}_${category}_${offset + level}`);
      assert.notEqual(parsed.status, 'unknown');
      assert.equal(parsed.tier, `P${colors.findIndex(([name]) => name === color) + 1}`);
      assert.equal(parsed.level, level);
      assert.equal(parsed.internalLevel, offset + level);
      converted++;
    }
  assert.equal(converted, 500);
});

test('builds the owner supplied P4 level 1 synthetic matrix totaling 117 crystals', () => {
  const items = [
    { id: 'ISOITEM_ORANGE_BLASTER_HEALTH_16', quantity: 16 },
    { id: 'ISOITEM_ORANGE_BLASTER_DAMAGE_16', quantity: 26 },
    { id: 'ISOITEM_ORANGE_BLASTER_ARMOR_16', quantity: 17 },
    { id: 'ISOITEM_ORANGE_BLASTER_FOCUS_16', quantity: 42 },
    { id: 'ISOITEM_ORANGE_BLASTER_RESIST_16', quantity: 16 }
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
  const items = ['HEALTH','DAMAGE','ARMOR','FOCUS','RESIST'].map((category, i) => ({
    id: `ISOITEM_ORANGE_BLASTER_${category}_16`, quantity: i + 1
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
