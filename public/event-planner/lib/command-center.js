// Fonctions pures de regroupement des séries du poste de commandement.
// Les événements sont déjà chargés par le parcours Maddoxx existant; ce module ne déclenche aucun appel réseau.
const WRAPPER_HINT = "lohub_wrapper";
const FEEDER_HINT = "lohub_feeder";
const DAY_SECONDS = 24 * 60 * 60;
const DATE_SLACK_SECONDS = 60 * 60;
const PERIOD_ORDER = { day: 0, week: 1, event: 2, unknown: 3 };
const cleanName = value => String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
const hints = event => Array.isArray(event?.locationHints) ? event.locationHints : [];

export const isCommandCenterWrapper = event => hints(event).includes(WRAPPER_HINT);
export const isCommandCenterFeeder = event => hints(event).includes(FEEDER_HINT);

export function commandCenterPeriod(event) {
  const start = Number(event?.startTime), end = Number(event?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "unknown";
  const duration = end - start;
  if (duration <= 1.5 * DAY_SECONDS) return "day";
  if (duration <= 8 * DAY_SECONDS) return "week";
  return "event";
}

export function commandCenterPeriodLabel(event) {
  return ({ day: "Objectif quotidien", week: "Objectif hebdomadaire", event: "Objectif de l’événement", unknown: "Période inconnue" })[commandCenterPeriod(event)];
}

// Sélection prudente des séries d’un wrapper : même nom nettoyé, période incluse avec 1 h de tolérance,
// marqueur officiel lohub_feeder et dates valides. Les séries doivent être en cours.
export function commandCenterFeeders(wrapper, events, nowSeconds = Date.now() / 1000) {
  if (!isCommandCenterWrapper(wrapper) || !Array.isArray(events)) return [];
  const wrapperName = cleanName(wrapper.name);
  const wrapperStart = Number(wrapper.startTime), wrapperEnd = Number(wrapper.endTime);
  if (!wrapperName || !Number.isFinite(wrapperStart) || !Number.isFinite(wrapperEnd) || wrapperEnd <= wrapperStart) return [];
  return events.filter(event => {
    if (!isCommandCenterFeeder(event) || String(event.id) === String(wrapper.id) || cleanName(event.name) !== wrapperName) return false;
    const start = Number(event.startTime), end = Number(event.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start &&
      start <= nowSeconds && end > nowSeconds && start >= wrapperStart - DATE_SLACK_SECONDS && end <= wrapperEnd + DATE_SLACK_SECONDS;
  }).sort((a, b) =>
    (PERIOD_ORDER[commandCenterPeriod(a)] - PERIOD_ORDER[commandCenterPeriod(b)]) ||
    (Number(a.endTime) - Number(b.endTime)) || String(a.id).localeCompare(String(b.id))
  );
}

// Missing/invalid counters stay unknown. A feeder is only described as having completed all capped lines
// when every positive cap and its soFar value are present as finite non-negative numbers.
export function summarizeFeederProgress(event) {
  const lines = event?.milestone?.scoring?.cappedScorings;
  if (!Array.isArray(lines) || lines.length === 0) return { status: "unknown", total: 0, known: 0, completed: 0 };
  const states = lines.map(line => {
    const cap = line?.cap, progress = line?.soFar;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 ||
        typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) return null;
    return progress >= cap;
  });
  const known = states.filter(value => value !== null).length;
  const completed = states.filter(value => value === true).length;
  const status = known === 0 ? "unknown" : known < states.length ? "partial"
    : completed === states.length ? "complete-lines" : "open-lines";
  return { status, total: states.length, known, completed };
}
