import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMilestoneEvent } from '../../public/event-planner/lib/event-analysis.js';
import { planEvent } from '../../public/event-planner/lib/plan.js';

const NOW = 1_800_000_000;
const DAY = 86_400;

test('Faim mutante reference: a synthetic near-threshold projection does not claim tier 18', () => {
  // Synthetic aggregate values; no player response or roster is stored in this fixture.
  const plan = planEvent({
    event: { points: 5_500, currentTier: 12, endTime: NOW + 7 * DAY },
    actions: [{ index: 0, kind: 'free', status: 'doable', doablePoints: 3_990 }],
    tiers: [
      { tier: 13, goal: 7_000 },
      { tier: 18, goal: 9_500 },
      { tier: 19, goal: 10_000 },
      { tier: 20, goal: 10_500 }
    ],
    levers: [],
    uncappedResources: []
  }, { now: NOW });

  assert.deepEqual(plan.secure, { points: 9_490, tier: 13, fromDoable: 3_990, fromEnergy: 0 });
  const tier18 = plan.steps.find((step) => step.tier === 18);
  assert.equal(tier18.missing, 10);
  assert.equal(tier18.uncovered, 10);
});

test('Sang, gloire et fortune reference: French public objectives label the analyzed actions', () => {
  const progress = { points: 1_000, completedTier: 0, claimableTiers: [] };
  const objective = { progress, tiers: { 0: { goal: 1_000 }, 1: { goal: 2_000 } } };
  const eventEn = {
    id: '6aff55402c6b04c8d8a6240a',
    type: 'milestone',
    endTime: NOW + 6 * DAY,
    milestone: {
      type: 'solo',
      scoring: {
        methods: [],
        cappedScorings: [
          { cap: 2_000, soFar: 1_000, methods: [{ description: 'Daily Login', points: 1_000 }] },
          { cap: 11_000, soFar: 0, methods: [{ description: 'Play Blitz with Toxin', points: 1_000 }] }
        ]
      },
      brackets: [{ id: 'default', objective }]
    }
  };
  const eventFr = {
    ...eventEn,
    name: 'Sang, gloire et fortune',
    milestone: {
      ...eventEn.milestone,
      scoring: {
        methods: [],
        cappedScorings: [
          { cap: 2_000, soFar: 1_000, methods: [{ description: 'Se connecter quotidiennement', points: 1_000 }] },
          { cap: 11_000, soFar: 0, methods: [{ description: 'Combattre en choc avec Toxin', points: 1_000 }] }
        ]
      }
    }
  };

  const result = analyzeMilestoneEvent({
    eventEn,
    eventFr,
    roster: [{ id: 'toxin', activeYellow: 7, activeRed: 0, gearTier: 21, level: 110 }],
    characters: [{ id: 'toxin', nameEn: 'Toxin', nameFr: 'Toxin', portrait: null, traits: [] }],
    now: NOW
  });

  assert.equal(result.supported, true);
  assert.deepEqual(result.actions.map((action) => [action.kind, action.label]), [
    ['login', 'Se connecter quotidiennement'],
    ['fight', 'Combattre en choc avec Toxin']
  ]);
  assert.equal(result.event.points, 1_000);
  assert.equal(result.event.currentTier, 0);
});
