// Content-policy display helpers.
//
// Sensitivity levels (owner policy 2026-09-28):
//   normal   — standard watermarked display
//   nude     — nudity is allowed; displayed watermarked like normal
//   explicit — sexual acts / highly offensive content: the public preview is
//              a blurred copy of the watermarked linework. The blur lifts for:
//              the artist, admins, buyers of the piece, and age-verified
//              users who opted in (show_explicit). Otherwise it stays until
//              purchase (buyers receive the clean files via normal delivery).
const db = require('../db');
const { isAdminRole } = require('../middleware/auth');

const SENSITIVITIES = ['normal', 'nude', 'explicit'];

// viewer: {id, role, age_verified, show_explicit} | null (signed out)
function canViewUnblurred(design, viewer, owned = false) {
  if (!design || design.sensitivity !== 'explicit') return true;
  if (owned) return true;
  if (!viewer) return false;
  if (viewer.id && design.artist_id && viewer.id === design.artist_id) return true;
  if (isAdminRole(viewer.role)) return true;
  return !!(viewer.age_verified && viewer.show_explicit);
}

// Relative asset path to render for this viewer (blurred variant when gated).
function displayLinework(design, viewer, owned = false) {
  if (!design) return '';
  if (!canViewUnblurred(design, viewer, owned) && design.linework_blur_path) {
    return design.linework_blur_path;
  }
  return design.linework_wm_path || '';
}

// Enriched viewer for blur gating. Accepts a web req.user ({id, role}) or a
// full user row (API token auth); fetches the age fields when missing.
async function viewerFor(user) {
  if (!user || !user.id) return null;
  if (user.age_verified !== undefined && user.show_explicit !== undefined) {
    return {
      id: user.id, role: user.role,
      age_verified: !!user.age_verified, show_explicit: !!user.show_explicit,
    };
  }
  const row = await db.get(
    'SELECT id, role, age_verified, show_explicit FROM users WHERE id = ?', [user.id]);
  return row
    ? { id: row.id, role: row.role, age_verified: !!row.age_verified, show_explicit: !!row.show_explicit }
    : null;
}

// Filename (under /img/designs/) to render for this viewer.
function displayImgFile(design, viewer, owned = false) {
  const rel = displayLinework(design, viewer, owned);
  return rel ? String(rel).split('/').pop() : '';
}

module.exports = { SENSITIVITIES, canViewUnblurred, displayLinework, viewerFor, displayImgFile };
