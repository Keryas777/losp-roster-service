// Classement des objectifs : formes unitaires, table des ions, résolution des sujets, et toutes les lignes réelles figées.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESOURCES, classifyObjective, createSubjectResolver, isIon, resourceForText } from '../../public/event-planner/lib/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/objectives.json', import.meta.url), 'utf8'));

test('toutes les lignes réelles gardent leur classement relu', () => {
    fixture.objectives.forEach(({ en, expected }) => {
        const result = classifyObjective(en);
        const actual = { kind: result.kind };
        if (result.resource) actual.resource = result.resource;
        if (result.reasonCode) actual.reasonCode = result.reasonCode;
        if (result.subject) actual.subject = result.subject.type;
        if (result.modes?.length) actual.modes = result.modes;
        assert.deepEqual(actual, expected, en);
    });
});

test('combats : « Play » et « Battle », mode, exigences', () => {
    assert.deepEqual(classifyObjective('Play Blitz with Ultron at GT21'),
        { kind: 'fight', mode: 'blitz', modes: ['blitz'], subject: { type: 'named', name: 'Ultron' }, requirements: { gearTier: 21 } });
    assert.deepEqual(classifyObjective('Battle with Rogue at Gear Tier 20').requirements, { gearTier: 20 });
    assert.deepEqual(classifyObjective('Play with Cyclops (Mighty) at 7 Yellow Stars and Gear Tier 21').requirements, { yellowStars: 7, gearTier: 21 });
    assert.equal(classifyObjective('Battle in War with Shadow Conclave').mode, 'war');
    assert.equal(classifyObjective('Battle in Cosmic Crucible with Daring Warriors').mode, 'crucible');
    assert.deepEqual(classifyObjective('Play a Battle with Vision').subject, { type: 'named', name: 'Vision' });
    for (const text of ['Play Battle with Tech Characters', 'Play a Battle with Tech Characters', 'Play Battles with Tech Characters']) {
        assert.deepEqual(classifyObjective(text), {
            kind: 'fight', mode: 'any', modes: [], subject: { type: 'trait', name: 'Tech' }, requirements: {}
        }, text);
    }
});

test('sujets : n’importe quel personnage, trait, équipe', () => {
    assert.equal(classifyObjective('Battle with Any Character at Gear Tier 21').subject.type, 'any');
    assert.deepEqual(classifyObjective('Battle with Savage Land characters').subject, { type: 'trait', name: 'Savage Land' });
    assert.deepEqual(classifyObjective('Battle with all Menace together').subject, { type: 'team', name: 'Menace' });
    assert.deepEqual(classifyObjective('Play with all members of Iron Raiders').subject, { type: 'team', name: 'Iron Raiders' });
});

test('modes seuls, liste de modes, mode inconnu', () => {
    assert.deepEqual(classifyObjective('Play Arena, War, RTA, or Crucible').modes, ['arena', 'war', 'rta', 'crucible']);
    assert.equal(classifyObjective('Play 1 Arena Battle').mode, 'arena');
    assert.equal(classifyObjective('Clear Waves in Battleworld').mode, 'battleworld');
    assert.deepEqual(classifyObjective('Play Galactic Tag with Ultron'), { kind: 'unknown', reasonCode: 'unknownMode' });
});

test('offre gratuite, achats, orbes, battle pass', () => {
    assert.equal(classifyObjective('Claim a free offer.').kind, 'free');
    assert.equal(classifyObjective('Make a purchase from the Web Store.').reasonCode, 'purchase');
    assert.equal(classifyObjective('Open an Orange Mega Orb').reasonCode, 'orb');
    assert.equal(classifyObjective('Collect 1 Founding Force Milestone Point from the Wasp (Janet) Battle Passes').reasonCode, 'battlePass');
});

test('dépenses : stock, énergie, avec ou sans plafond', () => {
    assert.deepEqual(classifyObjective('Spend Power Cores'), { kind: 'spend', resource: 'CORE' });
    assert.deepEqual(classifyObjective('Spend 1 Power Core'), { kind: 'spend', resource: 'CORE' });
    assert.deepEqual(classifyObjective('Spend 1 CAMPAIGN ENERGY'), { kind: 'spendEnergy', resource: 'ENERGY_CAMPAIGN' });
    assert.deepEqual(classifyObjective('Spend Gold'), { kind: 'spend', resource: 'GOLD' });
    assert.deepEqual(classifyObjective('Spend Unobtainium'), { kind: 'unknown', reasonCode: 'unknownResource' });
});

test('ions : uniquement la table observée, aucun calcul de correspondance', () => {
    assert.deepEqual(classifyObjective('Spend 1 Tier 2 Level 4 Ion'), { kind: 'spend', resource: 'ION_P2_L4' });
    assert.equal(RESOURCES.ION_P2_L4.itemId, 'ISO8-TIER-1-B-CURRENCY');
    assert.ok(isIon('ION_P4_L1'));
    // Sortes non observées dans une ligne d'événement : unknown, jamais comptées
    assert.deepEqual(classifyObjective('Spend 1 Tier 4 Level 4 Ion'), { kind: 'unknown', reasonCode: 'unknownIon' });
    assert.deepEqual(classifyObjective('Spend 1 Tier 1 Ion'), { kind: 'unknown', reasonCode: 'unknownIon' });
    assert.equal(resourceForText('Dépenser 1 ion palier 3 niveau 5', 'fr'), 'ION_P3_L5');
});

test('améliorations, connexion, gains, lignes vides', () => {
    assert.deepEqual(classifyObjective('Upgrade any character to T4 Level 3 Iso-8'), { kind: 'upgrade', target: 'iso', isoTier: 4, isoLevel: 3 });
    assert.deepEqual(classifyObjective('Upgrade any character to Gear Tier 21'), { kind: 'upgrade', target: 'gearTier', threshold: 21 });
    assert.equal(classifyObjective('Login for 14 Days').kind, 'login');
    assert.equal(classifyObjective('Earn 1 War Token').kind, 'earn');
    assert.deepEqual(classifyObjective(''), { kind: 'unknown', reasonCode: 'noText' });
    assert.deepEqual(classifyObjective('Defeat the Watcher'), { kind: 'unknown', reasonCode: 'unknownForm' });
});

test('résolution : personnage, nom ambigu, traits (pluriel, chiffres romains, points)', () => {
    const resolve = createSubjectResolver({
        characters: [{ id: 'Rogue', nameEn: 'Rogue' }, { id: 'Spidey', nameEn: 'Spider-Man' }, { id: 'SpideyBig', nameEn: 'Spider-Man' }],
        traitIds: ['AIAvenger', 'TowerChallenger4', 'DaringWarrior', 'ShadowConclave', 'Menace']
    });
    assert.deepEqual(resolve({ type: 'named', name: 'Rogue' }), { type: 'character', id: 'Rogue' });
    assert.deepEqual(resolve({ type: 'named', name: 'Spider-Man' }), { type: 'unknown', reasonCode: 'ambiguousName' });
    assert.deepEqual(resolve({ type: 'named', name: 'Nobody' }), { type: 'unknown', reasonCode: 'unknownName' });
    assert.deepEqual(resolve({ type: 'team', name: 'A.I. Avenger' }), { type: 'trait', traitId: 'AIAvenger', team: true });
    assert.deepEqual(resolve({ type: 'trait', name: 'Tower Challenger IV' }), { type: 'trait', traitId: 'TowerChallenger4', team: false });
    assert.deepEqual(resolve({ type: 'named', name: 'Daring Warriors' }), { type: 'trait', traitId: 'DaringWarrior', team: false });
    assert.deepEqual(resolve({ type: 'any' }), { type: 'any' });
});
