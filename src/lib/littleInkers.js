// Little Inkers pipeline: redeem codes (TAC -> kids app) and submission
// codes (kids app -> TAC doodle-to-tattoo orders).
//
// Kid side stays isolated: the app only ever REDEEMS LIL- codes (designs in)
// and MINTS TAC- codes for parents (artwork out via the parent's own share).
// All tattoo transactions happen on this website, never in the kids app.
const crypto = require('crypto');
const db = require('../db');

// Small fee to send a design to the Little Inkers app (added at purchase).
const SEND_TO_APP_FEE_CENTS = 99;
// Doodle-to-tattoo tiers.
const DOODLE_LIGHT_CENTS = 4999; // "True to the Doodle" — light cleanup

const REDEEM_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function randomCode(prefix) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
  let s = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += chars[buf[i] % chars.length];
  return `${prefix}-${s}`;
}

async function mintRedeemCode(designId, userId, orderId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode('LIL');
    try {
      await db.insert('redeem_codes', {
        code,
        design_id: designId,
        issued_to_user: userId,
        order_id: orderId || null,
        used: 0,
        expires_at: Date.now() + REDEEM_TTL_MS,
        created_at: db.now(),
      });
      return code;
    } catch (e) {
      if (!/unique|duplicate|PRIMARY/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('could not mint redeem code');
}

// Validate a LIL-XXXXXX code from the app. Marks it used on success.
// Returns { ok, design } or { ok:false, error }.
async function redeemCode(code, { markUsed = true } = {}) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^LIL-[A-Z0-9]{6}$/.test(clean)) return { ok: false, error: 'bad format' };
  const row = await db.get('SELECT * FROM redeem_codes WHERE code = ?', [clean]);
  if (!row) return { ok: false, error: 'unknown code' };
  if (row.used) return { ok: false, error: 'already used' };
  if (row.expires_at < Date.now()) return { ok: false, error: 'expired' };
  const design = await db.get(
    "SELECT id, title, linework_wm_path FROM designs WHERE id = ? AND status = 'approved'",
    [row.design_id]
  );
  if (!design) return { ok: false, error: 'design unavailable' };
  if (markUsed) {
    await db.updateWhere('redeem_codes', { used: 1 }, 'code', clean);
  }
  const file = (design.linework_wm_path || '').split('/').pop();
  return {
    ok: true,
    design: {
      id: design.id,
      title: design.title,
      // Watermarked linework — the app never receives clean masters.
      linework_url: file ? `/img/designs/${file}` : null,
    },
  };
}

async function mintSubmissionCode(userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode('TAC');
    try {
      await db.insert('submission_codes', {
        code,
        created_by_user: userId || null,
        order_id: null,
        created_at: db.now(),
      });
      return code;
    } catch (e) {
      if (!/unique|duplicate|PRIMARY/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('could not mint submission code');
}

// Validate a TAC-XXXXXX code on the doodle-to-tattoo page. Does NOT consume
// it — consumption happens when the paid order is created.
async function checkSubmissionCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^TAC-[A-Z0-9]{6}$/.test(clean)) return { ok: false, error: 'bad format' };
  const row = await db.get('SELECT * FROM submission_codes WHERE code = ?', [clean]);
  if (!row) return { ok: false, error: 'unknown code' };
  return { ok: true, code: clean };
}

async function consumeSubmissionCode(code, orderId) {
  const clean = String(code || '').trim().toUpperCase();
  await db.updateWhere('submission_codes', { order_id: orderId }, 'code', clean);
}

// Called when any order reaches 'paid'. Mints the LIL- code for
// send-to-app orders. Never throws (fulfillment must not break payment).
async function fulfillSendToApp(order) {
  try {
    if (!order || order.order_type !== 'send_to_app') return null;
    const existing = await db.get(
      'SELECT code FROM redeem_codes WHERE order_id = ?', [order.id]
    );
    if (existing) return existing.code;
    const designId = order.design_id;
    if (!designId) return null;
    return await mintRedeemCode(designId, order.buyer_id, order.id);
  } catch (e) {
    console.error('[littleInkers] fulfillSendToApp failed:', e.message);
    return null;
  }
}

module.exports = {
  SEND_TO_APP_FEE_CENTS,
  DOODLE_LIGHT_CENTS,
  mintRedeemCode,
  redeemCode,
  mintSubmissionCode,
  checkSubmissionCode,
  consumeSubmissionCode,
  fulfillSendToApp,
};
