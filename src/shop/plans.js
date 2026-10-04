// Payment plans for shop bookings (shop toolset).
//
// A plan splits a total into 2–12 monthly installments. Automatic charging
// stays DISABLED behind config.autoChargeEnabled (owner rule, default OFF):
// due installments are flagged 'due_awaiting_paypal' and the shop is
// notified once per plan to collect manually or connect PayPal.
//
// OWNER RULE: never attempt a charge unless PayPal is live AND
// config.autoChargeEnabled is explicitly on. executeInstallmentCharge()
// is the single seam the live PayPal wiring replaces later; today it
// always refuses and the sweep leaves the installment untouched.
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('../lib/notify');
const { pushToUser } = require('../lib/push');

const paypalLive = !!(config.paypal && config.paypal.clientId && config.paypal.clientSecret);
const DAY_MS = 86400000;
const SWEEP_LIMIT = 200;
const PLAN_CHARGE_NOTIFY_KIND = 'plan-charge-pending';
const NOTIFY_DEDUP_MS = 7 * DAY_MS; // one reminder per plan per week max

// Creates a plan + its installments. Remainder pennies land on the LAST
// installment so the earlier ones are a clean even split. Returns { planId }.
async function createPlan(shopUserId, customerUserId, { bookingId, title, totalCents, sessionsCount, firstDueAt } = {}) {
  const t = String(title || '').trim();
  if (t.length < 1 || t.length > 120) throw new Error('Title must be 1–120 characters.');
  if (!Number.isInteger(totalCents) || totalCents < 100) {
    throw new Error('Plan total must be at least $1 (100 cents).');
  }
  if (!Number.isInteger(sessionsCount) || sessionsCount < 2 || sessionsCount > 12) {
    throw new Error('Plans have 2–12 installments.');
  }
  const due0 = Number(firstDueAt);
  if (!Number.isFinite(due0) || due0 <= Date.now()) {
    throw new Error('First due date must be in the future.');
  }
  const base = Math.floor(totalCents / sessionsCount);
  const remainder = totalCents - base * sessionsCount;
  const planId = await db.insert('payment_plans', {
    shop_user_id: shopUserId,
    customer_user_id: customerUserId,
    booking_id: bookingId || null,
    title: t,
    total_cents: totalCents,
    sessions_count: sessionsCount,
    status: 'active',
    created_at: Date.now(),
  });
  for (let seq = 1; seq <= sessionsCount; seq++) {
    await db.insert('plan_installments', {
      plan_id: planId,
      seq,
      amount_cents: seq === sessionsCount ? base + remainder : base,
      due_at: due0 + (seq - 1) * 30 * DAY_MS,
      status: 'pending',
      created_at: Date.now(),
    });
  }
  return { planId };
}

// Plans with customer names, newest first.
async function getPlansForShop(shopUserId) {
  return db.all(
    `SELECT pp.*, u.display_name AS customer_name FROM payment_plans pp
     LEFT JOIN users u ON u.id = pp.customer_user_id
     WHERE pp.shop_user_id = ? ORDER BY pp.created_at DESC`,
    [shopUserId]
  );
}

// Plans with shop names, newest first.
async function getPlansForCustomer(customerUserId) {
  return db.all(
    `SELECT pp.*, u.display_name AS shop_name FROM payment_plans pp
     LEFT JOIN users u ON u.id = pp.shop_user_id
     WHERE pp.customer_user_id = ? ORDER BY pp.created_at DESC`,
    [customerUserId]
  );
}

// Plan + installments (seq order) with ownership enforced for the viewer.
async function getPlanDetail(planId, viewerId, viewerRole) {
  if (viewerRole !== 'shop' && viewerRole !== 'customer') {
    throw new Error('Invalid viewer role.');
  }
  const plan = await db.get('SELECT * FROM payment_plans WHERE id = ?', [planId]);
  if (!plan) throw new Error('Plan not found.');
  const ownerId = viewerRole === 'shop' ? plan.shop_user_id : plan.customer_user_id;
  if (String(ownerId) !== String(viewerId)) throw new Error('Not your plan.');
  const installments = await db.all(
    'SELECT * FROM plan_installments WHERE plan_id = ? ORDER BY seq ASC', [planId]
  );
  return { plan, installments };
}

// Cancels an active/draft plan; remaining pending installments are waived
// (past ones already paid/failed stay as-is for the record).
async function cancelPlan(planId, shopUserId) {
  const plan = await db.get('SELECT * FROM payment_plans WHERE id = ?', [planId]);
  if (!plan) throw new Error('Plan not found.');
  if (String(plan.shop_user_id) !== String(shopUserId)) throw new Error('Not your plan.');
  if (plan.status !== 'active' && plan.status !== 'draft') {
    throw new Error('Only active or draft plans can be cancelled.');
  }
  await db.update('payment_plans', planId, { status: 'cancelled' });
  await db.query(
    "UPDATE plan_installments SET status = 'waived' WHERE plan_id = ? AND status IN ('pending','due_awaiting_paypal')",
    [planId]
  );
  return db.get('SELECT * FROM payment_plans WHERE id = ?', [planId]);
}

// Waives a single installment (shop discretion — e.g. goodwill adjustment).
async function waiveInstallment(planId, seq, shopUserId) {
  const plan = await db.get('SELECT * FROM payment_plans WHERE id = ?', [planId]);
  if (!plan) throw new Error('Plan not found.');
  if (String(plan.shop_user_id) !== String(shopUserId)) throw new Error('Not your plan.');
  await db.query(
    'UPDATE plan_installments SET status = ? WHERE plan_id = ? AND seq = ?',
    ['waived', planId, seq]
  );
  await maybeCompletePlan(planId);
  return db.get('SELECT * FROM plan_installments WHERE plan_id = ? AND seq = ?', [planId, seq]);
}

// Marks the plan 'completed' once every installment is paid or waived.
async function maybeCompletePlan(planId) {
  const open = await db.get(
    "SELECT id FROM plan_installments WHERE plan_id = ? AND status NOT IN ('paid','waived') LIMIT 1",
    [planId]
  );
  if (!open) {
    await db.update('payment_plans', planId, { status: 'completed' });
  }
}

// THE single seam for live PayPal later. Today: refuse, never charge.
async function executeInstallmentCharge(inst) {
  return { ok: false, reason: 'paypal_not_live_or_disabled' };
}

// Notifies the shop about a newly-due installment, at most once per plan
// per week (deduped on notifications kind + link in the last 7 days).
async function notifyShopOfDueInstallment(inst) {
  const plan = await db.get('SELECT * FROM payment_plans WHERE id = ?', [inst.plan_id]);
  if (!plan) return;
  const link = `/shop/plans/${plan.id}`;
  const since = Date.now() - NOTIFY_DEDUP_MS;
  const recent = await db.get(
    'SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND link = ? AND created_at >= ? LIMIT 1',
    [plan.shop_user_id, PLAN_CHARGE_NOTIFY_KIND, link, since]
  );
  if (recent) return; // reminded within the last 7 days already
  const title = `Installment #${inst.seq} of "${plan.title}" is due`;
  const body = `Installment #${inst.seq} of "${plan.title}" is due — collect manually or connect PayPal for automatic charging.`;
  await notifyUser(plan.shop_user_id, { kind: PLAN_CHARGE_NOTIFY_KIND, title, body, link });
  try {
    await pushToUser(plan.shop_user_id, { title, body, url: link });
  } catch (e) {
    // push is best-effort only; the in-app notification already landed
  }
}

// Charges (or flags) due installments. With auto-charge enabled AND PayPal
// live it goes through executeInstallmentCharge(); otherwise each due
// installment is flagged 'due_awaiting_paypal' and the shop is notified
// once per plan. Never attempts a charge. Returns { seen, marked }.
async function runPlanChargeSweep(now) {
  const due = await db.all(
    'SELECT * FROM plan_installments WHERE status = ? AND due_at <= ? ORDER BY due_at ASC LIMIT ?',
    ['pending', now, SWEEP_LIMIT]
  );
  let marked = 0;
  for (const inst of due) {
    if (config.autoChargeEnabled === true && paypalLive) {
      // The seam refuses today: log, leave the installment pending, move on.
      const res = await executeInstallmentCharge(inst);
      if (res && res.ok) {
        await db.update('plan_installments', inst.id, { status: 'paid', charged_at: Date.now() });
        await maybeCompletePlan(inst.plan_id);
      } else {
        console.log(`[plans] installment ${inst.id} charge seam declined — left pending, no charge attempted`);
      }
      continue;
    }
    await db.update('plan_installments', inst.id, { status: 'due_awaiting_paypal' });
    marked += 1;
    await notifyShopOfDueInstallment(inst);
  }
  return { seen: due.length, marked };
}

module.exports = {
  createPlan,
  getPlansForShop,
  getPlansForCustomer,
  getPlanDetail,
  cancelPlan,
  waiveInstallment,
  maybeCompletePlan,
  runPlanChargeSweep,
  executeInstallmentCharge,
};
