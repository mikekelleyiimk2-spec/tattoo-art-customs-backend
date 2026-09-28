// In-app + email notifications.
//
// notifyUser(userId, {kind, title, body, link}) — writes a notifications row;
// best-effort (never throws).
// notifyAdmins({kind, title, body, link, emailSubject, emailText}) — notifies
// EVERY admin/head_admin: in-app notification each + one email per admin
// address. Any admin may then act on the item (approve/reject/hold).
const db = require('../db');
const { sendMail } = require('./mail');

async function notifyUser(userId, { kind = '', title = '', body = '', link = '' } = {}) {
  if (!userId || !title) return null;
  try {
    return await db.insert('notifications', {
      user_id: userId, kind, title, body, link, created_at: db.now(),
    });
  } catch (e) {
    console.error('notifyUser failed:', e.message);
    return null;
  }
}

async function adminUsers() {
  try {
    return await db.all(
      "SELECT id, email, role FROM users WHERE role IN ('admin', 'head_admin')"
    );
  } catch (e) {
    console.error('adminUsers failed:', e.message);
    return [];
  }
}

async function notifyAdmins({ kind = '', title = '', body = '', link = '', emailSubject = '', emailText = '' } = {}) {
  const admins = await adminUsers();
  for (const a of admins) {
    await notifyUser(a.id, { kind, title, body, link });
    if (a.email && emailSubject) {
      try {
        await sendMail({ to: a.email, subject: emailSubject, text: emailText || body });
      } catch (e) {
        console.error('notifyAdmins email failed:', e.message);
      }
    }
  }
  // Push notifications to all admins (Web Push on the site + Expo push in the
  // app) — owner standing order: admins get pushed whenever a design approval
  // is submitted or needs their decision.
  try {
    const { pushToAdmins } = require('./push');
    await pushToAdmins({ title, body, url: link || '/admin' });
  } catch (e) {
    console.error('notifyAdmins push failed:', e.message);
  }
  return admins.length;
}

async function unreadCount(userId) {
  if (!userId) return 0;
  try {
    const r = await db.get(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
    return (r && r.n) || 0;
  } catch (e) { return 0; }
}

module.exports = { notifyUser, notifyAdmins, adminUsers, unreadCount };
