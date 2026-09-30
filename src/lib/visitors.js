// Lightweight site-visitor counter (drives the opening-sale campaign cap).
// One count per session: the first request carrying a fresh session bumps the
// `visitors` row in `site_counters`. Approximate by design (bots count too) —
// it is a marketing cap, not analytics.
const db = require('../db');

async function countVisitor(session) {
  if (!session || session.vcounted) return;
  session.vcounted = 1;
  try {
    const row = await db.get('SELECT counter_value FROM site_counters WHERE name = ?', ['visitors']);
    if (row) {
      await db.query('UPDATE site_counters SET counter_value = counter_value + 1 WHERE name = ?', ['visitors']);
    } else {
      await db.query('INSERT INTO site_counters (name, counter_value) VALUES (?, ?)', ['visitors', 1]);
    }
  } catch (e) {
    console.error('visitor counter failed:', e.message);
  }
}

async function visitorCount() {
  try {
    const row = await db.get('SELECT counter_value FROM site_counters WHERE name = ?', ['visitors']);
    return Number(row ? row.counter_value : 0);
  } catch (e) {
    return 0;
  }
}

async function paidSalesCount() {
  try {
    const row = await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'");
    return Number(row ? row.n : 0);
  } catch (e) {
    return 0;
  }
}

module.exports = { countVisitor, visitorCount, paidSalesCount };
