// Commission cashout options.
//
// Two ways for artists/shops to get paid:
//   1. Weekly automatic payout (free, full amount) — every Monday ~9am CT,
//      to their default destination. PayPal + Wise-bank destinations send
//      automatically; other digital wallets queue for the admin to send.
//   2. Early cashout (on demand, at most once per 24h) — the recipient takes
//      97% now and the site keeps a 3% early-cashout penalty.
//
// Destinations: PayPal, bank account (ACH via Wise when configured),
// Cash App, Venmo, Zelle, Chime, Varo, Wise, or another digital wallet.
// Anything without an automated rail queues in /admin/payouts for the admin
// to send manually and mark complete.
const db = require('../db');
const { payableBalance, recipientEligible } = require('./commissions');
const { upsertProfile } = require('./profiles');
const paypal = require('./paypal');
const wise = require('./wise');

const EARLY_FEE_BPS = 300; // 3% early-cashout penalty
const MIN_CASHOUT_CENTS = 500; // $5 minimum
const EARLY_COOLDOWN_MS = 24 * 3600 * 1000; // one early cashout per day

// Payouts and commissions require an ACTIVE designer or tattoo shop
// subscription (plus a payout method). Customer subscriptions can never
// receive commissions — the commission engine records those shares as
// site_kept, and these guards close the gap if a subscription lapses
// between earning and payout.
function roleForRecipientType(recipientType) {
  if (recipientType === 'artist') return 'design_artist';
  if (recipientType === 'admin') return 'admin';
  return 'tattoo_shop';
}
async function requirePayoutEligible(userId, recipientType) {
  // Admin task pay: the recipient must be an actual admin (admin/head_admin)
  // holding an active designer or tattoo shop subscription — same payout
  // destination + forfeiture rules as everyone else.
  if (recipientType === 'admin') {
    const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
    if (!user || (user.role !== 'admin' && user.role !== 'head_admin')) {
      throw new Error('Admin task pay requires an admin account.');
    }
    return requireAnyPayoutEligible(userId);
  }
  const ok = await recipientEligible(userId, roleForRecipientType(recipientType));
  if (!ok) {
    throw new Error('Payouts require an active designer or tattoo shop subscription with a payout method set up. Customer subscriptions cannot receive commissions.');
  }
}
// Either role qualifies (used for site-credit withdrawals of commission
// earnings, which aren't tied to one recipient type).
async function requireAnyPayoutEligible(userId) {
  const artistOk = await recipientEligible(userId, 'design_artist');
  const shopOk = await recipientEligible(userId, 'tattoo_shop');
  if (!artistOk && !shopOk) {
    throw new Error('Withdrawing commission earnings requires an active designer or tattoo shop subscription. Customer subscriptions cannot receive commissions.');
  }
}

// dest_type -> { label, fields: [{key,label,type,placeholder}], hint, auto }
// auto: 'paypal' | 'wise' | false (manual admin send)
const DEST_TYPES = {
  paypal: {
    label: 'PayPal', auto: 'paypal',
    fields: [{ key: 'email', label: 'PayPal email', type: 'email', placeholder: 'you@example.com' }],
    hint: 'Sent automatically — no waiting on anyone.',
  },
  bank: {
    label: 'Bank account', auto: 'wise',
    fields: [
      { key: 'account_holder', label: 'Account holder name', type: 'text', placeholder: 'Full name on the account' },
      { key: 'routing_number', label: 'Routing number', type: 'text', placeholder: '9 digits' },
      { key: 'account_number', label: 'Account number', type: 'text', placeholder: 'Account number' },
      { key: 'account_type', label: 'Account type', type: 'select', options: ['checking', 'savings'] },
    ],
    hint: 'Sent automatically once bank transfers are enabled; otherwise the admin sends it manually.',
  },
  cashapp: {
    label: 'Cash App', auto: false,
    fields: [{ key: 'cashtag', label: '$cashtag', type: 'text', placeholder: '$yourtag' }],
    hint: 'The admin sends this manually — usually within a few days.',
  },
  venmo: {
    label: 'Venmo', auto: false,
    fields: [{ key: 'handle', label: 'Venmo username', type: 'text', placeholder: '@username' }],
    hint: 'The admin sends this manually — usually within a few days.',
  },
  zelle: {
    label: 'Zelle', auto: false,
    fields: [{ key: 'identifier', label: 'Zelle email or phone', type: 'text', placeholder: 'you@example.com' }],
    hint: 'The admin sends this manually — usually within a few days.',
  },
  chime: {
    label: 'Chime', auto: false,
    fields: [{ key: 'identifier', label: 'Chime $ChimeTag or email', type: 'text', placeholder: '$yourtag' }],
    hint: 'The admin sends this manually — usually within a few days.',
  },
  varo: {
    label: 'Varo', auto: false,
    fields: [{ key: 'identifier', label: 'Varo email or phone', type: 'text', placeholder: 'you@example.com' }],
    hint: 'The admin sends this manually — usually within a few days.',
  },
  wise: {
    label: 'Wise', auto: 'wise',
    fields: [{ key: 'email', label: 'Wise account email', type: 'email', placeholder: 'you@example.com' }],
    hint: 'Sent automatically once bank transfers are enabled; otherwise the admin sends it manually.',
  },
  other: {
    label: 'Other digital wallet', auto: false,
    fields: [
      { key: 'wallet_name', label: 'Wallet / app name', type: 'text', placeholder: 'e.g. Revolut' },
      { key: 'identifier', label: 'Your handle, tag, or email there', type: 'text', placeholder: '' },
    ],
    hint: 'The admin sends this manually — usually within a few days.',
  },
};

function maskDetails(destType, details) {
  const d = { ...(details || {}) };
  if (d.account_number && d.account_number.length > 4) d.account_number = '••••' + d.account_number.slice(-4);
  if (d.routing_number && d.routing_number.length > 4) d.routing_number = '•••' + d.routing_number.slice(-4);
  return d;
}

function destSummary(dest) {
  const details = JSON.parse(dest.details || '{}');
  const t = DEST_TYPES[dest.dest_type];
  const id = details.email || details.cashtag || details.handle || details.identifier
    || (details.account_number ? `••••${String(details.account_number).slice(-4)}` : '')
    || details.wallet_name || '';
  return `${t ? t.label : dest.dest_type}${id ? ` — ${id}` : ''}`;
}

async function listDestinations(userId) {
  const rows = await db.all(
    'SELECT * FROM payout_destinations WHERE user_id = ? ORDER BY is_default DESC, created_at', [userId]);
  return rows.map((r) => ({ ...r, summary: destSummary(r), masked: maskDetails(r.dest_type, JSON.parse(r.details || '{}')) }));
}

async function getDefaultDestination(userId) {
  const dests = await listDestinations(userId);
  return dests[0] || null;
}

// Backfill: recipients who only ever set the legacy payout_paypal_email get a
// PayPal destination created from it automatically. Customers have no profile
// table, so there is nothing to backfill for them.
async function ensureLegacyDestination(userId, recipientType) {
  if (recipientType === 'customer') return;
  const existing = await db.get('SELECT id FROM payout_destinations WHERE user_id = ? LIMIT 1', [userId]);
  if (existing) return;
  const table = recipientType === 'artist' ? 'artist_profiles' : 'shop_profiles';
  const prof = await db.get(`SELECT payout_paypal_email FROM ${table} WHERE user_id = ?`, [userId]);
  const email = (prof?.payout_paypal_email || '').trim();
  if (email) {
    await addDestination({ userId, recipientType, destType: 'paypal', details: { email } });
  }
}

async function addDestination({ userId, recipientType, destType, details }) {
  const spec = DEST_TYPES[destType];
  if (!spec) throw new Error('Unknown destination type.');
  const clean = {};
  for (const f of spec.fields) {
    const v = String(details[f.key] || '').trim().slice(0, 120);
    if (!v) throw new Error(`${f.label} is required.`);
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`Enter a valid ${f.label.toLowerCase()}.`);
    clean[f.key] = v;
  }
  if (destType === 'bank' && !/^\d{9}$/.test(clean.routing_number)) throw new Error('Routing number must be 9 digits.');
  const count = await db.get('SELECT COUNT(*) AS n FROM payout_destinations WHERE user_id = ?', [userId]);
  const id = await db.insert('payout_destinations', {
    user_id: userId, recipient_type: recipientType, dest_type: destType,
    label: spec.label, details: JSON.stringify(clean),
    is_default: count.n === 0 ? 1 : 0, created_at: db.now(),
  });
  return id;
}

async function setDefaultDestination(userId, destId) {
  const dest = await db.get('SELECT id FROM payout_destinations WHERE id = ? AND user_id = ?', [destId, userId]);
  if (!dest) throw new Error('Destination not found.');
  await db.query('UPDATE payout_destinations SET is_default = 0 WHERE user_id = ?', [userId]);
  await db.query('UPDATE payout_destinations SET is_default = 1 WHERE id = ?', [destId]);
}

async function deleteDestination(userId, destId) {
  await db.query('DELETE FROM payout_destinations WHERE id = ? AND user_id = ?', [destId, userId]);
  const remaining = await db.get('SELECT id FROM payout_destinations WHERE user_id = ? ORDER BY created_at LIMIT 1', [userId]);
  if (remaining) await db.query('UPDATE payout_destinations SET is_default = 1 WHERE id = ?', [remaining.id]);
}

async function getCashoutMode(userId, recipientType) {
  await ensureLegacyDestination(userId, recipientType);
  const table = recipientType === 'artist' ? 'artist_profiles' : 'shop_profiles';
  const prof = await db.get(`SELECT cashout_mode FROM ${table} WHERE user_id = ?`, [userId]);
  return prof?.cashout_mode || 'weekly';
}

async function setCashoutMode(userId, recipientType, mode) {
  if (!['weekly', 'manual'].includes(mode)) throw new Error('Invalid cashout mode.');
  const table = recipientType === 'artist' ? 'artist_profiles' : 'shop_profiles';
  await upsertProfile(table, userId, { cashout_mode: mode });
}

function earlyQuote(amountCents) {
  const penalty = Math.round((amountCents * EARLY_FEE_BPS) / 10000);
  return { penaltyCents: penalty, netCents: amountCents - penalty };
}

// Move payable ledger rows into a cashout request (status queued, linked).
async function claimPayableRows({ userId, recipientType, cashoutId }) {
  const rows = await db.all(
    "SELECT id, amount_cents FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'",
    [recipientType, userId]);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  if (!total) throw new Error('No payable balance to cash out.');
  await db.query(
    `UPDATE commission_ledger SET status = 'queued', cashout_id = ?
     WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'`,
    [cashoutId, recipientType, userId]);
  return { rows, total };
}

async function revertCashout(cashoutId) {
  const req_ = await db.get('SELECT source, amount_cents FROM cashout_requests WHERE id = ?', [cashoutId]);
  await db.query(
    "UPDATE commission_ledger SET status = 'payable', cashout_id = NULL WHERE cashout_id = ? AND status = 'queued'",
    [cashoutId]);
  if (req_?.source === 'credit') {
    // Return the debited wallet credit.
    await db.insert('account_credits', {
      user_id: (await db.get('SELECT user_id FROM cashout_requests WHERE id = ?', [cashoutId])).user_id,
      amount_cents: req_.amount_cents, kind: 'withdrawal_revert', ref_id: cashoutId,
      note: 'Withdrawal failed — credit restored.', created_at: db.now(),
    });
  }
  await db.update('cashout_requests', cashoutId, { status: 'failed', processed_at: db.now() });
}

async function completeCashout(cashoutId, note = '') {
  await db.update('cashout_requests', cashoutId, { status: 'completed', processed_at: db.now(), note });
  await db.query(
    "UPDATE commission_ledger SET status = 'paid', paid_at = ? WHERE cashout_id = ? AND status = 'queued'",
    [db.now(), cashoutId]);
}

// Shared send step: PayPal auto / Wise-bank auto / manual queue for the admin.
// Throws on send failure; the caller reverts its own claim (ledger or credit).
async function dispatchCashout({ cashoutId, dest, netCents, kindLabel }) {
  const spec = DEST_TYPES[dest.dest_type];
  const details = JSON.parse(dest.details || '{}');
  if (spec.auto === 'paypal') {
    await paypal.createPayoutBatch({
      items: [{ recipientEmail: details.email, amountCents: netCents, note: `Tattoo Art Customs ${kindLabel} (3% early-cashout fee applied).` }],
      note: `Your ${kindLabel} from Tattoo Art Customs.`,
    });
    await completeCashout(cashoutId, 'Sent via PayPal Payouts.');
  } else if (spec.auto === 'wise' && wise.isConfigured()) {
    const transferId = await wise.sendToRecipient({ destType: dest.dest_type, details, amountCents: netCents, reference: `TAC ${kindLabel} ${cashoutId.slice(0, 8)}` });
    await completeCashout(cashoutId, `Sent via Wise (transfer ${transferId}).`);
  } else {
    // Manual rail (Cash App, Venmo, Zelle, Chime, Varo, other, or bank/Wise
    // not configured yet): queue for the admin to send.
    await db.update('cashout_requests', cashoutId, { status: 'pending', note: 'Awaiting admin send.' });
  }
  return db.get('SELECT * FROM cashout_requests WHERE id = ?', [cashoutId]);
}

// --- Early (on-demand) cashout: 97% now, 3% penalty, once per 24h ---
async function requestEarlyCashout({ userId, recipientType, destinationId }) {
  const dest = await db.get(
    'SELECT * FROM payout_destinations WHERE id = ? AND user_id = ?', [destinationId, userId]);
  if (!dest) throw new Error('Choose one of your payout destinations.');
  await requirePayoutEligible(userId, recipientType);

  const last = await db.get(
    "SELECT created_at FROM cashout_requests WHERE user_id = ? AND kind IN ('early','withdrawal') AND status != 'canceled' ORDER BY created_at DESC LIMIT 1",
    [userId]);
  if (last && Date.now() - last.created_at < EARLY_COOLDOWN_MS) {
    const hrs = Math.ceil((EARLY_COOLDOWN_MS - (Date.now() - last.created_at)) / 3600000);
    throw new Error(`Cashout is available once a day — try again in about ${hrs} hour(s). The free weekly payout is always an option.`);
  }

  const balance = await payableBalance(recipientType, userId);
  if (balance < MIN_CASHOUT_CENTS) {
    throw new Error(`You need at least $${(MIN_CASHOUT_CENTS / 100).toFixed(2)} payable to cash out.`);
  }

  const { penaltyCents, netCents } = earlyQuote(balance);
  const details = JSON.parse(dest.details || '{}');
  const cashoutId = await db.insert('cashout_requests', {
    user_id: userId, recipient_type: recipientType, destination_id: dest.id, source: 'commission',
    dest_snapshot: JSON.stringify({ dest_type: dest.dest_type, label: dest.label, details }),
    amount_cents: balance, penalty_cents: penaltyCents, net_cents: netCents,
    kind: 'early', status: 'processing', created_at: db.now(),
  });

  try {
    await claimPayableRows({ userId, recipientType, cashoutId });
  } catch (e) {
    await db.update('cashout_requests', cashoutId, { status: 'canceled', processed_at: db.now(), note: e.message });
    throw e;
  }

  try {
    return await dispatchCashout({ cashoutId, dest, netCents, kindLabel: 'early cashout' });
  } catch (e) {
    await revertCashout(cashoutId);
    throw new Error(`Cashout failed and your balance was restored: ${e.message}`);
  }
}

async function cancelCashout({ userId, cashoutId }) {
  const req_ = await db.get(
    "SELECT id FROM cashout_requests WHERE id = ? AND user_id = ? AND status = 'pending'", [cashoutId, userId]);
  if (!req_) throw new Error('Only pending cashouts can be canceled.');
  await revertCashout(req_.id);
  await db.update('cashout_requests', req_.id, { status: 'canceled' });
}

module.exports = {
  DEST_TYPES, EARLY_FEE_BPS, MIN_CASHOUT_CENTS, EARLY_COOLDOWN_MS,
  destSummary, maskDetails, earlyQuote,
  listDestinations, getDefaultDestination, ensureLegacyDestination,
  addDestination, setDefaultDestination, deleteDestination,
  getCashoutMode, setCashoutMode,
  requestEarlyCashout, cancelCashout, revertCashout, completeCashout, claimPayableRows,
  dispatchCashout, requirePayoutEligible, requireAnyPayoutEligible, roleForRecipientType,
};
