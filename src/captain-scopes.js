// Centralized OAuth consent manifest for future LoSP alliance captains.
// The six player read scopes are in Scopely's official OAuth OpenAPI;
// m3p.f.ar.ros is also documented on member-roster endpoints and was
// confirmed granted by Scopely in the October 16 live LoSP test.
// offline is a consent scope, NOT a storage mechanism.
export const CAPTAIN_SCOPE_DESCRIPTIONS = Object.freeze([
  { scope: "openid", label: "Connexion Scopely" },
  { scope: "m3p.f.pr.pro", label: "Profil personnel" },
  { scope: "m3p.f.pr.ros", label: "Roster et équipes personnels" },
  { scope: "m3p.f.pr.inv", label: "Inventaire personnel" },
  { scope: "m3p.f.pr.act", label: "Activité et événements personnels" },
  { scope: "m3p.f.pr.buy", label: "Consultation des offres" },
  { scope: "m3p.f.ar.pro", label: "Profil et membres de l’alliance" },
  { scope: "m3p.f.ar.ros", label: "Rosters et équipes partagés de l’alliance" },
  { scope: "offline", label: "Autorisation de maintien de l’accès" }
]);

export const CAPTAIN_SCOPES = CAPTAIN_SCOPE_DESCRIPTIONS.map(row => row.scope).join(" ");

// Only known OAuth scopes. Names present in OpenAPI tags without an OAuth scope
// or usable route (ar.inv/ar.raid/ar.war/ar.act) must not be guessed here.
// Same for write/post capabilities: viewing data does not justify changing it.

export function auditCaptainScopes(issuedScope) {
  if (typeof issuedScope !== "string") {
    return { state: "unreported", granted: 0, total: CAPTAIN_SCOPE_DESCRIPTIONS.length,
      scopes: CAPTAIN_SCOPE_DESCRIPTIONS.map(row => ({ ...row, granted: false })) };
  }
  const granted = new Set(issuedScope.trim().split(/\s+/).filter(Boolean));
  const scopes = CAPTAIN_SCOPE_DESCRIPTIONS.map(row =>
    ({ ...row, granted: granted.has(row.scope) }));
  const grantedCount = scopes.filter(row => row.granted).length;
  return {
    state: grantedCount === scopes.length ? "complete" : "partial",
    granted: grantedCount,
    total: scopes.length,
    scopes
  };
}
