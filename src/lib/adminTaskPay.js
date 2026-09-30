// Per-task administrator pay, funded in three tiers (owner rule 2026-09-29):
//
// TIER 1 — design triage (design_approve / design_reject / design_hold) is
// funded by a PREPAID review-fee pool, never by site overhead. Designers get
// FREE_UPLOADS_PER_MONTH uploads per Chicago calendar month free; every
// upload beyond that books REVIEW_FEE_CENTS into the pool via
// recordDesignUploadFee(). The fee is collected at upload time, before any
// review happens, so triage pay can never accrue as owner debt and never
// counts toward the overhead cap below.
// TIER 2 — every other paid task (custom approvals, appeals, shop verifies,
// …) draws on the site's 10% overhead exactly as before: total granted
// overhead-funded pay may never exceed ADMIN_TASK_PAY_OVERHEAD_CAP_PCT of
// cumulative site overhead; over-cap rows are 'held' and released oldest-
// first by releaseHeld() as overhead grows. These tasks only trigger when
// revenue already moved, so they are self-funding by construction.
// TIER 3 — ad revenue (see recordAdRevenue in lib/ads.js): 50% of recognized
// ad revenue is swept into the site overhead pool as a cushion for Tier-2
// pay and storage costs; the other 50% belongs to the owner.
//
// Common rules:
// - Active-only: there is no flat/base component. An admin earns solely by
//   completing paid admin tasks, each recorded once per (task, ref).
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
// (its 10% cut of sales, raffle intake, forfeitures, early-cashout penalties,
// Tier-3 ad-revenue sweeps…).
async function overheadCents() {
  const r = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE recipient_type = 'site'`);
  return r.t || 0;
}

// Total OVERHEAD-FUNDED admin task pay ever granted: payable + held + paid.
// Pool-funded (Tier-1) rows are excluded — they never touch overhead.
async function grantedCents() {
  const r = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM admin_task_pay WHERE funded_by = 'overhead'`);
  return r.t || 0;
}

function capCents(overhead) {
  return Math.floor(overhead * ADMIN_TASK_PAY_OVERHEAD_CAP_PCT / 100);
}

// ---------------------------------------------------------------------------
// TIER 1 — prepaid review-fee pool.
// ---------------------------------------------------------------------------
// Design triage is paid from upload fees, never from site overhead. The first
// FREE_UPLOADS_PER_MONTH design uploads per Chicago calendar month are free;
// every upload beyond that books REVIEW_FEE_CENTS. The fee lands in the pool
// as 'fee_in' at upload time; each paid triage action debits 'review_out'.
// Because fees strictly precede reviews, the pool cannot go negative through
// normal operation — the defensive 'held' fallback below exists only for
// pathological states (e.g. rows inserted by hand).
const FREE_UPLOADS_PER_MONTH = 15;
const REVIEW_FEE_CENTS = 40;
const POOL_TASK_TYPES = new Set(['design_approve', 'design_reject', 'design_hold']);

function chicagoMonthKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(now));
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return `${y}-${m}`;
}

// Current prepaid balance: fee_in credits minus review_out debits.
async function poolBalance() {
  const r = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'fee_in' THEN amount_cents ELSE -amount_cents END), 0) AS b
     FROM review_fee_pool`);
  return r.b || 0;
}

// Record one successful design upload for Tier-1 funding. Increments the
// uploader's Chicago-month counter; uploads beyond the free quota book a
// REVIEW_FEE_CENTS review fee.
//
// The fee is a NEGATIVE commission_ledger row against the designer's balance
// (recipient_type='designer', commission_type='review_fee', status='payable'):
// it nets immediately against payable earnings, or against future earnings
// when the balance is insufficient — the accepted bounded edge. Booking it
// as a ledger row instead of a card charge keeps the $0.49 flat processing
// fee from turning a 40c fee into a ~$0.90 charge (standing rule: fees are
// passed through, so small standalone charges are never card-charged).
// Every fee also credits the prepaid pool via a matching 'fee_in' row.
async function recordDesignUploadFee(userId, designId) {
  const month = chicagoMonthKey();
  return db.transaction(async (tx) => {
    const row = await tx.get(
      'SELECT count FROM artist_upload_usage WHERE user_id = ? AND month = ?',
      [userId, month]);
    const count = (row ? row.count : 0) + 1;
    if (row) {
      await tx.query(
        'UPDATE artist_upload_usage SET count = ? WHERE user_id = ? AND month = ?',
        [count, userId, month]);
    } else {
      await tx.query(
        'INSERT INTO artist_upload_usage (user_id, month, count) VALUES (?, ?, ?)',
        [userId, month, count]);
    }
    if (count <= FREE_UPLOADS_PER_MONTH) return { charged: false, count, month };
    const now = Date.now();
    await tx.query(
      `INSERT INTO commission_ledger
         (id, order_id, recipient_type, recipient_id, amount_cents, status, commission_type, created_at)
       VALUES (?, ?, 'designer', ?, ?, 'payable', 'review_fee', ?)`,
      [db.newId(), `reviewfee:${designId}`, userId, -REVIEW_FEE_CENTS, now]);
    await tx.query(
      `INSERT INTO review_fee_pool
         (id, kind, amount_cents, user_id, ref_type, ref_id, created_at)
       VALUES (?, 'fee_in', ?, ?, 'design', ?, ?)`,
      [db.newId(), REVIEW_FEE_CENTS, userId, String(designId), now]);
    return { charged: true, count, month, amount_cents: REVIEW_FEE_CENTS };
  });
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
  // Tier 1: design triage is pool-funded — outside the overhead cap entirely.
  if (POOL_TASK_TYPES.has(taskType)) {
    return recordPoolTask({ adminUserId, taskType, refType, refId: refIdStr, amount });
  }
  // Tier 2: everything else draws on site overhead under the 25% cap.
  const withinCap = (await grantedCents()) + amount <= capCents(await overheadCents());
  const status = withinCap ? 'payable' : 'held';
  const id = await db.insert('admin_task_pay', {
    admin_user_id: adminUserId, task_type: taskType, ref_type: refType, ref_id: refIdStr,
    amount_cents: amount, status, funded_by: 'overhead',
  });
  let ledgerId = null;
  if (status === 'payable') {
    ledgerId = await bookLedgerRow(id, adminUserId, amount, taskType, refType, refIdStr);
  }
  return { duplicate: false, id, status, amount_cents: amount, ledger_id: ledgerId, funded_by: 'overhead' };
}

// Tier-1 task pay: debit the prepaid pool inside one transaction (balance
// check + fee_out + task row + ledger row are atomic, so concurrent triage
// actions cannot overdraw the pool). On a short pool — defensive only, since
// fees precede reviews — the row is 'held', never paid as owner debt.
async function recordPoolTask({ adminUserId, taskType, refType, refId, amount }) {
  const now = Date.now();
  try {
    return await db.transaction(async (tx) => {
      const bal = await tx.get(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'fee_in' THEN amount_cents ELSE -amount_cents END), 0) AS b
         FROM review_fee_pool`);
      if ((bal.b || 0) < amount) throw new Error('review fee pool short');
      const atpId = db.newId();
      await tx.query(
        `INSERT INTO admin_task_pay
           (id, admin_user_id, task_type, ref_type, ref_id, amount_cents, status, funded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'payable', 'pool', ?)`,
        [atpId, adminUserId, taskType, refType, refId, amount, now]);
      await tx.query(
        `INSERT INTO review_fee_pool
           (id, kind, amount_cents, user_id, ref_type, ref_id, created_at)
         VALUES (?, 'review_out', ?, ?, ?, ?, ?)`,
        [db.newId(), amount, adminUserId, refType, refId, now]);
      const ledgerId = db.newId();
      await tx.query(
        `INSERT INTO commission_ledger
           (id, order_id, recipient_type, recipient_id, amount_cents, status, commission_type, created_at)
         VALUES (?, ?, 'admin', ?, ?, 'payable', 'admin_task', ?)`,
        [ledgerId, `admintask:${taskType}:${refType}:${refId}`, adminUserId, amount, now]);
      return {
        duplicate: false, id: atpId, status: 'payable',
        amount_cents: amount, ledger_id: ledgerId, funded_by: 'pool',
      };
    });
  } catch (e) {
    const id = await db.insert('admin_task_pay', {
      admin_user_id: adminUserId, task_type: taskType, ref_type: refType, ref_id: refId,
      amount_cents: amount, status: 'held', funded_by: 'pool',
    });
    return {
      duplicate: false, id, status: 'held',
      amount_cents: amount, ledger_id: null, funded_by: 'pool',
    };
  }
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

// Promote the oldest 'held' rows to 'payable' (+ ledger rows). Tier-2
// (overhead-funded) rows promote while the 25% overhead cap allows; Tier-1
// (pool-funded) rows promote only from the prepaid pool, never from
// overhead. Returns the number of rows promoted.
async function releaseHeld() {
  const held = await db.all(
    `SELECT * FROM admin_task_pay WHERE status = 'held' ORDER BY created_at ASC, id ASC`);
  let promoted = 0;
  for (const h of held) {
    if (h.ledger_id) continue; // defensive: held rows never carry a ledger row
    // Tier-1 rows promote only from the prepaid pool — never from overhead.
    if ((h.funded_by || 'overhead') === 'pool') {
      try {
        await db.transaction(async (tx) => {
          const bal = await tx.get(
            `SELECT COALESCE(SUM(CASE WHEN kind = 'fee_in' THEN amount_cents ELSE -amount_cents END), 0) AS b
             FROM review_fee_pool`);
          if ((bal.b || 0) < h.amount_cents) throw new Error('review fee pool short');
          const ledgerId = db.newId();
          const now = Date.now();
          await tx.query(
            `INSERT INTO review_fee_pool
               (id, kind, amount_cents, user_id, ref_type, ref_id, created_at)
             VALUES (?, 'review_out', ?, ?, ?, ?, ?)`,
            [db.newId(), h.amount_cents, h.admin_user_id, h.ref_type, h.ref_id, now]);
          await tx.query(
            `INSERT INTO commission_ledger
               (id, order_id, recipient_type, recipient_id, amount_cents, status, commission_type, created_at)
             VALUES (?, ?, 'admin', ?, ?, 'payable', 'admin_task', ?)`,
            [ledgerId, `admintask:${h.task_type}:${h.ref_type}:${h.ref_id}`, h.admin_user_id, h.amount_cents, now]);
          await tx.query(
            `UPDATE admin_task_pay SET status = 'payable', ledger_id = ? WHERE id = ?`,
            [ledgerId, h.id]);
        });
        promoted++;
      } catch (e) {
        // Pool still short — leave held; a later fee may cover it.
      }
      continue;
    }
    // Tier-2 rows: grantedCents() already counts held rows — promoting one
    // does not grow the total, so release while the granted total fits under
    // the cap.
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
  FREE_UPLOADS_PER_MONTH, REVIEW_FEE_CENTS, POOL_TASK_TYPES,
  overheadCents, grantedCents, recordTask, releaseHeld, adminEarnings,
  poolBalance, recordDesignUploadFee, chicagoMonthKey,
};
