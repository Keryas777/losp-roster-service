// Planificateur d'événements (MSF.md §7) : classement des objectifs, ressources, résolution des sujets.
export { ACTIONS, MODES, RESOURCES, classifyObjective, cleanText, isIon, parseRequirements, resourceForText } from './classify.js';
export { createSubjectResolver } from './subjects.js';
export { planDays, planEvent, unitsFor } from './plan.js';
export { declareResource, estimateResource, isStockResource, observeEvent, refreshResource, resourcesInUse } from './ledger.js';
export { parseQuantity } from './quantity.js';

// Hypothèses de jeu non confirmées (MSF.md §7.8), remontées en codes dans les réponses
export const HYPOTHESES = {
    traitFightFullSquad: 'trait-fight-full-squad',
    isoLevelsPerTier: 'iso-levels-per-tier',
    rewardOnClaim: 'reward-on-claim',
    metaChain: 'meta-chain',
    sharedSpend: 'shared-spend',
    absentItemZero: 'absent-item-zero',
    ionNameLink: 'ion-name-link'
};
