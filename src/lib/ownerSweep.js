// Daily owner sweep: finalize newly-cleared sales and report to the owner.
//
// A sale "clears" 24 hours after payment, provided the order is not on hold
// (admin hold = dispute / manual review). Clearing marks the owner's
// commission-ledger rows (recipient_type='site') with cleared_at. Artist and
// shop commissions are NOT touched here — they stay on the existing weekly
// Monday payout schedule to each recipient's configured payout destination.
//
// NOTE ON ACTUAL MONEY MOVEMENT: this sweep handles the ledger and the
// reporting side. PayPal funds land in the site's PayPal business account at
// sale time; moving them to the owner's bank account requires the owner to
// enable PayPal's automatic transfers (daily) in the PayPal dashboard —
// PayPal then sweeps the balance every day on its own.
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');
const { money } = require('./pricing');

const CLEARING_WINDOW_MS = 24 * 3600 * 1000;

async function runOwnerSweep({ now = Date.now(), sendEmail = true } = {}) {
  // Newly-cleared orders: paid, past the clearing window, not on hold, and
  // still having uncleared site rows.
  const orders = await db.all(
    `SELECT o.id, o.amount_paid_cents, o.paid_at FROM orders o
     WHERE o.status = 'paid' AND o.paid_at IS NOT NULL
       AND o.paid_at <= ? AND COALESCE(o.on_hold, 0) = 0
       AND EXISTS (SELECT 1 FROM commission_ledger cl
                   WHERE cl.order_id = o.id AND cl.recipient_type = 'site'
                     AND cl.cleared_at IS NULL)`,
    [now - CLEARING_WINDOW_MS]);

  let grossCents = 0;
  let ownerClearedCents = 0;
  let feesClearedCents = 0;
  for (const o of orders) {
    grossCents += o.amount_paid_cents || 0;
    const rows = await db.all(
      `SELECT id, amount_cents, commission_type FROM commission_ledger
       WHERE order_id = ? AND recipient_type = 'site' AND cleared_at IS NULL`,
      [o.id]);
    for (const r of rows) {
      ownerClearedCents += r.amount_cents;
      if (r.commission_type === 'colorization_fee') feesClearedCents += r.amount_cents;
      await db.update('commission_ledger', r.id, { cleared_at: now });
    }
  }

  // Commissions owed: artist/shop shares sitting payable, awaiting the
  // weekly Monday payout run.
  const owed = await db.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM commission_ledger
     WHERE status = 'payable' AND recipient_type IN ('artist', 'shop')`);

  const summary = {
    swept_orders: orders.length,
    gross_cents: grossCents,
    owner_cleared_cents: ownerClearedCents,
    colorization_fees_cents: feesClearedCents,
    commissions_owed_cents: owed ? owed.total : 0,
    net_to_owner_cents: ownerClearedCents,
    ran_at: now,
  };

  const lines = [
    `Daily owner sweep — ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago' })} (CT)`,
    ``,
    `Orders cleared: ${summary.swept_orders}`,
    `Gross sales cleared: ${money(summary.gross_cents)}`,
    `Net cleared to you: ${money(summary.net_to_owner_cents)}`,
    `  of which colorization fees: ${money(summary.colorization_fees_cents)}`,
    `Commissions owed (paid to artists/shops on the weekly Monday payout): ${money(summary.commissions_owed_cents)}`,
    ``,
    `Artist/shop payouts remain on the weekly Monday schedule to each`,
    `recipient's configured payout destination — unchanged.`,
  ].join('\n');

  if (sendEmail && config.adminEmail) {
    await sendMail({
      to: config.adminEmail,
      subject: `Daily sweep: ${money(summary.net_to_owner_cents)} cleared (${summary.swept_orders} orders)`,
      text: lines,
    });
  } else {
    console.log('[owner-sweep] (no ADMIN_EMAIL configured)\n' + lines);
  }
  return { ...summary, report: lines };
}

module.exports = { runOwnerSweep };
