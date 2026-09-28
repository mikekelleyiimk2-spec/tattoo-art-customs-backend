// Weekly automated commission payouts.
//
// runWeeklyPayouts() gathers every 'payable' commission share, groups by
// recipient, and sends them in one PayPal Payouts batch. Recipients without
// a payout email, or owed less than the minimum, are skipped and left as
// payable (the admin can still pay them manually from /admin/payouts).
//
// Safety: if PayPal Payouts isn't enabled on the business account (it needs
// separate PayPal approval) or the API call fails, every ledger row is
// reverted to 'payable' — money never moves halfway. The function never
// throws; it always returns a summary, and the summary is emailed to the
// site admin (or logged when SMTP isn't configured).
const db = require('../db');
const config = require('../config');
const paypal = require('./paypal');
const { sendMail } = require('./mail');

const MIN_PAYOUT_CENTS = 500; // $5 — below this, PayPal fees eat the payout.

async function payoutEmailFor(recipientType, recipientId) {
  const table = recipientType === 'artist' ? 'artist_profiles' : 'shop_profiles';
  const row = await db.get(`SELECT payout_paypal_email FROM ${table} WHERE user_id = ?`, [recipientId]);
  return (row?.payout_paypal_email || '').trim();
}

async function runWeeklyPayouts() {
  const summary = {
    at: new Date().toISOString(),
    paid: [], skipped: [], failed: false, error: '',
  };
  const groups = await db.all(
    `SELECT recipient_type, recipient_id, COALESCE(SUM(amount_cents),0) AS total,
            COUNT(*) AS shares
     FROM commission_ledger WHERE status = 'payable'
     GROUP BY recipient_type, recipient_id`);

  const items = [];
  for (const g of groups) {
    const email = await payoutEmailFor(g.recipient_type, g.recipient_id);
    if (!email) {
      summary.skipped.push({ ...g, reason: 'no payout email on file' });
      continue;
    }
    if (g.total < MIN_PAYOUT_CENTS) {
      summary.skipped.push({ ...g, reason: `below $${(MIN_PAYOUT_CENTS / 100).toFixed(2)} minimum` });
      continue;
    }
    const user = await db.get('SELECT display_name FROM users WHERE id = ?', [g.recipient_id]);
    items.push({
      recipientType: g.recipient_type,
      recipientId: g.recipient_id,
      recipientEmail: email,
      name: user?.display_name || email,
      amountCents: g.total,
      shares: g.shares,
    });
  }

  if (!items.length) {
    summary.note = 'Nothing to pay this week.';
    await notifyAdmin(summary);
    return summary;
  }

  // Create payout rows and move ledger shares payable -> queued.
  for (const it of items) {
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
      items: items.map((it) => ({
        recipientEmail: it.recipientEmail,
        amountCents: it.amountCents,
        note: `Tattoo Art Customs weekly payout — ${it.shares} commission share(s). Thank you!`,
      })),
      note: 'Your weekly Tattoo Art Customs commission payout.',
    });
    const batchId = batch?.batch_header?.payout_batch_id || '';
    for (const it of items) {
      await db.update('payouts', it.payoutId, { status: 'completed', completed_at: db.now() });
      await db.query(
        `UPDATE commission_ledger SET status = 'paid', paid_at = ?
         WHERE payout_id = ? AND status = 'queued'`, [db.now(), it.payoutId]);
      summary.paid.push({ ...it, batchId });
    }
  } catch (e) {
    // Revert everything to payable — nothing moved halfway.
    summary.failed = true;
    summary.error = e.message;
    for (const it of items) {
      await db.update('payouts', it.payoutId, { status: 'failed', completed_at: db.now() });
      await db.query(
        `UPDATE commission_ledger SET status = 'payable', payout_id = NULL
         WHERE payout_id = ? AND status = 'queued'`, [it.payoutId]);
    }
  }

  await notifyAdmin(summary);
  return summary;
}

async function notifyAdmin(summary) {
  const lines = [`Weekly payout run — ${summary.at}`];
  for (const p of summary.paid) {
    lines.push(`PAID $${(p.amountCents / 100).toFixed(2)} to ${p.name} <${p.recipientEmail}> (${p.shares} shares)`);
  }
  for (const s of summary.skipped) {
    lines.push(`SKIPPED ${s.recipient_type}/${String(s.recipient_id).slice(0, 8)} $${(s.total / 100).toFixed(2)} — ${s.reason}`);
  }
  if (summary.failed) lines.push(`FAILED: ${summary.error} — all shares reverted to payable for manual processing.`);
  if (summary.note) lines.push(summary.note);
  const to = config.adminEmail;
  if (!to) { console.log('[autopayout]\n' + lines.join('\n')); return; }
  try {
    await sendMail({ to, subject: 'Tattoo Art Customs — weekly payout report', text: lines.join('\n') });
  } catch (e) {
    console.error('Payout report email failed:', e.message);
  }
}

module.exports = { runWeeklyPayouts, MIN_PAYOUT_CENTS };
