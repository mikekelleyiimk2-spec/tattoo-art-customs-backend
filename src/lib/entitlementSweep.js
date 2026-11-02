// Entitlement RECONCILIATION SWEEP (verification cadence, owner
// directive 2026-11-01 20:34 CST: "long as file verification runs as
// often as needed to catch store thieves immediately").
//
// The Chorvix layer verifies AT the attempt — sign-in, redeem,
// claim, download, co-op join. This sweep is the other half of the
// cadence: entitlements already granted are re-checked against
// their SOURCES OF TRUTH on a recurring run (hourly from
// lib/scheduler.js; on demand via POST /api/onemind/sweep for the
// house service token). A source that died — a refunded or
// chargebacked order, a Play purchase Google no longer stands
// behind — PULLS the entitlement, and the pull is written to the
// verify watch (kind 'entitlement_pulled' / 'play_purchase_revoked')
// where GET /api/onemind/watch surfaces it under `anomalies`.
//
// What is checked, per run:
//   1. Code bindings (seat_entitlements, source 'code'): binding ->
//      code row -> the code's order. Order refunded/chargebacked
//      (any status that is not 'paid') or the code/order row gone
//      -> the binding is revoked with a recorded reason. (Website-
//      ORDER entitlements need no pull: entitlementsFor reads the
//      orders table live, so a refund stops granting the same
//      moment its status flips — the sweep's order leg here covers
//      the one stored copy: bindings.)
//   2. Verified Play purchases (play_purchases, status 'verified'):
//      re-proven against Google via lib/playverify, oldest-check-
//      first, a bounded batch per run (PLAY_RECHECK_BATCH), the
//      cursor carried in play_purchases.recheck_at (migration 123).
//      A DEFINITIVE Google "no" (purchase not purchased /
//      subscription not active) flips the row to 'revoked' —
//      entitlementsFor only reads 'verified', so the entitlement
//      dies with the flip — and any membership the purchase linked
//      is ended. "Not configured" and transient API errors are NOT
//      a no: the row keeps its status and its cursor does not move,
//      so an outage can never strip honest buyers.
//   3. Orphan bindings: a stored binding whose source row no longer
//      exists at all is pulled as 'source_gone'.
//
// Every run also checks the CURRENT live-binding set against the
// refund state (leg 1 is exhaustive, not batched — bindings are
// house-sized), records a 'sweep_run' event, and stores the summary
// in site_kv 'chorvix_sweep_last' for the watch to surface.
const db = require('../db');
const seatVerify = require('./seatVerify');
const playverify = require('./playverify');

const PLAY_RECHECK_BATCH = Math.max(1, Number(process.env.CHORVIX_PLAY_RECHECK_BATCH || 25));
// The only verifyPurchase reasons that mean "Google answered and
// the purchase is not standing". Anything else (not_configured,
// network/API errors) is weather, not a verdict.
const DEFINITIVE_NO = new Set(['product not purchased', 'subscription not active']);

async function pullBinding(binding, reason, detail, summary) {
  await db.update('seat_entitlements', binding.id, {
    revoked_at: db.now(), revoke_reason: reason,
  });
  const user = await db.get('SELECT * FROM users WHERE id = ?', [binding.user_id]);
  await seatVerify.logEvent({
    user, userId: binding.user_id, kind: 'entitlement_pulled',
    detail: `${binding.product}:${reason}${detail ? ` (${detail})` : ''}`,
  });
  // An entitlement held with no living source of truth is
  // theft-class (owner design 2026-11-01 20:40): the pull springs
  // the thief trap on the seat. It lifts on a LATER clean pass —
  // this run never lifts a seat it pulled (see runSweep).
  if (user) {
    await seatVerify.setTrap(user, 'unbacked_entitlement', 'entitlement_pulled',
      `${binding.product}:${reason}`);
    if (summary) summary.pulled_user_ids.add(binding.user_id);
  }
}

async function sweepCodeBindings(summary) {
  const bindings = await db.all(
    "SELECT * FROM seat_entitlements WHERE revoked_at IS NULL AND source = 'code'");
  for (const b of bindings) {
    summary.bindings_checked++;
    const codeRow = b.ref
      ? await db.get('SELECT * FROM brambleforce_codes WHERE id = ?', [b.ref])
      : null;
    if (!codeRow) {
      await pullBinding(b, 'source_gone', 'code row missing', summary);
      summary.bindings_pulled++;
      continue;
    }
    const order = codeRow.order_id
      ? await db.get('SELECT * FROM orders WHERE id = ?', [codeRow.order_id])
      : null;
    if (!order) {
      await pullBinding(b, 'source_gone', 'order row missing', summary);
      summary.bindings_pulled++;
      continue;
    }
    if (order.status !== 'paid') {
      await pullBinding(b, `source_${order.status}`, `order ${order.id}`, summary);
      summary.bindings_pulled++;
    }
  }
}

async function sweepPlayPurchases(summary, injectedVerifyFn) {
  // An injected verifier (the test suite's stub) runs as-is; the
  // production verifier needs the Play service account — without it
  // the leg skips honestly instead of pretending to re-prove.
  if (!injectedVerifyFn && !playverify.serviceAccountConfigured()) {
    summary.play_skipped = 'play_not_configured';
    return;
  }
  const verifyFn = injectedVerifyFn || playverify.verifyPurchase;
  const rows = await db.all(
    `SELECT * FROM play_purchases WHERE status = 'verified'
     ORDER BY COALESCE(recheck_at, 0) ASC, verified_at ASC LIMIT ?`,
    [PLAY_RECHECK_BATCH]);
  for (const row of rows) {
    summary.play_checked++;
    let v;
    try {
      v = await verifyFn({
        productId: row.product_id,
        purchaseToken: row.purchase_token,
        type: row.purchase_type === 'inapp' ? 'inapp' : 'subs',
      });
    } catch (e) {
      v = { verified: false, reason: e.message };
    }
    if (v && v.verified) {
      await db.update('play_purchases', row.id, { recheck_at: db.now() });
      continue;
    }
    if (v && DEFINITIVE_NO.has(String(v.reason || ''))) {
      await db.update('play_purchases', row.id, {
        status: 'revoked', recheck_at: db.now(),
      });
      summary.play_revoked++;
      if (row.linked_membership_id) {
        await db.update('subscriptions', row.linked_membership_id, { status: 'cancelled' });
      }
      const user = row.user_id
        ? await db.get('SELECT * FROM users WHERE id = ?', [row.user_id])
        : null;
      await seatVerify.logEvent({
        user, userId: row.user_id, kind: 'play_purchase_revoked',
        detail: `${row.product_id}:${v.reason}`,
      });
      // Same theft class as a pulled binding: the seat was holding
      // value its source no longer stands behind — trap springs.
      if (user) {
        await seatVerify.setTrap(user, 'unbacked_entitlement', 'play_purchase_revoked',
          `${row.product_id}:${v.reason}`);
        summary.pulled_user_ids.add(row.user_id);
      }
      continue;
    }
    // Not definitive (not_configured / transient): leave the row and
    // its cursor exactly as they were — it is re-tried next run.
    summary.play_inconclusive++;
  }
}

async function runSweep({ verifyFn = null } = {}) {
  const startedAt = db.now();
  const pulledUserIds = new Set();
  const summary = {
    ts: startedAt,
    bindings_checked: 0, bindings_pulled: 0,
    play_checked: 0, play_revoked: 0, play_inconclusive: 0,
    play_skipped: null, traps_lifted: 0,
  };
  // Internal handle for the pull legs (not serialized — stripped
  // before the summary is stored/returned below).
  summary.pulled_user_ids = pulledUserIds;
  await sweepCodeBindings(summary);
  await sweepPlayPurchases(summary, verifyFn);
  // TRAP LIFT PASS: every actively trapped seat whose holdings now
  // reconcile clean gets its trap lifted by this run — EXCEPT seats
  // pulled in THIS run: their trap was just set (or re-affirmed) by
  // the pull, and it lifts on the NEXT clean pass, so the
  // consequence is real and the reconciliation that ends it is a
  // separate, later proof.
  const trapped = await db.all('SELECT user_id FROM seat_traps WHERE lifted_at IS NULL');
  for (const t of trapped) {
    if (pulledUserIds.has(t.user_id)) continue;
    const user = await db.get('SELECT * FROM users WHERE id = ?', [t.user_id]);
    if (!user) continue;
    const before = await seatVerify.trapStateFor(user.id);
    const after = await seatVerify.reconcileTrapFor(user, 'sweep_reconciled');
    if (before.active && !after.active) summary.traps_lifted++;
  }
  delete summary.pulled_user_ids;
  summary.duration_ms = db.now() - startedAt;
  try {
    await db.query(
      `INSERT INTO site_kv (name, val, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
      ['chorvix_sweep_last', JSON.stringify(summary), db.now()]);
  } catch (e) { /* best-effort: the watch events below are the durable record */ }
  await seatVerify.logEvent({
    kind: 'sweep_run',
    detail: `bindings ${summary.bindings_checked}/${summary.bindings_pulled} pulled; play ${summary.play_checked}/${summary.play_revoked} revoked; traps lifted ${summary.traps_lifted}${summary.play_skipped ? `; play skipped: ${summary.play_skipped}` : ''}`,
  });
  return summary;
}

module.exports = { runSweep, DEFINITIVE_NO, PLAY_RECHECK_BATCH };
