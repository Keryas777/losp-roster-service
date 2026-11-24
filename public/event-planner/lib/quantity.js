// Saisie souple d'une quantité de ressource : « 18,91 M », « 18.91M », « 18 910 000 », « 250 K », « 1,3 Md ».
const MULTIPLIERS = { '': 1, k: 1e3, m: 1e6, md: 1e9, b: 1e9 };

/** Texte ou nombre → { value } (entier ≥ 0) ou { error } (code). */
export function parseQuantity(input) {
    if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? { value: Math.round(input) } : { error: 'invalid' };
    if (typeof input !== 'string') return { error: 'invalid' };
    // Espaces (dont insécables) comme séparateurs de milliers
    const text = input.replace(/[\s  ]/g, '').toLowerCase();
    if (!text) return { error: 'empty' };
    // Sans suffixe, un point ou une virgule est un séparateur de milliers (« 18.910.000 », « 18,910 ») : pas de décimales
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) return { value: Number(text.replace(/[.,]/g, '')) };
    const match = text.match(/^(\d+(?:[.,]\d{1,3})?)(k|md|m|b)?$/);
    if (!match || (!match[2] && /[.,]/.test(match[1]))) return { error: 'invalid' };
    const value = Number(match[1].replace(',', '.')) * MULTIPLIERS[match[2] || ''];
    return Number.isFinite(value) ? { value: Math.round(value) } : { error: 'invalid' };
}
