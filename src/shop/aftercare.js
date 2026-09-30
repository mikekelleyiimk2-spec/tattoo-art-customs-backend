// Aftercare autopilot + review machine (shop toolset expansion, F3/F4).
//
// completeBooking -> scheduleAftercare(bookingId) creates day-3/7/14 check-in
// rows. runAftercareSweep() (hourly cron) sends due check-ins (push + in-app
// + email) with a one-tap response page and a healed-photo upload. A 'great'
// response triggers the review machine: the shop's Google review link, asked
// exactly once per booking and never after a concern.
//
// Dedup: the notifications table is the sent-log (kind aftercare-day3/7/14,
// link /toolkit/aftercare/r/<id>), same pattern as bookingReminders.js.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('../lib/notify');
const { pushToUser } = require('../lib/push');
const { sendMail } = require('../lib/mail');

const DAY_MS = 86400000;
const HEALED_DIR = 'uploads/healed'; // relative to config.assetDir
const KINDS = [
  { kind: 'day3', afterMs: 3 * DAY_MS, label: 'Day 3' },
  { kind: 'day7', afterMs: 7 * DAY_MS, label: 'Day 7' },
  { kind: 'day14', afterMs: 14 * DAY_MS, label: 'Day 14' },
];

function fmtDate(ms) {
  return new Date(Number(ms)).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
  });
}

function renderTemplate(bodyMd, { shopName, customerName }) {
  return String(bodyMd || '')
    .replace(/\{\{\s*shop_name\s*\}\}/gi, shopName || 'the shop')
    .replace(/\{\{\s*customer_name\s*\}\}/gi, customerName || 'there');
}

async function defaultTemplate(shopUserId) {
  return {
    title: 'Standard aftercare',
    body_md: [
      'Hi {{customer_name}}! This is your aftercare guide from {{shop_name}}.',
      '',
      '• Keep the wrap on for the time your artist told you, then wash gently with fragrance-free soap.',
      '• Apply a thin layer of the recommended ointment 2–3x daily.',
      '• No soaking (baths, pools, hot tubs) for 2 weeks. No direct sun.',
      '• Don’t pick or scratch flaking skin — let it shed naturally.',
      '• Worried about redness, swelling, or heat? Message the shop right away.',
      '',
      'We’ll check in on your healing over the next two weeks.',
    ].join('\n'),
  };
}

async function getActiveTemplate(shopUserId) {
  const tpl = await db.get(
    'SELECT * FROM shop_aftercare_templates WHERE shop_user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
    [String(shopUserId)]);
  if (tpl) return tpl;
  const d = await defaultTemplate(shopUserId);
  return { ...d, shop_user_id: String(shopUserId), active: 1 };
}

// --- Templates (shop) -------------------------------------------------------
async function saveTemplate(shopUserId, { title, bodyMd }) {
  title = String(title || '').trim().slice(0, 120) || 'Aftercare guide';
  bodyMd = String(bodyMd || '').trim().slice(0, 10000);
  if (bodyMd.length < 20) throw new Error('The guide is too short.');
  await db.query('UPDATE shop_aftercare_templates SET active = 0 WHERE shop_user_id = ?', [String(shopUserId)]);
  return db.insert('shop_aftercare_templates', {
    shop_user_id: String(shopUserId), title, body_md: bodyMd, active: 1,
  });
}

async function getCheckinsForShop(shopUserId, limit = 100) {
  return db.all(
    `SELECT ac.*, u.display_name AS customer_name
     FROM aftercare_checkins ac JOIN users u ON u.id = ac.customer_user_id
     WHERE ac.shop_user_id = ? ORDER BY ac.due_at DESC LIMIT ?`,
    [String(shopUserId), Number(limit)]);
}

// --- Scheduling -------------------------------------------------------------
async function scheduleAftercare(bookingId) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [String(bookingId)]);
  if (!booking || booking.status !== 'completed') return [];
  const base = Number(booking.completed_at) || Date.now();
  const ids = [];
  for (const k of KINDS) {
    const dupe = await db.get(
      'SELECT id FROM aftercare_checkins WHERE booking_id = ? AND kind = ? LIMIT 1',
      [booking.id, k.kind]);
    if (dupe) { ids.push(dupe.id); continue; }
    ids.push(await db.insert('aftercare_checkins', {
      booking_id: booking.id, shop_user_id: booking.shop_user_id,
      customer_user_id: booking.customer_user_id,
      kind: k.kind, due_at: base + k.afterMs, status: 'pending',
    }));
  }
  return ids;
}

async function reminderSent(userId, kind, link) {
  const hit = await db.get(
    'SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND link = ? LIMIT 1',
    [userId, kind, link]);
  return !!hit;
}

// --- Sweeper ----------------------------------------------------------------
async function runAftercareSweep(now = Date.now()) {
  const due = await db.all(
    `SELECT ac.*, s.display_name AS shop_name, c.email AS customer_email,
            c.display_name AS customer_name
     FROM aftercare_checkins ac
     JOIN users s ON s.id = ac.shop_user_id
     JOIN users c ON c.id = ac.customer_user_id
     WHERE ac.status = 'pending' AND ac.due_at <= ?
     ORDER BY ac.due_at ASC LIMIT 200`, [now]);
  let sent = 0;
  for (const ac of due) {
    try {
      const kind = `aftercare-${ac.kind}`;
      const link = `/toolkit/aftercare/r/${ac.id}`;
      if (await reminderSent(ac.customer_user_id, kind, link)) {
        await db.update('aftercare_checkins', ac.id, { status: 'sent' });
        continue;
      }
      const tpl = await getActiveTemplate(ac.shop_user_id);
      const label = (KINDS.find((k) => k.kind === ac.kind) || {}).label || ac.kind);
      const title = `${label} healing check-in — ${ac.shop_name}`;
      const body = `How's your tattoo healing? Tap to let ${ac.shop_name} know — it takes 10 seconds.`;
      await notifyUser(ac.customer_user_id, { kind, title, body, link });
      try { await pushToUser(ac.customer_user_id, { title, body, url: link }); } catch (_) { /* best-effort */ }
      if (ac.customer_email) {
        const guide = renderTemplate(tpl.body_md, { shopName: ac.shop_name, customerName: ac.customer_name });
        await sendMail({
          to: ac.customer_email,
          subject: title,
          text: `Hi ${ac.customer_name || 'there'},\n\n${body}\n\nRespond here: ${config.baseUrl}${link}\n\n---\n${tpl.title} — ${ac.shop_name}\n${guide}\n\n— Tattoo Art Customs`,
        });
      }
      await db.update('aftercare_checkins', ac.id, { status: 'sent' });
      sent += 1;
    } catch (e) { console.error('aftercare sweep failed for', due && due.id, e.message); }
  }
  return sent;
}

// --- Customer response ------------------------------------------------------
async function respondToCheckin({ checkinId, customerUserId, response }) {
  if (!['great', 'ok', 'concern'].includes(response)) throw new Error('Invalid response.');
  const ac = await db.get('SELECT * FROM aftercare_checkins WHERE id = ?', [String(checkinId)]);
  if (!ac || String(ac.customer_user_id) !== String(customerUserId)) throw new Error('Check-in not found.');
  await db.update('aftercare_checkins', ac.id, { status: 'responded', response });
  if (response === 'concern') {
    // Route healing concerns straight to the shop — fast human follow-up.
    const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [String(customerUserId)]);
    await notifyUser(ac.shop_user_id, {
      kind: 'aftercare-concern', title: 'Healing concern reported',
      body: `${(customer && customer.display_name) || 'A client'} reported a healing concern on their ${ac.kind} check-in. Reach out to them.`,
      link: '/toolkit/aftercare',
    });
    return { response, reviewAsked: false };
  }
  let reviewAsked = false;
  if (response === 'great') {
    reviewAsked = await maybeAskReview(ac);
  }
  return { response, reviewAsked };
}

// F4: review machine. Fires only on 'great', only with a configured URL,
// only once per booking ever.
async function maybeAskReview(ac) {
  const settings = await db.get('SELECT * FROM shop_review_settings WHERE shop_user_id = ?', [ac.shop_user_id]);
  if (!settings || Number(settings.enabled) !== 1 || !settings.google_review_url) return false;
  const already = await db.get(
    'SELECT id FROM aftercare_checkins WHERE booking_id = ? AND review_requested_at IS NOT NULL LIMIT 1',
    [ac.booking_id]);
  if (already) return false;
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [ac.shop_user_id]);
  const customer = await db.get('SELECT display_name, email FROM users WHERE id = ?', [ac.customer_user_id]);
  const shopName = (shop && shop.display_name) || 'the shop';
  const title = `Loving your new ink? Review ${shopName}`;
  const body = `Glad it's healing great! A quick Google review helps ${shopName} more than you know.`;
  await notifyUser(ac.customer_user_id, {
    kind: 'review-ask', title, body, link: settings.google_review_url,
  });
  try { await pushToUser(ac.customer_user_id, { title, body, url: settings.google_review_url }); } catch (_) { /* best-effort */ }
  if (customer && customer.email) {
    await sendMail({
      to: customer.email,
      subject: title,
      text: `Hi ${customer.display_name || 'there'},\n\n${body}\n\nLeave your review here: ${settings.google_review_url}\n\n— Tattoo Art Customs`,
    });
  }
  await db.update('aftercare_checkins', ac.id, { review_requested_at: Date.now() });
  return true;
}

async function saveReviewSettings(shopUserId, { googleReviewUrl, enabled }) {
  const url = String(googleReviewUrl || '').trim().slice(0, 500);
  if (url && !/^https:\/\//.test(url)) throw new Error('Review URL must start with https://');
  const existing = await db.get('SELECT shop_user_id FROM shop_review_settings WHERE shop_user_id = ?', [String(shopUserId)]);
  const row = { google_review_url: url || null, enabled: enabled ? 1 : 0 };
  if (existing) await db.query('UPDATE shop_review_settings SET google_review_url = ?, enabled = ? WHERE shop_user_id = ?', [row.google_review_url, row.enabled, String(shopUserId)]);
  else await db.query('INSERT INTO shop_review_settings (shop_user_id, google_review_url, enabled) VALUES (?, ?, ?)', [String(shopUserId), row.google_review_url, row.enabled]);
  return db.get('SELECT * FROM shop_review_settings WHERE shop_user_id = ?', [String(shopUserId)]);
}

async function getReviewSettings(shopUserId) {
  return db.get('SELECT * FROM shop_review_settings WHERE shop_user_id = ?', [String(shopUserId)]);
}

// --- Healed photos ----------------------------------------------------------
function healedAbsDir() {
  const dir = path.join(config.assetDir, HEALED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveHealedPhoto({ checkinId, customerUserId, file, consentToPost }) {
  const ac = await db.get('SELECT * FROM aftercare_checkins WHERE id = ?', [String(checkinId)]);
  if (!ac || String(ac.customer_user_id) !== String(customerUserId)) throw new Error('Check-in not found.');
  if (!file) throw new Error('No photo uploaded.');
  const dir = healedAbsDir();
  const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
  const name = `${ac.booking_id}-${ac.kind}-${Date.now()}${ext}`;
  fs.renameSync(file.path, path.join(dir, name));
  const id = await db.insert('healed_photos', {
    checkin_id: ac.id, shop_user_id: ac.shop_user_id,
    customer_user_id: String(customerUserId),
    image_path: path.join(HEALED_DIR, name),
    consent_to_post: consentToPost ? 1 : 0, posted_to_wall: 0,
  });
  await db.update('aftercare_checkins', ac.id, { healed_photo_requested: 1, status: 'responded', response: ac.response || 'ok' });
  await notifyUser(ac.shop_user_id, {
    kind: 'healed-photo', title: 'Healed photo received',
    body: 'A client sent a healed photo — review it for the healed wall.',
    link: '/toolkit/aftercare',
  });
  return id;
}

async function getHealedPhotosForShop(shopUserId, { onlyConsented = false } = {}) {
  return db.all(
    `SELECT hp.*, u.display_name AS customer_name FROM healed_photos hp
     JOIN users u ON u.id = hp.customer_user_id
     WHERE hp.shop_user_id = ? ${onlyConsented ? 'AND hp.consent_to_post = 1' : ''}
     ORDER BY hp.created_at DESC LIMIT 100`,
    [String(shopUserId)]);
}

module.exports = {
  getActiveTemplate, saveTemplate, getCheckinsForShop,
  scheduleAftercare, runAftercareSweep, respondToCheckin,
  saveReviewSettings, getReviewSettings,
  saveHealedPhoto, getHealedPhotosForShop,
};
