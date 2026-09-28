// 2-hour designer-approval SLA escalation (owner standing order):
// "Art must enter the designer's portfolio within 2 hours, or the artist
// must receive a rejection reason."
//
// - Ordinary 'pending' designs are already auto-approved at ~1h by
//   autoApprove.js, so a 'pending' design still alive at 2h means something
//   blocked it (e.g. no watermarked linework) — escalate to all admins.
// - 'flagged' (contact info) and 'on_hold' (hateful content) are NEVER
//   auto-approved; only a personal admin decision resolves them. At 2h the
//   artist gets a "still under review" notice and ALL admins are re-notified
//   until they decide (at most once every 24h per design).
const db = require('../db');
const config = require('../config');
const { notifyUser, notifyAdmins } = require('./notify');

const TWO_HOURS_MS = 2 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

async function escalateOverdueDesigns() {
  let rows = [];
  try {
    rows = await db.all(
      `SELECT d.id, d.title, d.status, d.artist_id, d.created_at, d.sla_escalated_at
       FROM designs d
       WHERE d.status IN ('pending', 'flagged', 'on_hold')
         AND d.created_at <= ?
         AND (d.sla_escalated_at IS NULL OR d.sla_escalated_at <= ?)`,
      [db.now() - TWO_HOURS_MS, db.now() - DAY_MS]);
  } catch (e) {
    console.error('[contentSla] query failed:', e.message);
    return { escalated: [] };
  }
  const escalated = [];
  for (const d of rows) {
    const ageH = Math.round((db.now() - Number(d.created_at)) / 3600000);
    const kind = d.status === 'pending' ? 'stuck pending' : (d.status === 'flagged' ? 'flagged' : 'on hold');
    try {
      // All admins get the escalation (in-app + email).
      await notifyAdmins({
        kind: 'design_sla_escalation',
        title: `ESCALATION: "${d.title || 'untitled'}" ${kind} for ${ageH}h — decision required`,
        body:
          `The piece "${d.title || 'untitled'}" has been ${kind} for ${ageH} hours with no admin decision.\n\n` +
          `Status: ${d.status}. ${d.status === 'pending'
            ? 'It was not auto-approved — it may be missing its watermarked linework. Fix or reject it with a reason.'
            : 'Only a personal admin approval or rejection resolves it — it is never auto-approved.'}\n\n` +
          `Review it: ${config.baseUrl}/admin/designs`,
        link: '/admin/designs',
        emailSubject: `[Tattoo Art Customs] ESCALATION — decision needed: "${d.title || 'untitled'}" (${d.status}, ${ageH}h)`,
        emailText:
          `The piece "${d.title || 'untitled'}" has been ${kind} for ${ageH} hours with no admin decision.\n\n` +
          `Status: ${d.status}. Only a personal admin decision resolves it.\n\n` +
          `Review it: ${config.baseUrl}/admin/designs`,
      });
      // The artist gets the required 2h notice: decision or still-under-review.
      if (d.artist_id) {
        const body = d.status === 'flagged' || d.status === 'on_hold'
          ? `Your piece "${d.title || 'untitled'}" is still under admin review (${ageH}h). An administrator will personally approve or reject it — we will notify you with the decision and, if rejected, the reason. No action needed from you.`
          : `Your piece "${d.title || 'untitled'}" could not be posted automatically (${ageH}h). An administrator is now reviewing it and you will hear back with a decision or a rejection reason.`;
        await notifyUser(d.artist_id, {
          kind: 'design_sla_notice', title: 'Your piece is still being reviewed', body,
          link: '/artist/portfolio',
        });
      }
      await db.update('designs', d.id, { sla_escalated_at: db.now() });
      escalated.push(d.id);
    } catch (e) {
      console.error('[contentSla] escalation failed for', d.id, e.message);
    }
  }
  return { escalated };
}

module.exports = { escalateOverdueDesigns };
