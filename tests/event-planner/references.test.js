import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMilestoneEvent } from '../../public/event-planner/lib/event-analysis.js';
import { planEvent } from '../../public/event-planner/lib/plan.js';

const NOW = 1_800_000_000;
const DAY = 86_400;

test('Faim mutante exact reference: acquired 65,300 + conditional free projection 29,600 = 94,900; tier 18 stays 100 points uncovered', () => {
  // Synthetic aggregate values only; no personal Scopely response or roster is stored.
  const plan = planEvent({
    event: { points: 65_300, currentTier: 12, endTime: NOW + 6 * DAY },
    actions: [{ index: 0, kind: 'free', status: 'doable', doablePoints: 29_600 }],
    tiers: [
      { tier: 13, goal: 70_000 },
      { tier: 18, goal: 95_000 },
      { tier: 19, goal: 100_000 },
      { tier: 20, goal: 105_000 }
    ],
    levers: [],
    uncappedResources: []
  }, { now: NOW });

  assert.deepEqual(plan.secure, { points: 94_900, tier: 13, fromDoable: 29_600, fromEnergy: 0 });
  assert.equal(plan.secure.points - plan.secure.fromDoable, 65_300, 'the acquired score stays separate');
  const tier18 = plan.steps.find((step) => step.tier === 18);
  assert.equal(tier18.missing, 100);
  assert.equal(tier18.uncovered, 100);
  assert.notEqual(tier18.verdict, 'feasible');
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
