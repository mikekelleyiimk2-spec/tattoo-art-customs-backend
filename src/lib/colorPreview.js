'use strict';
// Watermarked finished-color preview pipeline (Approval Batch #1 item 16,
// 2026-10-26).
//
// RULE (standing): finished color is NEVER shown publicly unwatermarked.
// The clean color file (designs.color_path) is a purchase deliverable,
// served only through time-limited buyer downloads. What the public may
// see is a watermarked derivative — designs.color_wm_path — produced by
// the SAME watermark pipeline as the linework previews (lib/watermark.js
// applyWatermarkedColor: site texture passes + solid-black anti-trace
// marks, per-design seeded placement, 1600px cap), stored the house way
// under UPLOAD_DIR/designs/color-wm/ and served at /img/designs/color/.
//
// GENERATION TRIGGERS:
//   - designer upload with a color file (lib/portfolioUpload.js)
//   - admin attaches a color version (lib/colorization.js attachColorVersion)
//   - backfill for the existing catalog: scripts/backfill-color-previews.js
// Generation is best-effort everywhere: a failure logs and leaves
// color_wm_path empty (the design simply doesn't feature) — it never
// blocks an upload or an approval.
//
// FEATURED ROW SELECTION (the gallery's "Featured in color" row):
//   Approved, gallery-listed, non-members-only designs that HAVE a
//   watermarked color preview, excluding explicit-sensitivity pieces,
//   ordered by public heart count (design_like_counts) DESC, ties broken
//   by newest first, capped at FEATURED_LIMIT. There is no manual pick
//   list yet — the owner makes taste picks later. To change what
//   features today: hearts move designs up and down on their own; a
//   design leaves the row when its preview is withdrawn (clear
//   designs.color_wm_path / delete the derivative) and enters it the
//   moment a preview is generated for it.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const storage = require('./storage');
const { applyWatermarkedColor } = require('./watermark');

const FEATURED_LIMIT = 12;

// Resolve a design's clean color file to a local absolute path we can
// feed to sharp. Local stored paths resolve directly; r2:// refs are
// fetched through a short-lived presigned URL into a temp file (the
// caller deletes it via the returned cleanup). Returns null when the
// bytes are not reachable from here.
async function colorSourceAbs(design) {
  const stored = design && design.color_path ? String(design.color_path) : '';
  if (!stored) return null;
  if (storage.isR2Ref(stored)) {
    if (!storage.r2Configured()) return null;
    try {
      const url = await storage.presignGet(stored, { expiresIn: 300 });
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const tmpDir = path.join(config.uploadDir, 'tmp-color-preview');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `${design.id}-${Date.now()}.img`);
      fs.writeFileSync(tmp, buf);
      return { abs: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* gone */ } } };
    } catch (e) {
      console.error('color preview source fetch failed for', design.id, e.message);
      return null;
    }
  }
  if (storage.isHttpUrl(stored)) return null; // external URL — not ours to republish
  const abs = storage.resolveStoredPath(stored);
  return abs ? { abs, cleanup: () => {} } : null;
}

// Generate (or regenerate) the watermarked color preview for one design
// and record it on designs.color_wm_path. Returns the stored relative
// path, or null when the design has no reachable color file.
async function generateColorPreview(designId) {
  const design = await db.get('SELECT id, color_path FROM designs WHERE id = ?', [designId]);
  if (!design || !design.color_path) return null;
  const src = await colorSourceAbs(design);
  if (!src) return null;
  try {
    const rel = await applyWatermarkedColor({ designId: design.id, colorAbs: src.abs, choice: 'site' });
    await db.update('designs', design.id, { color_wm_path: rel });
    return rel;
  } finally {
    src.cleanup();
  }
}

// The gallery featured row's picks — see the selection rule in the header.
async function featuredColorDesigns(limit = FEATURED_LIMIT) {
  const rows = await db.all(
    `SELECT d.id, d.title, d.color_wm_path,
            COALESCE(c.like_count, 0) AS like_count
     FROM designs d LEFT JOIN design_like_counts c ON c.design_id = d.id
     WHERE d.status = 'approved' AND d.listing_scope = 'gallery'
       AND d.members_only = 0
       AND d.color_wm_path IS NOT NULL AND d.color_wm_path <> ''
       AND (d.sensitivity IS NULL OR d.sensitivity <> 'explicit')
     ORDER BY COALESCE(c.like_count, 0) DESC, d.created_at DESC
     LIMIT ?`, [limit]);
  return rows.map((r) => ({
    ...r,
    // Basename only — the view builds /img/designs/color/<file> and the
    // /img/designs/thumb/<file> grid derivative from it. The clean color
    // filename never reaches the page.
    colorFile: String(r.color_wm_path).split('/').pop(),
  }));
}

module.exports = { generateColorPreview, featuredColorDesigns, FEATURED_LIMIT };
