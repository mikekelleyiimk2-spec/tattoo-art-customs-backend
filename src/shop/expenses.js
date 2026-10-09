// Shop expense tracker (shop toolset, 2026-10-09).
//
// The shop logs business expenses (amount, category, description, date).
// Dashboard shows monthly totals + a category breakdown. Aggregation is
// done in JS (not SQL date functions) to stay dialect-neutral across pg
// and sqlite.
const db = require('../db');

const EXPENSE_CATEGORIES = [
  'ink', 'needles', 'disposables', 'equipment', 'rent',
  'utilities', 'marketing', 'travel', 'insurance', 'other',
];

// UTC month key "YYYY-MM" for bucketing.
function monthKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Start of the UTC month, `back` months ago (0 = current month).
function monthStartUtc(back = 0) {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
}

async function addExpense({ shopUserId, amountCents, category = null, description = null, spentAt = null }) {
  const total = Math.round(Number(amountCents));
  if (!Number.isFinite(total) || total <= 0) throw new Error('Amount must be a positive number of cents.');
  const when = spentAt ? Number(spentAt) : Date.now();
  if (!Number.isFinite(when)) throw new Error('Date is invalid.');
  return db.insert('shop_expenses', {
    shop_user_id: String(shopUserId),
    amount_cents: total,
    category: String(category || '').trim().slice(0, 60).toLowerCase() || 'other',
    description: String(description || '').trim().slice(0, 500) || null,
    spent_at: when,
  });
}

async function getExpenses(shopUserId, fromTs = null, toTs = null) {
  const where = ['shop_user_id = ?'];
  const params = [String(shopUserId)];
  if (fromTs != null) { where.push('spent_at >= ?'); params.push(Number(fromTs)); }
  if (toTs != null) { where.push('spent_at < ?'); params.push(Number(toTs)); }
  return db.all(
    `SELECT * FROM shop_expenses WHERE ${where.join(' AND ')} ORDER BY spent_at DESC`,
    params);
}

async function deleteExpense({ shopUserId, id }) {
  const row = await db.get(
    'SELECT id FROM shop_expenses WHERE id = ? AND shop_user_id = ?',
    [String(id), String(shopUserId)]);
  if (!row) throw new Error('Expense not found.');
  await db.query('DELETE FROM shop_expenses WHERE id = ?', [row.id]);
  return true;
}

// Monthly totals, newest month first, for the last `months` months
// (includes zero-amount months so the dashboard always shows a full run).
async function getMonthlyTotals(shopUserId, months = 12) {
  const fromTs = monthStartUtc(months - 1);
  const rows = await getExpenses(shopUserId, fromTs);
  const buckets = new Map();
  for (let i = 0; i < months; i += 1) {
    const key = monthKey(monthStartUtc(i));
    buckets.set(key, { month: key, amount_cents: 0, count: 0 });
  }
  for (const r of rows) {
    const key = monthKey(r.spent_at);
    if (buckets.has(key)) {
      const b = buckets.get(key);
      b.amount_cents += r.amount_cents;
      b.count += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

// Category totals for a period, biggest spenders first.
async function getCategoryTotals(shopUserId, fromTs = null, toTs = null) {
  const rows = await getExpenses(shopUserId, fromTs, toTs);
  const byCat = new Map();
  for (const r of rows) {
    const cat = r.category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, { category: cat, amount_cents: 0, count: 0 });
    const b = byCat.get(cat);
    b.amount_cents += r.amount_cents;
    b.count += 1;
  }
  return [...byCat.values()].sort((a, b) => b.amount_cents - a.amount_cents);
}

module.exports = {
  EXPENSE_CATEGORIES, monthKey, monthStartUtc,
  addExpense, getExpenses, deleteExpense, getMonthlyTotals, getCategoryTotals,
};
