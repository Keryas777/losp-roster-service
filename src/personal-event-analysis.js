// Pure, local-only projection of Scopely event responses. Missing progress is unknown.
export const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const finite = value => typeof value === "number" && Number.isFinite(value);
export const firstNumber = (value, keys) => {
  for (const key of keys) if (finite(value?.[key])) return value[key];
  return null;
};
export const label = (value, fallback) => typeof value === "string" && value.trim() ? value : fallback;
export const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());

export function eventsFrom(response) {
  let value = response;
  for (let i=0;i<4;i++) {
    if (object(value) && Array.isArray(value.data)) { value=value.data; break; }
    if (object(value) && Array.isArray(value.events)) { value=value.events; break; }
    if (object(value) && Object.hasOwn(value,"data")) { value=value.data; continue; }
    break;
  }
  if (!Array.isArray(value)) value = [value];
  return value.filter(object);
}

export function eventMilestones(event) {
  const value = event.milestones ?? event.milestone ?? [];
  return Array.isArray(value) ? value.filter(object) : object(value) ? [value] : [];
}

export function progressFact(kind, source, context, labelText) {
  const value = finite(source) ? source : firstNumber(source, ["progress", "soFar", "value", "current", "contribution"]);
  const target = firstNumber(source, ["target", "required", "goal", "cap", "max", "total"]);
  const explicitComplete = source?.completed === true || source?.isComplete === true;
  const measurable = value !== null && target !== null && target > 0;
  return { kind, label: labelText, value, target,
    percent: measurable ? Math.max(0, Math.min(100, value / target * 100)) : null,
    state: explicitComplete || (measurable && value >= target) ? "completed" :
      measurable ? "incomplete" : value !== null ? "known" : "unknown",
    context, source: object(source) ? source : null };
}

export function analyzePersonalEventResponse(response, selectedId = null) {
  const events = eventsFrom(response).filter(event => selectedId == null || String(event.id ?? event.eventId) === String(selectedId));
  return events.map(event => {
    const milestones = eventMilestones(event), facts = [], shared = new Set();
    let objectives = 0, knownObjectives = 0, unknownObjectives = 0, absentObjectives = 0;
    const completedTiers = [], claimableTiers = [];
    for (const [mi, milestone] of milestones.entries()) {
      const milestoneId = String(milestone.id ?? milestone.milestoneId ?? mi + 1);
      const brackets = Array.isArray(milestone.brackets) ? milestone.brackets : [];
      for (const [bi, bracket] of brackets.entries()) {
        objectives++;
        const obj = bracket?.objective;
        if (!object(obj) || !Object.hasOwn(obj, "progress")) absentObjectives++;
        else if (obj.progress === null || !finite(obj.progress) && !object(obj.progress)) unknownObjectives++;
        else knownObjectives++;
        if (object(obj) && Object.hasOwn(obj, "progress")) facts.push(progressFact("objective", obj,
          `milestone:${milestoneId}/bracket:${bracket.id ?? bi + 1}`, label(bracket.name ?? obj.name, `Objectif ${bi + 1}`)));
      }
      const scorings = milestone.scoring?.cappedScorings ?? milestone.cappedScorings ?? [];
      if (Array.isArray(scorings)) for (const [si, scoring] of scorings.entries()) {
        if (!object(scoring)) continue;
        const identity = scoring.id ?? scoring.scoringId ?? scoring.key ?? scoring.objectiveId;
        const signature = identity != null ? `id:${identity}` : `shape:${stable({soFar:scoring.soFar,cap:scoring.cap,target:scoring.target,method:scoring.method})}`;
        if (shared.has(signature)) continue;
        shared.add(signature);
        facts.push(progressFact("capped-scoring", scoring, `milestone:${milestoneId}/scoring:${identity ?? si + 1}`,
          label(scoring.name ?? scoring.displayName ?? scoring.method, `Compteur ${si + 1}`)));
      }
      const tiers = Array.isArray(milestone.tiers) ? milestone.tiers : [];
      const completed = milestone.completedTier;
      if (finite(completed)) for (const tier of tiers) if (finite(tier?.tier) && tier.tier <= completed) completedTiers.push({milestoneId,tier:tier.tier,reward:tier.reward ?? tier.rewards ?? null});
      const claimable = milestone.claimableTiers;
      if (Array.isArray(claimable)) for (const tier of claimable) claimableTiers.push({milestoneId,tier:finite(tier)?tier:tier?.tier ?? null,reward:tier?.reward ?? tier?.rewards ?? null});
      else if (finite(claimable)) claimableTiers.push({milestoneId,tier:claimable,reward:null});
    }
    const score = firstNumber(event, ["score", "playerScore", "totalScore"]);
    return {id:String(event.id ?? event.eventId ?? "unknown"),name:label(event.name ?? event.displayName, "Nom indisponible"),score,
      milestoneCount:milestones.length,objectiveCount:objectives,knownObjectives,unknownObjectives,absentObjectives,
      facts,completedTiers,claimableTiers};
  });
}
