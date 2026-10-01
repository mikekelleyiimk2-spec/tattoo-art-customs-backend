// Site colorization workflow for linework-only designer uploads.
//
// Flow (2026-09-28, revised: linework-only pieces are approvable immediately):
//   1. Designer uploads linework with no color file -> designs.status =
//      'pending' (normal approval flow — the piece posts with its
//      watermarked linework), color_source = 'none', color_pending = 1.
//   2. The owner is notified (on-site message + email) that a color version
//      needs creating. The assistant creates it in a work session.
//   3. An admin attaches the finished color file at /admin/colorization ->
//      color_source = 'site', color_pending = 0. The piece keeps whatever
//      approval status it has (pending/approved/live) — attaching the color
//      IS the administrator approval of the color version.
//   4. When the design goes live, the designer is notified (informational).
//
// The site-created color version is a PURCHASE DELIVERABLE ONLY: it is never
// added to the designer's portfolio, never publicly listed, and never
// watermarked for display. After purchase it is delivered with the clean
// linework exactly like any other color version.
const path = require('path');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');
const { ownerUserId } = require('./commissions');

async function sendConversation({ userIds, subject, body, senderId, now = Date.now() }) {
  if (!senderId) throw new Error('sendConversation requires a senderId.');
  const convId = await db.insert('conversations', { subject, created_at: now });
  for (const uid of userIds) {
    if (uid) await db.insert('conversation_participants', { conversation_id: convId, user_id: uid });
  }
  await db.insert('messages', {
    conversation_id: convId, sender_id: senderId,
    body, screened: 0, flags: '[]', created_at: now,
  });
  return convId;
}

async function designerEmail(designerId) {
  const u = await db.get('SELECT email, display_name FROM users WHERE id = ?', [designerId]);
  return u || null;
}

// Step 2: tell the owner a color version needs creating.
async function notifyColorizationNeeded(designId) {
  const d = await db.get(
    `SELECT d.title, d.artist_id, u.display_name AS artist_name FROM designs d
     LEFT JOIN users u ON u.id = d.artist_id WHERE d.id = ?`, [designId]);
  if (!d) return;
  const subject = `Color version needed: "${d.title}"`;
  const body =
    `A designer uploaded linework with no color version, so a color version needs creating.\n\n` +
    `Piece: "${d.title}" by ${d.artist_name || 'a designer'}\n` +
    `Once the color version is ready, attach it in the admin colorization queue: ${config.baseUrl}/admin/colorization\n\n` +
    `The piece itself goes through the normal approval flow and may already be live with its linework — ` +
    `the color version is a purchase deliverable.`;
  const ownerId = await ownerUserId();
  if (ownerId) {
    await sendConversation({ userIds: [ownerId], subject, body, senderId: d.artist_id || ownerId });
  }
  if (config.adminEmail) {
    await sendMail({ to: config.adminEmail, subject, text: body });
  }
}

// Step 3: admin attaches the finished site-created color file. Attaching IS
// the administrator approval of the color version — the piece keeps whatever
// approval status it has (it may already be live with its linework). The
// designer is notified for information only — there is no approval gate on
// their side.
async function attachColorVersion(designId, colorAbsPath) {
  const d = await db.get('SELECT * FROM designs WHERE id = ?', [designId]);
  if (!d) throw new Error('Design not found.');
  const rel = path.relative(config.uploadDir, colorAbsPath);
  await db.update('designs', designId, {
    color_path: rel,
    color_source: 'site',
    color_pending: 0,
    colorization_note: '',
  });
  const artist = await designerEmail(d.artist_id);
  const subject = `Your piece was colorized: "${d.title}"`;
  const body =
    `Good news — our team created the color version of your piece "${d.title}".\n\n` +
    `The color version is delivered to buyers with your linework after purchase — ` +
    `it is never shown publicly or added to your portfolio as its own piece.\n\n` +
    `Warmly,\nTattoo Art Customs`;
  const ownerId = await ownerUserId();
  if (d.artist_id) await sendConversation({
    userIds: [d.artist_id], subject, body, senderId: ownerId || d.artist_id,
  });
  if (artist && artist.email) await sendMail({ to: artist.email, subject, text: body });
  return rel;
}

// Step 5: called when the design goes live — informational only.
// decidedBy names who approved (admin display name, or the automatic rule).
async function notifyDesignLive(designId, decidedBy = '') {
  const d = await db.get(
    `SELECT d.title, d.artist_id, d.color_source, u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id WHERE d.id = ?`, [designId]);
  if (!d || !d.artist_id) return;
  const subject = `Your piece is live: "${d.title}"`;
  const body =
    `Your piece "${d.title}" is now live${d.color_source === 'site' ? ' with the site-created color version' : ''}.` +
    (decidedBy ? ` Approved by: ${decidedBy}.` : '') + `\n\n` +
    `View it in your portfolio: ${config.baseUrl}/artist/portfolio\n\n` +
    `Warmly,\nTattoo Art Customs`;
  const { notifyUser } = require('./notify');
  await notifyUser(d.artist_id, { kind: 'design_approved', title: subject, body, link: '/artist/portfolio' });
  const ownerId = await ownerUserId();
  await sendConversation({ userIds: [d.artist_id], subject, body, senderId: ownerId || d.artist_id });
  const artist = await designerEmail(d.artist_id);
  if (artist && artist.email) await sendMail({ to: artist.email, subject, text: body });
}

// Queue rows for /admin/colorization: linework-only pieces still waiting on
// their site-created color version.
async function colorizationQueue() {
  return db.all(
    `SELECT d.*, u.email AS artist_email, u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.color_pending = 1
     ORDER BY d.created_at ASC`);
}

module.exports = {
  notifyColorizationNeeded,
  attachColorVersion,
  notifyDesignLive,
  colorizationQueue,
  sendConversation,
};
