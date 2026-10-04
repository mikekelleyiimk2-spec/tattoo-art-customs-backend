// Slow-day blasts + client reactivation (shop toolset expansion, F5/F6).
//
// Blasts: one-tap push/email to past clients ("chairs open Friday"). Max 2
// per rolling 7 days per shop; never SMS.
// Reactivation: daily sweeper nudges lapsed clients (no booking in
// reactivation_lapse_days, default 180) with the shop's booking link. Dedup
// via the notifications table — no new tables.
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('../lib/notify');
const { pushToUser } = require('../lib/push');
const { sendMail } = require('../lib/mail');
const { getBookingSettings } = require('./bookingFlow');

const DAY_MS = 86400000;
const BLAST_MAX_CHARS = 280;
const BLAST_WINDOW_MS = 7 * DAY_MS;
const BLAST_MAX_PER_WINDOW = 2;

async function pastClients(shopUserId, sinceMs) {
  return db.all(
    `SELECT DISTINCT b.customer_user_id AS id, u.email, u.display_name AS name
     FROM bookings b JOIN users u ON u.id = b.customer_user_id
     WHERE b.shop_user_id = ? AND b.status = 'completed' AND b.completed_at >= ?`,
    [String(shopUserId), sinceMs]);
}

async function recentBlastCount(shopUserId, now = Date.now()) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM shop_blasts WHERE shop_user_id = ? AND sent_at >= ?',
    [String(shopUserId), now - BLAST_WINDOW_MS]);
  return Number((row && row.n) || 0);
}

// One-tap blast. Throws on rate limit / empty audience / bad input.
async function sendBlast(shopUserId, message) {
  message = String(message || '').trim().slice(0, BLAST_MAX_CHARS);
  if (message.length < 10) throw new Error('Write a short message first (min 10 characters).');
  if (await recentBlastCount(shopUserId) >= BLAST_MAX_PER_WINDOW) {
    throw new Error('Blast limit reached — 2 per 7 days. Try again later.');
  }
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [String(shopUserId)]);
  const shopName = (shop && shop.display_name) || 'the shop';
  const audience = await pastClients(String(shopUserId), Date.now() - 365 * DAY_MS);
  if (!audience.length) throw new Error('No past clients to reach yet — blasts go to clients with a completed booking in the last year.');
  const title = `${shopName} has chairs open!`;
  const bookLink = `/bookings/shop/${shopUserId}`;
  let sent = 0;
  for (const person of audience) {
    try {
      await notifyUser(person.id, { kind: 'shop-blast', title, body: message, link: bookLink });
      try { await pushToUser(person.id, { title, body: message, url: bookLink }); } catch (_) { /* best-effort */ }
      if (person.email) {
        await sendMail({
          to: person.email,
          subject: title,
          text: `Hi ${person.name || 'there'},\n\n${message}\n\nBook here: ${config.baseUrl}${bookLink}\n\n— Tattoo Art Customs`,
        });
      }
      sent += 1;
    } catch (e) { console.error('blast send failed:', e.message); }
  }
  await db.insert('shop_blasts', {
    shop_user_id: String(shopUserId), message, audience: 'past_clients',
    recipient_count: sent, status: 'sent', sent_at: Date.now(),
  });
  return { sent };
}

async function getBlastsForShop(shopUserId, limit = 20) {
  return db.all(
    'SELECT * FROM shop_blasts WHERE shop_user_id = ? ORDER BY sent_at DESC LIMIT ?',
    [String(shopUserId), Number(limit)]);
}

// --- Reactivation -----------------------------------------------------------
// Daily sweeper. For each shop with reactivation on: customers whose most
// recent completed booking is older than lapse_days, with nothing booked
// since, and no reactivation-nudge in the last 90 days.
async function runReactivationSweep(now = Date.now()) {
  const shops = await db.all(
    `SELECT s.shop_user_id, COALESCE(s.reactivation_lapse_days, 180) AS lapse_days
     FROM shop_booking_settings s
     WHERE COALESCE(s.reactivation_enabled, 1) = 1`);
  let nudged = 0;
  for (const shop of shops) {
    try {
      const lapseMs = Math.max(30, Math.min(730, Number(shop.lapse_days) || 180)) * DAY_MS;
      const candidates = await db.all(
        `SELECT b.customer_user_id AS id, u.email, u.display_name AS name,
                MAX(b.completed_at) AS last_completed
         FROM bookings b JOIN users u ON u.id = b.customer_user_id
         WHERE b.shop_user_id = ? AND b.status = 'completed'
         GROUP BY b.customer_user_id
         HAVING MAX(b.completed_at) <= ?`,
        [shop.shop_user_id, now - lapseMs]);
      for (const c of candidates) {
        const newer = await db.get(
          `SELECT id FROM bookings WHERE shop_user_id = ? AND customer_user_id = ?
           AND created_at > ? AND status NOT IN ('cancelled', 'expired') LIMIT 1`,
          [shop.shop_user_id, c.id, c.last_completed]);
        if (newer) continue;
        const recentlyNudged = await db.get(
          `SELECT id FROM notifications WHERE user_id = ? AND kind = 'reactivation-nudge'
           AND created_at >= ? LIMIT 1`, [c.id, now - 90 * DAY_MS]);
        if (recentlyNudged) continue;
        const s = await db.get('SELECT display_name FROM users WHERE id = ?', [shop.shop_user_id]);
        const shopName = (s && s.display_name) || 'your shop';
        const link = `/bookings/shop/${shop.shop_user_id}`;
        const title = `${shopName} misses you!`;
        const body = `It's been a while since your last session at ${shopName}. Ready for the next one?`;
        await notifyUser(c.id, { kind: 'reactivation-nudge', title, body, link });
        try { await pushToUser(c.id, { title, body, url: link }); } catch (_) { /* best-effort */ }
        if (c.email) {
          await sendMail({
            to: c.email, subject: title,
            text: `Hi ${c.name || 'there'},\n\n${body}\n\nBook here: ${config.baseUrl}${link}\n\n— Tattoo Art Customs`,
          });
        }
        nudged += 1;
      }
    } catch (e) { console.error('reactivation sweep failed for shop', shop.shop_user_id, e.message); }
  }
  return nudged;
}

async function reactivationStats(shopUserId, days = 30) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE kind = 'reactivation-nudge' AND created_at >= ?
     AND link = ?`,
    [Date.now() - days * DAY_MS, `/bookings/shop/${shopUserId}`]);
  return Number((row && row.n) || 0);
}

module.exports = {
  sendBlast, getBlastsForShop, recentBlastCount,
  runReactivationSweep, reactivationStats, BLAST_MAX_CHARS,
};
