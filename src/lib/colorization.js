// Site colorization workflow for linework-only designer uploads.
//
// Flow:
//   1. Designer uploads linework with no color file -> designs.status =
//      'awaiting_color', color_source = 'none'. The piece is hidden from
//      every public listing (status is not 'approved') and from the public
//      portfolio page.
//   2. The owner is notified (on-site message + email) that a color version
//      needs creating. The assistant creates it in a work session.
//   3. Admin attaches the finished color file at /admin/colorization ->
//      status = 'pending_designer_approval'; the designer is notified.
//   4. In /artist/portfolio the designer clicks Approve or Request changes.
//      - Approve: color_source = 'site', status = 'pending' (back into the
//        normal admin approval flow, then live per its listing_scope).
//      - Request changes: status = 'awaiting_color' with the designer's
//        note stored in designs.colorization_note (visible in the admin
//        queue).
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
    `The piece stays hidden until the designer approves the color version and an admin approves the listing.`;
  const ownerId = await ownerUserId();
  if (ownerId) {
    await sendConversation({ userIds: [ownerId], subject, body, senderId: d.artist_id || ownerId });
  }
  if (config.adminEmail) {
    await sendMail({ to: config.adminEmail, subject, text: body });
  }
}

// Step 3: admin attaches the finished site-created color file.
async function attachColorVersion(designId, colorAbsPath) {
  const d = await db.get('SELECT * FROM designs WHERE id = ?', [designId]);
  if (!d) throw new Error('Design not found.');
  const rel = path.relative(config.assetDir, colorAbsPath);
  await db.update('designs', designId, {
    color_path: rel,
    colorization_note: '',
    status: 'pending_designer_approval',
  });
  const artist = await designerEmail(d.artist_id);
  const subject = `Your color version is ready for approval: "${d.title}"`;
  const body =
    `Good news — the color version of your piece "${d.title}" is ready!\n\n` +
    `Please take a look in your portfolio and either approve it or request changes:\n` +
    `${config.baseUrl}/artist/portfolio\n\n` +
    `Once you approve, it goes to the admin for final approval and then live. ` +
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

// Step 4a: designer approves the site-created color version.
async function designerApproveColor(designId, designerId) {
  const d = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [designId, designerId]);
  if (!d) throw new Error('Design not found.');
  if (d.status !== 'pending_designer_approval') throw new Error('This piece is not waiting for your approval.');
  await db.update('designs', designId, {
    color_source: 'site',
    colorization_note: '',
    status: 'pending',
  });
  return true;
}

// Step 4b: designer requests changes; back to the queue with their note.
async function designerRequestChanges(designId, designerId, note) {
  const d = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [designId, designerId]);
  if (!d) throw new Error('Design not found.');
  if (d.status !== 'pending_designer_approval') throw new Error('This piece is not waiting for your approval.');
  const cleanNote = String(note || '').trim().slice(0, 2000);
  if (!cleanNote) throw new Error('Please describe the changes you need.');
  await db.update('designs', designId, {
    status: 'awaiting_color',
    colorization_note: cleanNote,
  });
  const ownerId = await ownerUserId();
  const subject = `Color changes requested: "${d.title}"`;
  const body =
    `The designer requested changes to the color version of "${d.title}":\n\n` +
    `"${cleanNote}"\n\n` +
    `Review it in the colorization queue: ${config.baseUrl}/admin/colorization`;
  if (ownerId) await sendConversation({ userIds: [ownerId], subject, body, senderId: d.artist_id || ownerId });
  if (config.adminEmail) await sendMail({ to: config.adminEmail, subject, text: body });
  return true;
}

// Queue rows for /admin/colorization.
async function colorizationQueue() {
  return db.all(
    `SELECT d.*, u.email AS artist_email, u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.status IN ('awaiting_color', 'pending_designer_approval')
     ORDER BY d.created_at ASC`);
}

module.exports = {
  notifyColorizationNeeded,
  attachColorVersion,
  designerApproveColor,
  designerRequestChanges,
  colorizationQueue,
  sendConversation,
};
