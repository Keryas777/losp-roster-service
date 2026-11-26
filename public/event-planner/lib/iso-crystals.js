// Parse ISO-8 crystal inventory IDs and build a partial, evidence-aware matrix.
// Names follow the confirmed MSF client terminology; unknown IDs stay unclassified.
const TIERS = Object.freeze({
  GREEN: { tier: "P1", color: "green" },
  BLUE: { tier: "P2", color: "blue" },
  PURPLE: { tier: "P3", color: "purple" },
  ORANGE: { tier: "P4", color: "orange" },
});
const CHARACTER_CLASSES = Object.freeze({
  BRAWLER: "Cogneur",
  BLASTER: "Tireur",
  CONTROLLER: "Contrôleur",
  PROTECTOR: "Protecteur",
  SUPPORT: "Soutien",
});
const CRYSTAL_CATEGORIES = Object.freeze({
  HEALTH: "Vie",
  DAMAGE: "Dégâts",
  ARMOR: "Armure",
  FOCUS: "Focalisation",
  RESIST: "Résistance",
});
const CLASS_ORDER = Object.freeze(["BRAWLER", "BLASTER", "CONTROLLER", "PROTECTOR", "SUPPORT"]);
const CATEGORY_ORDER = Object.freeze(["HEALTH", "DAMAGE", "ARMOR", "FOCUS", "RESIST"]);
const OBSERVED_IDS = new Set(["ISOITEM_GREEN_SUPPORT_HEALTH_1"]);

export function parseIsoCrystalId(rawId) {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const parts = /^ISOITEM_([A-Z]+)_([A-Z]+)_([A-Z]+)_([0-9]+)$/i.exec(id);
  if (!parts) return { status: "unknown", id, reason: "format" };
  const [, rawTier, rawClass, rawCategory, rawLevel] = parts;
  const tierToken = rawTier.toUpperCase();
  const classToken = rawClass.toUpperCase();
  const categoryToken = rawCategory.toUpperCase();
  const level = Number(rawLevel);
  if (!TIERS[tierToken]) return { status: "unknown", id, reason: "tier" };
  if (!CHARACTER_CLASSES[classToken]) return { status: "unknown", id, reason: "character-class" };
  if (!CRYSTAL_CATEGORIES[categoryToken]) return { status: "unknown", id, reason: "category" };
  if (!Number.isInteger(level) || level < 1 || level > 5) return { status: "unknown", id, reason: "level" };
  return {
    status: OBSERVED_IDS.has(id.toUpperCase()) ? "observed-example" : "nomenclature-derived",
    id,
    tier: TIERS[tierToken].tier,
    color: TIERS[tierToken].color,
    characterClass: CHARACTER_CLASSES[classToken],
    characterClassCode: classToken,
    category: CRYSTAL_CATEGORIES[categoryToken],
    categoryCode: categoryToken,
    level,
  };
}

export function buildIsoCrystalMatrix(items, tier = "P1", level = 1) {
  const normalizedTier = String(tier || "").toUpperCase();
  const normalizedLevel = Number(level);
  const allowedTier = Object.values(TIERS).some(entry => entry.tier === normalizedTier);
  if (!allowedTier || !Number.isInteger(normalizedLevel) || normalizedLevel < 1 || normalizedLevel > 5) {
    throw new TypeError("Invalid ISO-8 matrix selection");
  }

  const rows = Array.isArray(items) ? items : [];
  const byId = new Map();
  const conflicts = new Set();
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const parsed = parseIsoCrystalId(id);
    if (parsed.status === "unknown" || parsed.tier !== normalizedTier || parsed.level !== normalizedLevel) continue;
    const quantity = Number.isSafeInteger(row.quantity) && row.quantity >= 0 ? row.quantity : null;
    if (!byId.has(id)) byId.set(id, { parsed, quantity });
    else if (byId.get(id).quantity !== quantity) conflicts.add(id);
  }

  const cells = {};
  for (const classCode of CLASS_ORDER) {
    cells[CHARACTER_CLASSES[classCode]] = {};
    for (const categoryCode of CATEGORY_ORDER) {
      const matches = [...byId.entries()].filter(([, entry]) =>
        entry.parsed.characterClassCode === classCode && entry.parsed.categoryCode === categoryCode);
      const hasUnknownQuantity = matches.some(([id, entry]) => entry.quantity === null || conflicts.has(id));
      const quantity = matches.reduce((sum, [, entry]) => sum + (entry.quantity ?? 0), 0);
      cells[CHARACTER_CLASSES[classCode]][CRYSTAL_CATEGORIES[categoryCode]] = {
        state: matches.length && !hasUnknownQuantity ? "known" : "unknown",
        quantity: matches.length && !hasUnknownQuantity ? quantity : null,
        ids: matches.map(([id]) => id),
      };
    }
  }

  return {
    tier: normalizedTier,
    level: normalizedLevel,
    classes: CLASS_ORDER.map(code => CHARACTER_CLASSES[code]),
    categories: CATEGORY_ORDER.map(code => CRYSTAL_CATEGORIES[code]),
    cells,
    recognizedIds: byId.size,
    unknownIds: [...new Set(rows.map(row => typeof row?.id === "string" ? row.id.trim() : ""))]
      .filter(id => id && parseIsoCrystalId(id).status === "unknown"),
  };
}
