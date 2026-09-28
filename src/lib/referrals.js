// Refer-a-friend rewards and the $1-first-month incentive.
//
// Refer-a-friend:
//   - Every user has a referral code (users.referral_code, "TAC-XXXXXX"),
//     generated lazily by ensureReferralCode().
//   - A friend who signs up with ?ref=CODE (or types the code on the
//     signup page) gets users.referred_by set to the referrer.
//   - When the friend's subscription becomes ACTIVE (a paying subscriber),
//     grantReferralReward() extends the referrer's membership by one month:
//       users.membership_extended_until moves +30 days (counted by
//       hasActiveSubscription/hasAnyActiveSubscription), and the referrer's
//       PayPal subscription is suspended for the free month (best effort;
//       resumes automatically via the daily scheduler job) so they are not
//       billed during it.
//   - referral_redemptions has a UNIQUE index on subscription_id: each
//     referred subscription grants exactly one free month, ever.
//
// $1 first month:
//   - firstMonthDiscountEligible(userId): true until the discount has been
//     applied once for that user.
//   - The subscription is created with a PayPal $1 trial cycle (see
//     paypal.firstMonthTrialCycles); markFirstMonthUsed() records it.
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');
const { ownerUserId } = require('./commissions');

const FREE_MONTH_MS = 30 * 86400000;

function makeReferralCode() {
  return 'TAC-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Generate (once) and return this user's referral code.
async function ensureReferralCode(userId) {
  const u = await db.get('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  if (u.referral_code) return u.referral_code;
  for (let i = 0; i < 5; i++) {
    const code = makeReferralCode();
    try {
      await db.update('users', userId, { referral_code: code });
      return code;
    } catch { /* collision — try again */ }
  }
  return null;
}

// Resolve a friend's referral code to a user id (null when unknown).
async function resolveReferralCode(code) {
  const clean = String(code || '').trim().toUpperCase().slice(0, 16);
  if (!clean) return null;
  const u = await db.get('SELECT id FROM users WHERE referral_code = ?', [clean]);
  return u ? u.id : null;
}

// Record who referred a new signup. Never self-refer.
async function recordSignupReferral(newUserId, code) {
  const referrerId = await resolveReferralCode(code);
  if (!referrerId || referrerId === newUserId) return null;
  await db.update('users', newUserId, { referred_by: referrerId });
  return referrerId;
}

// $1 first month: eligible until it has been applied once for this user.
async function firstMonthDiscountEligible(userId) {
  const u = await db.get('SELECT first_month_discount_used FROM users WHERE id = ?', [userId]);
  return !!u && !u.first_month_discount_used;
}

async function markFirstMonthUsed(userId) {
  await db.update('users', userId, { first_month_discount_used: 1 });
}

// The referred friend became a paying subscriber: extend the referrer's
// membership by one free month. Idempotent per subscription (UNIQUE index).
async function grantReferralReward(referredUserId, subscriptionId, now = Date.now()) {
  const referred = await db.get(
    'SELECT id, referred_by, display_name FROM users WHERE id = ?', [referredUserId]);
  if (!referred || !referred.referred_by) return null;
  const referrer = await db.get(
    'SELECT id, email, display_name, membership_extended_until FROM users WHERE id = ?',
    [referred.referred_by]);
  if (!referrer) return null;
  const existing = await db.get(
    'SELECT id FROM referral_redemptions WHERE subscription_id = ?', [subscriptionId]);
  if (existing) return existing;

  const start = now;
  const base = Math.max(now, referrer.membership_extended_until || 0);
  const end = base + FREE_MONTH_MS;
  await db.update('users', referrer.id, { membership_extended_until: end });

  // Suspend the referrer's PayPal billing for the free month (best effort —
  // without PayPal configured the local extension still applies).
  let paypalSubId = '';
  try {
    const paypal = require('./paypal');
    const subs = await db.all(
      `SELECT paypal_subscription_id FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND paypal_subscription_id != ''`,
      [referrer.id]);
    for (const s of subs) {
      try {
        await paypal.suspendSubscription(s.paypal_subscription_id, 'Referral reward: one free month');
        if (!paypalSubId) paypalSubId = s.paypal_subscription_id;
      } catch (e) {
        console.error('referral suspend failed for', s.paypal_subscription_id, e.message);
      }
    }
  } catch (e) {
    console.error('referral PayPal suspend unavailable:', e.message);
  }

  let redemptionId;
  try {
    redemptionId = await db.insert('referral_redemptions', {
      referrer_id: referrer.id, referred_user_id: referredUserId,
      subscription_id: subscriptionId, granted_at: now,
      free_month_start: start, free_month_end: end,
      paypal_subscription_id: paypalSubId, status: 'active',
    });
  } catch (e) {
    // Lost a race — the UNIQUE index already recorded this subscription.
    if (/UNIQUE/i.test(e.message)) {
      return db.get('SELECT id FROM referral_redemptions WHERE subscription_id = ?', [subscriptionId]);
    }
    throw e;
  }

  // Tell the referrer about their free month.
  const subject = 'You earned a free month — thanks for the referral!';
  const body =
    `Hi ${referrer.display_name || 'there'},\n\n` +
    `Your friend${referred.display_name ? ` (${referred.display_name})` : ''} just became a paying member, ` +
    `so your membership is extended by one free month (through ${new Date(end).toLocaleDateString()}).\n\n` +
    `Keep sharing your referral code and every paying friend earns you another free month.\n\n` +
    `Warmly,\nTattoo Art Customs`;
  try {
    const { sendConversation } = require('./colorization');
    const ownerId = await ownerUserId();
    await sendConversation({ userIds: [referrer.id], subject, body, senderId: ownerId || referrer.id });
  } catch (e) {
    console.error('referral reward message failed:', e.message);
  }
  if (referrer.email) {
    try { await sendMail({ to: referrer.email, subject, text: body }); } catch { /* logged in mail.js */ }
  }
  return { id: redemptionId, referrer_id: referrer.id, free_month_end: end };
}

// Daily job: resume PayPal subscriptions whose referral free month has
// elapsed, so billing picks back up. Marks redemptions 'used'.
async function resumeReferralSubscriptions(now = Date.now()) {
  const due = await db.all(
    `SELECT * FROM referral_redemptions
     WHERE status = 'active' AND free_month_end <= ? AND paypal_subscription_id != ''`, [now]);
  const resumed = [];
  const paypal = require('./paypal');
  for (const r of due) {
    try {
      await paypal.activateSubscription(r.paypal_subscription_id, 'Referral free month ended');
      resumed.push(r.id);
    } catch (e) {
      console.error('referral resume failed for', r.paypal_subscription_id, e.message);
    }
    await db.update('referral_redemptions', r.id, { status: 'used' });
  }
  return resumed;
}

module.exports = {
  FREE_MONTH_MS,
  ensureReferralCode,
  resolveReferralCode,
  recordSignupReferral,
  firstMonthDiscountEligible,
  markFirstMonthUsed,
  grantReferralReward,
  resumeReferralSubscriptions,
};
