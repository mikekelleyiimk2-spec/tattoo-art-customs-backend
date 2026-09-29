// Storage capacity monitor — owner's standing order: notify admins (in-app
// + email + push) when image storage reaches 85% of the configured capacity.
//
// Capacity is a budget cap, not a provider limit: STORAGE_CAPACITY_GB
// (default 100). Usage is measured across both R2 buckets in r2 mode, or the
// local asset dir in local mode.
//
// The alert fires ONCE per crossing: a site_kv watermark records that the
// 85% alert was sent, and it resets only when usage drops back under 80%
// (hysteresis, so a hover at 85% doesn't spam).
const db = require('../db');
const storage = require('./storage');
const { notifyAdmins } = require('./notify');

const ALERT_KEY = 'storage_85_alerted';
const ALERT_AT = 0.85;
const RESET_BELOW = 0.80;

async function kvGet(name) {
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', [name]);
    return row ? row.val : null;
  } catch { return null; }
}

async function kvSet(name, val) {
  try {
    const now = db.now();
    const row = await db.get('SELECT name FROM site_kv WHERE name = ?', [name]);
    if (row) await db.query('UPDATE site_kv SET val = ?, updated_at = ? WHERE name = ?', [val, now, name]);
    else await db.insert('site_kv', { name, val, updated_at: now });
  } catch (e) {
    console.error('[storageWatch] kvSet failed:', e.message);
  }
}

function fmtGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function checkStorageCapacity() {
  let bytes, cap;
  try {
    bytes = await storage.usageBytes();
  } catch (e) {
    console.error('[storageWatch] usage check failed:', e.message || e);
    return null;
  }
  cap = storage.capacityBytes();
  const pct = cap > 0 ? bytes / cap : 0;
  const alerted = (await kvGet(ALERT_KEY)) === '1';

  if (pct >= ALERT_AT && !alerted) {
    const title = `Image storage at ${Math.round(pct * 100)}% of capacity`;
    const body =
      `Image storage has reached ${fmtGB(bytes)} of the ${fmtGB(cap)} capacity limit ` +
      `(${Math.round(pct * 100)}%, provider: ${storage.provider()}). ` +
      `Storage is paid from the website's 10% overhead cut of sales revenue. ` +
      `Consider raising STORAGE_CAPACITY_GB or cleaning up unused uploads.`;
    console.log(`[storageWatch] ${title} — notifying admins.`);
    await notifyAdmins({
      kind: 'storage',
      title,
      body,
      link: '/admin',
      emailSubject: `[Tattoo Art Customs] ${title}`,
      emailText: body,
    });
    await kvSet(ALERT_KEY, '1');
  } else if (pct < RESET_BELOW && alerted) {
    console.log('[storageWatch] usage back under 80% — resetting 85% alert watermark.');
    await kvSet(ALERT_KEY, '0');
  }
  return { bytes, cap, pct, alerted: pct >= ALERT_AT };
}

module.exports = { checkStorageCapacity, ALERT_AT, RESET_BELOW };
