// Weekly commission payouts — MANUAL-SEND mode.
//
// Every Monday ~9am CT (see lib/scheduler.js), every recipient with
// cashout_mode = 'weekly', a payable balance >= $5, and a default payout
// destination is queued for MANUAL send: a cashout_requests row
// (status 'pending') appears on /admin/payouts and the admin sends each
// payment by hand (PayPal, Wise, Cash App, Venmo, Zelle, bank, …), then
// marks it sent. A Monday report email goes to the admin listing every
// queued / skipped recipient.
//
// Why manual: PayPal declined the Payouts enrollment (2026-09-28), so the
// automatic PayPal batch cannot run. To re-enable automatic PayPal
// payouts once the enrollment is approved, set PAYPAL_PAYOUTS_ENABLED=1 —
// the batch code path is preserved below and untouched otherwise.
// (Bank via Wise still sends automatically when Wise is configured.)
//
// Recipients with cashout_mode = 'manual' are skipped (they cash out on
// demand). Anyone skipped or failed keeps their balance as payable.
// No payout goes out without an active designer or tattoo shop subscription.
// The function never throws; it always returns a summary and emails it to
// the site admin (or logs it when SMTP isn't configured).
const db = require('../db');
const config = require('../config');
const paypal = require('./paypal');
const wise = require('./wise');
const { sendMail } = require('./mail');
const { payableBalance } = require('./commissions');
const cashout = require('./cashout');

const MIN_PAYOUT_CENTS = 500;

// Automatic PayPal Payouts batch — OFF until the Payouts enrollment is
// approved (declined 2026-09-28). Set PAYPAL_PAYOUTS_ENABLED=1 to restore
// the automatic batch; until then PayPal-destination payouts join the
// manual-send queue like every other rail.
const PAYPAL_PAYOUTS_ENABLED = process.env.PAYPAL_PAYOUTS_ENABLED === '1';

async function runWeeklyPayouts() {
  const summary = { at: new Date().toISOString(), paid: [], queued: [], skipped: [], failed: false, error: '' };

  // Queue one recipient for manual send: creates the cashout request the
  // admin works from on /admin/payouts and claims their payable rows.
  async function queueManualSend(ctx, viaLabel) {
    const cashoutId = await db.insert('cashout_requests', {
      user_id: ctx.recipientId, recipient_type: ctx.recipientType, destination_id: ctx.dest.id,
      dest_snapshot: JSON.stringify({ dest_type: ctx.dest.dest_type, label: ctx.dest.label, details: ctx.details }),
      amount_cents: ctx.amountCents, penalty_cents: 0, net_cents: ctx.amountCents,
      kind: 'weekly', status: 'pending', note: `Weekly payout — send manually via ${viaLabel}.`,
      created_at: db.now(),
    });
    await cashout.claimPayableRows({ userId: ctx.recipientId, recipientType: ctx.recipientType, cashoutId });
    summary.queued.push({ ...ctx, via: viaLabel });
    return cashoutId;
  }

  const groups = await db.all(
    `SELECT recipient_type, recipient_id
     FROM commission_ledger WHERE status = 'payable'
     GROUP BY recipient_type, recipient_id`);

  const paypalItems = [];
  for (const g of groups) {
    // No payout without an active designer or shop subscription — a lapsed
    // subscription skips the payout and the balance stays payable until the
    // recipient resubscribes. Customer subscriptions never qualify.
    try {
      await cashout.requirePayoutEligible(g.recipient_id, g.recipient_type);
    } catch (e) {
      summary.skipped.push({ ...g, reason: 'no active designer or tattoo shop subscription — payout held until resubscribed' });
      continue;
    }
    const mode = await cashout.getCashoutMode(g.recipient_id, g.recipient_type);
    if (mode !== 'weekly') {
      summary.skipped.push({ ...g, reason: 'manual cashout mode — recipient cashes out on demand' });
      continue;
    }
    const balance = await payableBalance(g.recipient_type, g.recipient_id);
    if (balance < MIN_PAYOUT_CENTS) {
      summary.skipped.push({ ...g, reason: `below $${(MIN_PAYOUT_CENTS / 100).toFixed(2)} minimum` });
      continue;
    }
    const dest = await cashout.getDefaultDestination(g.recipient_id);
    if (!dest) {
      summary.skipped.push({ ...g, reason: 'no payout destination set' });
      continue;
    }
    const details = JSON.parse(dest.details || '{}');
    const user = await db.get('SELECT display_name FROM users WHERE id = ?', [g.recipient_id]);
    const ctx = {
      recipientType: g.recipient_type, recipientId: g.recipient_id,
      name: user?.display_name || '—', dest, details, amountCents: balance,
    };
    const spec = cashout.DEST_TYPES[dest.dest_type];

    if (spec.auto === 'paypal') {
      paypalItems.push({ ...ctx, recipientEmail: details.email });
    } else if (spec.auto === 'wise' && dest.dest_type === 'bank' && wise.isConfigured()) {
      // Bank via Wise: send individually now.
      let cashoutId = null;
      try {
        cashoutId = await db.insert('cashout_requests', {
          user_id: g.recipient_id, recipient_type: g.recipient_type, destination_id: dest.id,
          dest_snapshot: JSON.stringify({ dest_type: dest.dest_type, label: dest.label, details }),
          amount_cents: balance, penalty_cents: 0, net_cents: balance,
          kind: 'weekly', status: 'processing', created_at: db.now(),
        });
        await cashout.claimPayableRows({ userId: g.recipient_id, recipientType: g.recipient_type, cashoutId });
        const transferId = await wise.sendToRecipient({
          destType: dest.dest_type, details, amountCents: balance,
          reference: `TAC weekly payout ${cashoutId.slice(0, 8)}`,
        });
        await cashout.completeCashout(cashoutId, `Sent via Wise (transfer ${transferId}).`);
        summary.paid.push({ ...ctx, via: 'Wise', ref: String(transferId) });
      } catch (e) {
        if (cashoutId) await cashout.revertCashout(cashoutId);
        summary.skipped.push({ ...g, reason: `bank transfer failed, kept payable: ${e.message}` });
      }
    } else {
      // Manual rail (or bank/Wise not configured): queue for the admin.
      await queueManualSend(ctx, dest.label);
    }
  }

  // PayPal destinations: automatic batch ONLY when the Payouts enrollment
  // is approved (PAYPAL_PAYOUTS_ENABLED=1) — otherwise manual-send queue.
  if (paypalItems.length && !PAYPAL_PAYOUTS_ENABLED) {
    for (const it of paypalItems) await queueManualSend(it, 'PayPal (manual send)');
  }

  if (paypalItems.length && PAYPAL_PAYOUTS_ENABLED) {
    const batchIds = [];
    for (const it of paypalItems) {
      it.payoutId = await db.insert('payouts', {
        recipient_type: it.recipientType, recipient_id: it.recipientId,
        amount_cents: it.amountCents, paypal_email: it.recipientEmail,
        status: 'processing', created_at: db.now(),
      });
      await db.query(
        `UPDATE commission_ledger SET status = 'queued', payout_id = ?
         WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'`,
        [it.payoutId, it.recipientType, it.recipientId]);
    }
    try {
      const batch = await paypal.createPayoutBatch({
        items: paypalItems.map((it) => ({
          recipientEmail: it.recipientEmail, amountCents: it.amountCents,
          note: 'Tattoo Art Customs weekly payout. Thank you!',
        })),
        note: 'Your weekly Tattoo Art Customs commission payout.',
      });
      const batchId = batch?.batch_header?.payout_batch_id || '';
      for (const it of paypalItems) {
        await db.update('payouts', it.payoutId, { status: 'completed', completed_at: db.now() });
        await db.query(
          `UPDATE commission_ledger SET status = 'paid', paid_at = ?
           WHERE payout_id = ? AND status = 'queued'`, [db.now(), it.payoutId]);
        summary.paid.push({ ...it, via: 'PayPal', ref: batchId });
      }
    } catch (e) {
      summary.failed = true;
      summary.error = e.message;
      for (const it of paypalItems) {
        await db.update('payouts', it.payoutId, { status: 'failed', completed_at: db.now() });
        await db.query(
          `UPDATE commission_ledger SET status = 'payable', payout_id = NULL
           WHERE payout_id = ? AND status = 'queued'`, [it.payoutId]);
      }
    }
  }

  await notifyAdmin(summary);
  return summary;
}

async function notifyAdmin(summary) {
  const lines = [`Weekly payout run — ${summary.at}`];
  if (!PAYPAL_PAYOUTS_ENABLED) {
    lines.push('MODE: manual send — PayPal Payouts auto-send is OFF (enrollment declined).');
    lines.push('Send each queued payment by hand, then mark it sent on /admin/payouts.');
  }
  for (const p of summary.paid) {
    lines.push(`PAID $${(p.amountCents / 100).toFixed(2)} to ${p.name} via ${p.via} (${p.dest?.label || ''})`);
  }
  for (const q of summary.queued) {
    lines.push(`QUEUED $${(q.amountCents / 100).toFixed(2)} for ${q.name} via ${q.via} — send manually in /admin/payouts`);
  }
  for (const s of summary.skipped) {
    lines.push(`SKIPPED ${s.recipient_type}/${String(s.recipient_id).slice(0, 8)} — ${s.reason}`);
  }
  if (summary.failed) lines.push(`PAYPAL BATCH FAILED: ${summary.error} — shares reverted to payable.`);
  const to = config.adminEmail;
  if (!to) { console.log('[autopayout]\n' + lines.join('\n')); return; }
  try {
    await sendMail({ to, subject: 'Tattoo Art Customs — weekly payout report', text: lines.join('\n') });
  } catch (e) {
    console.error('Payout report email failed:', e.message);
  }
}

module.exports = { runWeeklyPayouts, MIN_PAYOUT_CENTS };
