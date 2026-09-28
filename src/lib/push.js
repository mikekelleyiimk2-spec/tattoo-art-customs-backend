// Push notifications to admins (and users): Web Push (site, any device) +
// Expo push (native app). VAPID keys come from VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY env vars; if absent they are generated once and persisted
// in the settings table so push works with zero manual setup.
const db = require('../db');
const config = require('../config');

// In the test suite (NODE_ENV=test) no real network happens: push attempts
// are recorded in sentLog so tests can assert who would have been pushed.
const sentLog = [];
const isTest = process.env.NODE_ENV === 'test';

let webpush = null;
function getWebpush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
  } catch (e) {
    console.error('[push] web-push module missing:', e.message);
    return null;
  }
  return webpush;
}

async function getVapidKeys() {
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv };
  try {
    const pub = await db.get("SELECT value FROM settings WHERE key = 'vapid_public'");
    const priv = await db.get("SELECT value FROM settings WHERE key = 'vapid_private'");
    if (pub && pub.value && priv && priv.value) {
      return { publicKey: pub.value, privateKey: priv.value };
    }
    const wp = getWebpush();
    if (!wp) return null;
    const keys = wp.generateVAPIDKeys();
    await db.query(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('vapid_public', ?)", [keys.publicKey]).catch(() => {});
    await db.query(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('vapid_private', ?)", [keys.privateKey]).catch(() => {});
    console.log('[push] Generated and persisted VAPID keys.');
    return keys;
  } catch (e) {
    console.error('[push] VAPID key setup failed:', e.message);
    return null;
  }
}

async function vapidPublicKey() {
  const keys = await getVapidKeys();
  return keys ? keys.publicKey : null;
}

async function sendWebPushToUser(userId, { title, body, url }) {
  const wp = getWebpush();
  if (!wp) return 0;
  const keys = await getVapidKeys();
  if (!keys) return 0;
  let subs = [];
  try {
    subs = await db.all('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  } catch (e) { return 0; }
  if (!subs.length) return 0;
  if (isTest) {
    sentLog.push({ channel: 'web', userId, title, body, url: url || '/', subs: subs.length });
    return subs.length;
  }
  wp.setVapidDetails('mailto:' + (config.adminEmail || 'admin@tattooartcustoms.local'), keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({ title, body, url: url || '/' });
  let sent = 0;
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e) {
      // 404/410 = subscription expired or revoked — drop it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]).catch(() => {});
      } else {
        console.error('[push] web push failed:', e.message);
      }
    }
  }
  return sent;
}

async function sendExpoPushToUser(userId, { title, body, url }) {
  let row = null;
  try {
    row = await db.get('SELECT expo_push_token FROM users WHERE id = ?', [userId]);
  } catch (e) { return 0; }
  const token = row && row.expo_push_token;
  if (!token || !token.startsWith('ExponentPushToken[')) return 0;
  if (isTest) {
    sentLog.push({ channel: 'expo', userId, title, body, url: url || '/' });
    return 1;
  }
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        to: token,
        title, body,
        data: { url: url || '/' },
        sound: 'default',
        priority: 'high',
      }),
    });
    const data = await res.json().catch(() => ({}));
    const ticket = data && data.data;
    if (ticket && ticket.status === 'error' && ticket.details && ticket.details.error === 'DeviceNotRegistered') {
      await db.query('UPDATE users SET expo_push_token = NULL WHERE id = ?', [userId]).catch(() => {});
      return 0;
    }
    return ticket && ticket.status === 'ok' ? 1 : 0;
  } catch (e) {
    console.error('[push] expo push failed:', e.message);
    return 0;
  }
}

// Push to one user via every channel they have (web + app).
async function pushToUser(userId, note) {
  const [web, expo] = await Promise.all([
    sendWebPushToUser(userId, note),
    sendExpoPushToUser(userId, note),
  ]);
  return web + expo;
}

// Push to every admin / head_admin.
async function pushToAdmins({ title, body, url }) {
  let admins = [];
  try {
    admins = await db.all("SELECT id FROM users WHERE role IN ('admin', 'head_admin')");
  } catch (e) {
    console.error('[push] admin lookup failed:', e.message);
    return 0;
  }
  let total = 0;
  for (const a of admins) {
    total += await pushToUser(a.id, { title, body, url });
  }
  if (total > 0) console.log(`[push] sent ${total} push(es) to admins: ${title}`);
  return total;
}

module.exports = {
  vapidPublicKey, pushToUser, pushToAdmins,
  sendWebPushToUser, sendExpoPushToUser, sentLog,
};
