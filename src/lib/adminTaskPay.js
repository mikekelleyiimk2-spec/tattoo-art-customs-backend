// Per-task administrator pay, funded from the website's 10% overhead.
//
// Design (owner-confirmed 2026-09-29):
// - Active-only: there is no flat/base component. An admin earns solely by
//   completing paid admin tasks, each recorded once per (task, ref).
// - The overhead must always cover its own bills (storage etc.) first —
//   admin task pay is a small incentive, not income. Total granted task pay
//   (payable + held + paid — every row in admin_task_pay) may never exceed
//   ADMIN_TASK_PAY_OVERHEAD_CAP_PCT of cumulative site overhead recorded in
//   commission_ledger (recipient_type='site'). Pay beyond the cap is inserted
//   as 'held' and released (oldest first) by releaseHeld() as overhead grows.
// - Task pay accrues into the admin's normal payable balance and goes out
//   with the Monday payout run at the $5 minimum, via the same rails as
//   artist/shop commissions (recipient_type='admin').
// - Site overhead ledger rows are IMMUTABLE: admin pay is a separate
//   obligation capped against overhead, never a debit of site rows.
// - Self-pay guard: an admin earns nothing for moderating their own designs.
const db = require('../db');

const ADMIN_TASK_PAY_OVERHEAD_CAP_PCT = 25;

// Rate card, in cents.
const RATE_CARD = {
  design_approve: 25, design_reject: 25, design_hold: 25,
  review_approve: 10, review_reject: 10,
  custom_approve: 100, custom_request_changes: 100, custom_reassign: 100, custom_deliver: 100,
  replacement_close: 50,
  order_confirm_manual: 50, order_verify_referral: 50,
  appeal_decide: 200,
  shop_verify: 100,
  member_cancel: 25,
  bug_triage: 25,
  cashout_complete: 25, payout_complete: 25,
  designer_restrict: 50, designer_unsuspend: 50, designer_forgive: 50, designer_lift: 50,
  colorization_attach: 50,
  print_fulfill: 50,
  ad_activate: 10, ad_deactivate: 10,
};

// Cumulative site overhead: every commission_ledger row booked to the site
// (its 10% cut of sales, raffle intake, forfeitures, early-cashout penalties…).
async function overheadCents() {
  const r = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE recipient_type = 'site'`);
  return r.t || 0;
}

// Total admin task pay ever granted: payable + held + paid (all rows).
async function grantedCents() {
  const r = await db.get(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM admin_task_pay`);
  return r.t || 0;
}

function capCents(overhead) {
  return Math.floor(overhead * ADMIN_TASK_PAY_OVERHEAD_CAP_PCT / 100);
}

// Book the payable ledger obligation for a granted task-pay row. The ledger
// row uses a synthetic order_id (order_id is NOT NULL and has no `note`
// column) so it can never collide with a real sale's commission rows.
async function bookLedgerRow(taskPayId, adminUserId, amountCents, taskType, refType, refId) {
  const ledgerId = await db.insert('commission_ledger', {
    order_id: `admintask:${taskType}:${refType}:${refId}`,
    recipient_type: 'admin', recipient_id: adminUserId,
    amount_cents: amountCents, status: 'payable',
    commission_type: 'admin_task',
  });
  await db.update('admin_task_pay', taskPayId, { ledger_id: ledgerId });
  return ledgerId;
}

// Record one completed admin task. Idempotent: a duplicate
// (task_type, ref_type, ref_id) pays nothing and returns { duplicate: true }.
// Returns { selfPay: true } when an admin moderates their own design.
async function recordTask({ adminUserId, taskType, refType, refId }) {
  const amount = RATE_CARD[taskType];
  if (!amount || !adminUserId || !refType || refId === undefined || refId === null) {
    return { skipped: true };
  }
  const refIdStr = String(refId);
  const existing = await db.get(
    `SELECT id, status FROM admin_task_pay WHERE task_type = ? AND ref_type = ? AND ref_id = ?`,
    [taskType, refType, refIdStr]);
  if (existing) return { duplicate: true, id: existing.id, status: existing.status };
  // Self-pay guard: no pay for moderating your own designs.
  if (refType === 'design') {
    const design = await db.get('SELECT artist_id FROM designs WHERE id = ?', [refIdStr]).catch(() => null);
    if (design && design.artist_id && design.artist_id === adminUserId) return { selfPay: true };
  }
  const withinCap = (await grantedCents()) + amount <= capCents(await overheadCents());
  const status = withinCap ? 'payable' : 'held';
  const id = await db.insert('admin_task_pay', {
    admin_user_id: adminUserId, task_type: taskType, ref_type: refType, ref_id: refIdStr,
    amount_cents: amount, status,
  });
  let ledgerId = null;
  if (status === 'payable') {
    ledgerId = await bookLedgerRow(id, adminUserId, amount, taskType, refType, refIdStr);
  }
  return { duplicate: false, id, status, amount_cents: amount, ledger_id: ledgerId };
}

// Promote the oldest 'held' rows to 'payable' (+ ledger rows) while the 25%
// overhead cap allows. Returns the number of rows promoted.
async function releaseHeld() {
  const held = await db.all(
    `SELECT * FROM admin_task_pay WHERE status = 'held' ORDER BY created_at ASC, id ASC`);
  let promoted = 0;
  for (const h of held) {
    if (h.ledger_id) continue; // defensive: held rows never carry a ledger row
    // grantedCents() already counts held rows — promoting one does not grow
    // the total, so release while the granted total fits under the cap.
    if ((await grantedCents()) > capCents(await overheadCents())) break;
    const ledgerId = await bookLedgerRow(h.id, h.admin_user_id, h.amount_cents, h.task_type, h.ref_type, h.ref_id);
    await db.update('admin_task_pay', h.id, { status: 'payable', ledger_id: ledgerId });
    promoted++;
  }
  return promoted;
}

// Per-admin totals for the admin UI: earned ever, payable now (the running
// stacked balance that accrues into the Monday payout), and paid to date.
async function adminEarnings() {
  const rows = await db.all(
    `SELECT u.id, u.email, u.display_name,
            COALESCE((SELECT SUM(amount_cents) FROM admin_task_pay a WHERE a.admin_user_id = u.id), 0) AS earned,
            COALESCE((SELECT SUM(amount_cents) FROM commission_ledger l
                      WHERE l.recipient_type = 'admin' AND l.recipient_id = u.id AND l.status = 'payable'), 0) AS payable_now,
            COALESCE((SELECT SUM(amount_cents) FROM commission_ledger l
                      WHERE l.recipient_type = 'admin' AND l.recipient_id = u.id AND l.status = 'paid'), 0) AS paid_total
     FROM users u
     WHERE EXISTS (SELECT 1 FROM admin_task_pay a WHERE a.admin_user_id = u.id)
     ORDER BY earned DESC`);
  return rows;
}

module.exports = {
  RATE_CARD, ADMIN_TASK_PAY_OVERHEAD_CAP_PCT,
  overheadCents, grantedCents, recordTask, releaseHeld, adminEarnings,
};
