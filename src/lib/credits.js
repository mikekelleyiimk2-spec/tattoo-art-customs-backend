// Site credit (wallet): top up with PayPal, keep commissions as credit,
// spend at checkout, or withdraw to a payout destination (3% early-cashout
// penalty auto-withheld on withdrawal — same rule as early commission cashout).
const db = require('../db');
const config = require('../config');
const paypal = require('./paypal');
const pricing = require('./pricing');
const cashout = require('./cashout');
const { recordSaleCommissions } = require('./commissions');
const { onOrderPaid } = require('./printful');
const { routeCustomOrder } = require('./customFulfillment');
const { fulfillPremadeOrder } = require('./fulfillment');

const MIN_TOPUP_CENTS = 500; // $5 minimum top-up

async function getCreditBalance(userId) {
  const row = await db.get(
    'SELECT COALESCE(SUM(amount_cents),0) AS total FROM account_credits WHERE user_id = ?', [userId]);
  return row.total;
}

async function addCredit({ userId, amountCents, kind, refId = null, note = '' }) {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error('Invalid credit amount.');
  return db.insert('account_credits', {
    user_id: userId, amount_cents: amountCents, kind, ref_id: refId, note, created_at: db.now(),
  });
}

async function creditHistory(userId, limit = 25) {
  return db.all('SELECT * FROM account_credits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

// --- Top up with PayPal ---
async function createTopup({ userId, amountCents }) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS) {
    throw new Error(`Minimum top-up is $${(MIN_TOPUP_CENTS / 100).toFixed(2)}.`);
  }
  if (amountCents > 100000) throw new Error('Maximum top-up is $1,000.');
  // The processing fee is added to the charge; only the base amount becomes credit.
  const fee = pricing.processingFeeCents(amountCents);
  const topupId = await db.insert('credit_topups', {
    user_id: userId, amount_cents: amountCents, fee_cents: fee, status: 'pending', created_at: db.now(),
  });
  const pp = await paypal.createCheckoutOrder({
    amountCents: amountCents + fee,
    description: `Tattoo Art Customs — $${(amountCents / 100).toFixed(2)} site credit`,
    returnUrl: `${config.baseUrl}/account/topup/approve/${topupId}`,
    cancelUrl: `${config.baseUrl}/account`,
  });
  await db.update('credit_topups', topupId, { paypal_order_id: pp.id });
  const approve = pp.links.find((l) => l.rel === 'approve');
  return { topupId, approveUrl: approve.href };
}

async function completeTopup({ userId, topupId }) {
  const topup = await db.get('SELECT * FROM credit_topups WHERE id = ? AND user_id = ?', [topupId, userId]);
  if (!topup) throw new Error('Top-up not found.');
  if (topup.status === 'completed') return getCreditBalance(userId);
  if (topup.status !== 'pending') throw new Error('This top-up is no longer valid.');
  const capture = await paypal.captureCheckoutOrder(topup.paypal_order_id);
  const expected = topup.amount_cents + (topup.fee_cents || 0);
  // Throws unless the captured amount exactly matches — a short capture
  // leaves the top-up pending instead of crediting phantom money.
  paypal.assertCaptureAmount(capture, expected);
  await addCredit({ userId, amountCents: topup.amount_cents, kind: 'topup', refId: topupId, note: 'PayPal top-up' });
  await db.update('credit_topups', topupId, { status: 'completed', completed_at: db.now() });
  return getCreditBalance(userId);
}

// --- Keep commission payouts as site credit (no fee — you're not withdrawing) ---
// Requires an active designer/shop subscription: customer subscriptions
// can never touch commission money.
async function moveCommissionsToCredit({ userId, recipientType }) {
  await cashout.requirePayoutEligible(userId, recipientType);
  const { payableBalance } = require('./commissions');
  const balance = await payableBalance(recipientType, userId);
  if (balance <= 0) throw new Error('No payable commissions to move.');
  const moveId = await db.insert('account_credits', {
    user_id: userId, amount_cents: balance, kind: 'commission_move', ref_id: null,
    note: 'Commissions kept as site credit', created_at: db.now(),
  });
  await db.query(
    `UPDATE commission_ledger SET status = 'paid', paid_at = ?
     WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'`,
    [db.now(), recipientType, userId]);
  return { creditedCents: balance, moveId };
}

// Money the user put in themselves (PayPal top-ups, plus reverted
// withdrawals) minus what they've already spent or withdrawn. This is always
// theirs to withdraw — no subscription needed. Anything above it is
// commission-derived and requires an active designer or shop subscription.
async function ownMoneyBalance(userId) {
  const row = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN kind IN ('topup','withdrawal_revert') THEN amount_cents END),0) AS ins,
       COALESCE(SUM(CASE WHEN kind IN ('purchase_spend','withdrawal') THEN -amount_cents END),0) AS outs
     FROM account_credits WHERE user_id = ?`, [userId]);
  return Math.max(0, row.ins - row.outs);
}

// --- Withdraw credit to a payout destination: 3% auto-withheld, once per 24h ---
async function requestWithdrawal({ userId, destinationId, amountCents = null }) {
  const dest = await db.get(
    'SELECT * FROM payout_destinations WHERE id = ? AND user_id = ?', [destinationId, userId]);
  if (!dest) throw new Error('Choose one of your payout destinations.');

  const last = await db.get(
    "SELECT created_at FROM cashout_requests WHERE user_id = ? AND kind IN ('early','withdrawal') AND status != 'canceled' ORDER BY created_at DESC LIMIT 1",
    [userId]);
  if (last && Date.now() - last.created_at < cashout.EARLY_COOLDOWN_MS) {
    const hrs = Math.ceil((cashout.EARLY_COOLDOWN_MS - (Date.now() - last.created_at)) / 3600000);
    throw new Error(`Withdrawals are available once a day — try again in about ${hrs} hour(s).`);
  }

  const balance = await getCreditBalance(userId);
  const amount = amountCents == null ? balance : amountCents;
  if (!Number.isInteger(amount) || amount < cashout.MIN_CASHOUT_CENTS) {
    throw new Error(`Minimum withdrawal is $${(cashout.MIN_CASHOUT_CENTS / 100).toFixed(2)}.`);
  }
  if (amount > balance) throw new Error('Withdrawal exceeds your credit balance.');

  // Withdrawing your own topped-up money is always allowed. Withdrawing
  // commission earnings requires an active designer or shop subscription —
  // customer subscriptions can never receive commissions.
  const ownMoney = await ownMoneyBalance(userId);
  if (amount > ownMoney) await cashout.requireAnyPayoutEligible(userId);

  const { penaltyCents, netCents } = cashout.earlyQuote(amount);
  const details = JSON.parse(dest.details || '{}');
  const cashoutId = await db.insert('cashout_requests', {
    user_id: userId, recipient_type: 'customer', destination_id: dest.id, source: 'credit',
    dest_snapshot: JSON.stringify({ dest_type: dest.dest_type, label: dest.label, details }),
    amount_cents: amount, penalty_cents: penaltyCents, net_cents: netCents,
    kind: 'withdrawal', status: 'processing', created_at: db.now(),
  });
  await addCredit({ userId, amountCents: -amount, kind: 'withdrawal', refId: cashoutId, note: `Withdrawal (3% fee: $${(penaltyCents / 100).toFixed(2)} withheld)` });

  try {
    return await cashout.dispatchCashout({ cashoutId, dest, netCents, kindLabel: 'credit withdrawal' });
  } catch (e) {
    await cashout.revertCashout(cashoutId);
    throw new Error(`Withdrawal failed and your credit was restored: ${e.message}`);
  }
}

// --- Pay for an order with site credit ---
async function payOrderWithCredit({ userId, orderId }) {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [orderId, userId]);
  if (!order) throw new Error('Order not found.');
  if (order.status !== 'pending') throw new Error('This order is already paid.');
  // Custom orders collect only the 50% deposit at checkout (+ any rush fee).
  const chargeCents = order.order_type === 'custom' && order.deposit_cents > 0
    ? order.deposit_cents + (order.rush_fee_cents || 0)
    : order.amount_cents;
  const balance = await getCreditBalance(userId);
  if (balance < chargeCents) {
    throw new Error(`Not enough site credit — you need $${(chargeCents / 100).toFixed(2)} and have $${(balance / 100).toFixed(2)}.`);
  }
  await addCredit({ userId, amountCents: -chargeCents, kind: 'purchase_spend', refId: order.id, note: `Paid for order ${order.id.slice(0, 8)} with site credit` });
  await db.update('orders', order.id, {
    status: 'paid', amount_paid_cents: chargeCents, payment_method: 'credit', paid_at: db.now(),
  });
  const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  await recordSaleCommissions(fresh);
  const { fulfillPremadeOrder, sendCustomDepositReceipt } = require('./fulfillment');
  const fulfil = await onOrderPaid(fresh);
  await routeCustomOrder(fresh);
  await fulfillPremadeOrder(fresh); // premades deliver instantly: token + receipt email
  await require('./littleInkers').fulfillSendToApp(fresh); // send-to-app: mint LIL- code
  if (fresh.order_type === 'custom') await sendCustomDepositReceipt(fresh); // deposit receipt (+ first-custom line item)
  try { await require('./saleWatch').watchOrderPaid(fresh); } catch (e) { console.error('sale watch failed:', e.message); }
  return { order: fresh, printSubmitted: fulfil.submitted };
}

module.exports = {
  MIN_TOPUP_CENTS,
  getCreditBalance, addCredit, creditHistory,
  createTopup, completeTopup,
  moveCommissionsToCredit, requestWithdrawal, payOrderWithCredit,
};
