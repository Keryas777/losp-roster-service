// Résolution du sujet d'un combat avec le catalogue : nom anglais d'un personnage, ou trait (id compact des kits).
import { cleanText } from './classify.js';

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

// « A.I. Avenger » → AIAvenger · « Tower Challenger IV » → TowerChallenger4 · « Daring Warriors » → DaringWarrior
function traitCandidates(name) {
    const words = cleanText(name).replace(/\./g, '').split(/[\s-]+/).filter(Boolean);
    const last = words[words.length - 1] || '';
    const withNumber = ROMAN[last.toUpperCase()] ? [...words.slice(0, -1), String(ROMAN[last.toUpperCase()])] : words;
    const compact = (list) => list.join('').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const singular = withNumber.length ? [...withNumber.slice(0, -1), withNumber[withNumber.length - 1].replace(/s$/i, '')] : withNumber;
    return [...new Set([compact(withNumber), compact(singular)])];
}

/**
 * Index de résolution : characters [{ id, nameEn }] (jouables), traitIds (ids des kits).
 * resolveSubject(subject) → { type: 'any' } | { type: 'character', id } | { type: 'trait', traitId, team }
 *                         | { type: 'unknown', reasonCode: 'ambiguousName' | 'unknownName' }
 */
export function createSubjectResolver({ characters = [], traitIds = [] }) {
    const byName = new Map();
    characters.forEach((character) => {
        const key = cleanText(character.nameEn).toLowerCase();
        if (key) byName.set(key, [...(byName.get(key) || []), character.id]);
    });
    const traitByCompact = new Map(traitIds.map((id) => [id.toLowerCase(), id]));
    const findTrait = (name) => traitCandidates(name).map((key) => traitByCompact.get(key)).find(Boolean) || null;

    return function resolveSubject(subject) {
        if (subject.type === 'any') return { type: 'any' };
        if (subject.type === 'team' || subject.type === 'trait') {
            const traitId = findTrait(subject.name);
            return traitId ? { type: 'trait', traitId, team: subject.type === 'team' } : { type: 'unknown', reasonCode: 'unknownName' };
        }
        const ids = byName.get(cleanText(subject.name).toLowerCase()) || [];
        if (ids.length > 1) return { type: 'unknown', reasonCode: 'ambiguousName' };
        if (ids.length === 1) return { type: 'character', id: ids[0] };
        const traitId = findTrait(subject.name);
        return traitId ? { type: 'trait', traitId, team: false } : { type: 'unknown', reasonCode: 'unknownName' };
    };
}
