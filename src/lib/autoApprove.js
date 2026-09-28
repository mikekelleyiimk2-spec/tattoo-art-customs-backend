// 1-hour auto-approval for designer uploads.
//
// Standing rule (owner, 2026-09-28): if a designer's pending piece has not
// been personally approved by an admin within one hour of upload, the system
// approves it automatically. This keeps the gallery moving while the owner
// is away; every auto-approval is stamped approved_by='auto:1h-no-admin-action'
// so it is auditable on the admin designs list.
//
// Safety gates (same as the manual approve path):
// - Only status='pending' designs qualify. 'flagged' (contact info detected),
//   'on_hold' (admin-only review), 'rejected', 'approved', and 'sold' are
//   NEVER auto-approved. Linework-only pieces enter the normal flow as
//   'pending' (their site color version follows via color_pending), so they
//   are approvable like any other piece.
// - A design CANNOT go live without its watermarked linework — the public
//   gallery must never show clean color or clean linework. Missing watermark
//   => skipped and reported, not approved.
const db = require('../db');

const AUTO_APPROVER = 'auto:1h-no-admin-action';
const ONE_HOUR_MS = 3600 * 1000;

async function autoApproveStaleDesigns() {
  const cutoff = Date.now() - ONE_HOUR_MS;
  const stale = await db.all(
    "SELECT id, linework_wm_path FROM designs WHERE status = 'pending' AND created_at <= ?",
    [cutoff]
  );
  const approved = [];
  const blocked = [];
  for (const d of stale) {
    if (!d.linework_wm_path) {
      blocked.push(d.id); // watermark missing — same gate as manual approval
      continue;
    }
    await db.update('designs', d.id, { status: 'approved', approved_by: AUTO_APPROVER });
    try {
      const { completeOnApproval } = require('./replacements');
      await completeOnApproval(d.id); // remake of a sold custom piece → close the request
    } catch (e) { /* non-remake designs have nothing to close */ }
    try {
      const { notifyDesignLive } = require('./colorization');
      await notifyDesignLive(d.id, 'automatic approval (1-hour rule — no admin reviewed it in time)');
    } catch (e) { /* notification is best-effort */ }
    approved.push(d.id);
  }
  return { approved, blocked };
}

module.exports = { autoApproveStaleDesigns, AUTO_APPROVER, ONE_HOUR_MS };
