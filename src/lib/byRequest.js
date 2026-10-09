// By-request designer enticement systems (owner directive 2026-10-09).
// Character claims (first come, first served), leaderboard, designer
// spotlight, and the by-request commission boost lookup.
const db = require('../db');

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// --- Character claims ---

// Active claim for a character slug, or null.
async function activeClaimFor(characterSlug) {
  return db.get(
    `SELECT * FROM by_request_claims WHERE character_slug = ? AND status = 'active' LIMIT 1`,
    [characterSlug]);
}

// All active claims, keyed by slug.
async function activeClaimsMap() {
  const rows = await db.all(
    `SELECT character_slug, designer_id, claimed_at FROM by_request_claims WHERE status = 'active'`);
  const map = {};
  for (const r of rows) map[r.character_slug] = r;
  return map;
}

// Claim a character for a designer. Returns { ok, claim } or { ok: false, reason }.
async function claimCharacter(characterSlug, characterName, designerId) {
  const existing = await activeClaimFor(characterSlug);
  if (existing) {
    if (existing.designer_id === designerId) return { ok: false, reason: 'already_yours' };
    return { ok: false, reason: 'already_claimed' };
  }
  const claim = {
    id: uid('brc'),
    character_slug: characterSlug,
    character_name: characterName || characterSlug,
    designer_id: designerId,
    claimed_at: db.now(),
    status: 'active',
  };
  await db.insert('by_request_claims', claim);
  return { ok: true, claim };
}

// Release a designer's own active claim.
async function releaseClaim(characterSlug, designerId) {
  const claim = await activeClaimFor(characterSlug);
  if (!claim || claim.designer_id !== designerId) return false;
  await db.update('by_request_claims', claim.id, { status: 'released', released_at: db.now() });
  return true;
}

// Mark a claim completed when the design is approved.
async function completeClaim(characterSlug, designerId, designId) {
  const claim = await activeClaimFor(characterSlug);
  if (!claim || claim.designer_id !== designerId) return false;
  await db.update('by_request_claims', claim.id, { status: 'completed', completed_design_id: designId });
  return true;
}

// Designer's own active claims.
async function designerClaims(designerId) {
  return db.all(
    `SELECT * FROM by_request_claims WHERE designer_id = ? AND status = 'active' ORDER BY claimed_at DESC`,
    [designerId]);
}

// --- Leaderboard ---

// Designers ranked by approved by-request designs submitted.
async function leaderboard(limit = 10) {
  const rows = await db.all(
    `SELECT d.artist_id AS designer_id,
            COUNT(*) AS completed,
            COALESCE(u.display_name, u.email, 'Designer') AS name
     FROM designs d
     LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.by_request_character IS NOT NULL
       AND d.status = 'approved'
       AND d.artist_id IS NOT NULL
     GROUP BY d.artist_id
     ORDER BY completed DESC
     LIMIT ?`,
    [limit]);
  return rows;
}

// Top N designers for the spotlight section.
async function spotlightDesigners(limit = 3) {
  return leaderboard(limit);
}

// --- Commission boost ---

// True when a design is a by-request fulfillment (higher designer rate).
async function isByRequestDesign(designId) {
  if (!designId) return false;
  const d = await db.get('SELECT by_request_character FROM designs WHERE id = ?', [designId]);
  return !!(d && d.by_request_character);
}

module.exports = {
  activeClaimFor, activeClaimsMap, claimCharacter, releaseClaim,
  completeClaim, designerClaims, leaderboard, spotlightDesigners,
  isByRequestDesign,
};
