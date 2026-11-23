// Classement d'une ligne d'objectif d'événement à jalons (texte anglais de l'API) : règles déterministes, aucune donnée
// joueur. Le sujet d'un combat reste un nom : sa résolution (personnage ou trait) se fait avec le catalogue (subjects.js).
import DATA from './resources.js';

// Apostrophes et espaces unifiés : les textes du jeu mélangent ’ et '
const normalize = (value = '') => String(value).replace(/<[^>]*>/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
export const cleanText = normalize;

const compile = (entries) => entries.map((entry) => ({
    ...entry,
    regex: { en: entry.patterns.en.map((pattern) => new RegExp(normalize(pattern), 'i')), fr: entry.patterns.fr.map((pattern) => new RegExp(normalize(pattern), 'i')) }
}));
const RESOURCE_ENTRIES = compile([...DATA.resources, ...DATA.ions]);
const ION_KEYS = new Set(DATA.ions.map((ion) => ion.key));

export const RESOURCES = Object.fromEntries(RESOURCE_ENTRIES.map(({ regex, ...entry }) => [entry.key, entry]));
export const ACTIONS = DATA.actions;
export const MODES = DATA.modes;
export const isIon = (key) => ION_KEYS.has(key);

// Clé de ressource d'une ligne de dépense (texte EN), ou null
export function resourceForText(text, lang = 'en') {
    const clean = normalize(text);
    return RESOURCE_ENTRIES.find((entry) => entry.regex[lang].some((regex) => regex.test(clean)))?.key ?? null;
}

// « at 7 Yellow Stars », « at GT21 », « at Gear Tier 20 », « at 5 Red Stars », « at Level 100 »
export function parseRequirements(text = '') {
    const requirements = {};
    const yellow = text.match(/(\d+)\s*Yellow Stars?/i);
    const red = text.match(/(\d+)\s*Red Stars?/i);
    const gear = text.match(/\b(?:GT\s*|Gear Tier\s+)(\d+)/i);
    const level = text.match(/\bLevel\s+(\d+)/i);
    if (yellow) requirements.yellowStars = Number(yellow[1]);
    if (red) requirements.redStars = Number(red[1]);
    if (gear) requirements.gearTier = Number(gear[1]);
    if (level) requirements.level = Number(level[1]);
    return requirements;
}

const MODE_INDEX = new Map(Object.entries(DATA.modes).flatMap(([key, mode]) => mode.en.map((name) => [name.toLowerCase(), key])));

// « Arena, War, RTA, or Crucible » → ['arena', 'war', 'rta', 'crucible'] ; null si un mode est inconnu
function parseModes(text) {
    const parts = text.split(/,|\bor\b/i).map((part) => part.trim()).filter(Boolean);
    const modes = parts.map((part) => MODE_INDEX.get(part.toLowerCase()) ?? null);
    return modes.includes(null) ? null : modes;
}

// Sujet d'un combat : any, team (« all Menace together »), trait (« Savage Land characters »), named (personnage ou trait)
function parseSubject(text) {
    if (/^any character$/i.test(text)) return { type: 'any' };
    const team = text.match(/^all (?:members of )?(.+?)(?: together)?$/i);
    if (team) return { type: 'team', name: team[1] };
    const trait = text.match(/^(?:any )?(.+?) characters$/i);
    if (trait) return { type: 'trait', name: trait[1] };
    return { type: 'named', name: text };
}

const unknown = (reasonCode) => ({ kind: 'unknown', reasonCode });

// « Play / Battle … » : combat (avec sujet) ou mode de jeu seul
function parseFight(rest) {
    const body = rest.replace(/^a Battle\s+/i, '');
    const withMatch = body.match(/^(?<pre>.*?)\bwith\s+(?<subject>.+)$/i);
    const pre = (withMatch ? withMatch.groups.pre : body).trim().replace(/^in\s+/i, '').replace(/^1\s+/, '').replace(/\s*Battle$/i, '').trim();
    const modes = pre ? parseModes(pre) : [];
    if (!modes) return unknown('unknownMode');
    const mode = modes.length === 0 ? 'any' : modes.length === 1 ? modes[0] : 'multi';
    if (!withMatch) return modes.length ? { kind: 'mode', mode, modes } : unknown('unknownForm');
    const [subjectText, requirementText = ''] = withMatch.groups.subject.split(/\s+at\s+(?=\d|GT|Gear Tier|Level)/i);
    return { kind: 'fight', mode, modes, subject: parseSubject(subjectText.trim()), requirements: parseRequirements(requirementText) };
}

function parseUpgrade(text) {
    const level = text.match(/^Upgrade any character Level to (\d+)$/i);
    if (level) return { kind: 'upgrade', target: 'level', threshold: Number(level[1]) };
    const gear = text.match(/^Upgrade any character to Gear Tier (\d+)$/i);
    if (gear) return { kind: 'upgrade', target: 'gearTier', threshold: Number(gear[1]) };
    const iso = text.match(/^Upgrade any character to T(\d+) Level (\d+) Iso-?8$/i);
    if (iso) return { kind: 'upgrade', target: 'iso', isoTier: Number(iso[1]), isoLevel: Number(iso[2]) };
    return null;
}

/**
 * Ligne d'objectif (texte EN) → { kind, … } :
 * login · fight { mode, modes, subject, requirements } · mode { mode, modes } · spend / spendEnergy { resource } ·
 * upgrade { target, threshold | isoTier, isoLevel } · earn · free · external { reasonCode } · meta ·
 * unknown { reasonCode } (noText, unknownIon, unknownResource, unknownMode, unknownForm).
 */
export function classifyObjective(description) {
    const text = normalize(description);
    if (!text) return unknown('noText');
    if (/^(?:daily )?log ?in\b/i.test(text) || /^Login for \d+ Days?$/i.test(text)) return { kind: 'login' };
    if (/^Claim a free offer\.?$/i.test(text)) return { kind: 'free' };
    if (/\bBattle Pass(?:es)?\b/i.test(text)) return { kind: 'external', reasonCode: 'battlePass' };
    if (/\b(?:offers?|purchase|store|shop|buy|buying)\b/i.test(text)) return { kind: 'external', reasonCode: 'purchase' };
    if (/^Open\b.*\bOrb\b/i.test(text)) return { kind: 'external', reasonCode: 'orb' };
    if (/^Get points by completing\b/i.test(text)) return { kind: 'meta' };
    if (/^Spend\b/i.test(text)) {
        const resource = resourceForText(text);
        if (resource) return { kind: RESOURCES[resource].nature === 'energy' ? 'spendEnergy' : 'spend', resource };
        return unknown(/\bIons?\b/i.test(text) ? 'unknownIon' : 'unknownResource');
    }
    if (/^Upgrade\b/i.test(text)) return parseUpgrade(text) || unknown('unknownForm');
    if (/^(?:Earn|Collect|Gain)\b/i.test(text)) return { kind: 'earn' };
    const clear = text.match(/^Clear Waves in (.+)$/i);
    if (clear) {
        const modes = parseModes(clear[1]);
        return modes ? { kind: 'mode', mode: modes[0], modes } : unknown('unknownMode');
    }
    const fight = text.match(/^(?:Play|Battle)\s+(.+)$/i);
    if (fight) return parseFight(fight[1]);
    return unknown('unknownForm');
}
