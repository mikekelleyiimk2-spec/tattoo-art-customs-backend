// Developer Tools for other developers — the three Bundle B faces
// (owner approved all 12 month-end brainstorm ideas, Oct 28 2026).
// Each tool gets its OWN address and its own face (layout-devtools
// face variants), never the TAC skin:
//
//   GET  /fill-my-list        FillMyList as a standalone service
//   GET  /rolodex-demo        Affiliate Rolodex public demo (no signup)
//   GET  /money-watch         Money Watch for developers — offer
//   POST /money-watch/interest  interest -> orders (pending_review)
//   POST /money-watch/buy     buy -> orders + PayPal checkout
//   GET  /money-watch/approve/:orderId   PayPal return: capture + paid
//   GET  /money-watch/welcome/:orderId   buyer confirmation page
//
// The machinery is all existing house machinery, wired — not rebuilt:
// the fill cycle (lib/fillCycle.js) behind POST /api/testers/fill/*,
// the register's orders table for interest, and the settled prices in
// lib/devtools.js (one config place). Honest payment states only:
// the fill order records 'awaiting_payment' until the desk confirms;
// Money Watch sells through the standard house PayPal checkout (the
// routes/buyApp.js shape: order row -> checkout -> capture -> paid),
// wired 2026-11-05 for gap G-11. The interest list stays as the
// not-ready-to-buy door.
//
// OneMind tie: every page is public; the sign-in door is the site's
// standard /login (Google + email), and signing in seats the account
// via seatQuietly like everywhere else.
const express = require('express');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const devtools = require('../lib/devtools');
const fillCycle = require('../lib/fillCycle');
const rolodex = require('../lib/rolodex');
const paypal = require('../lib/paypal');
const guestCheckout = require('../lib/guestCheckout');
const seatVerify = require('../lib/seatVerify');
const { sendMail } = require('../lib/mail');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FACES = {
  fill: { key: 'fill', name: 'FillMyList' },
  rolodex: { key: 'rolodex', name: 'Affiliate Rolodex' },
  moneywatch: { key: 'moneywatch', name: 'Money Watch' },
};

function face(res, view, locals) {
  const base = config.baseUrl.replace(/\/$/, '');
  return res.render(view, {
    layout: 'layout-devtools',
    canonical: `${base}${locals.path}`,
    money: pricing.money,
    tipJarUrl: devtools.TIP_JAR_URL,
    user: locals.user || null,
    flash: res.locals.flash || null,
    ...locals,
  });
}

// ---- FillMyList — the standalone service face ---------------------
router.get('/fill-my-list', async (req, res) => {
  let board = null;
  try { board = await fillCycle.lightBoard(6); } catch (e) { board = null; }
  face(res, 'site/devtools-fill', {
    path: '/fill-my-list',
    face: FACES.fill,
    title: 'FillMyList — your 12 testers, handled | Useful Appz Developer Tools',
    metaDescription: 'FillMyList: the tester fill, sold on its own. $24.99 per app per fill until FULL — the opted-in pool routed to your app in waves; testers tap their own Play opt-in; confirmations counted live.',
    user: req.user || null,
    fill: devtools.FILL,
    fillRegisterCents: devtools.fillRegisterCents(),
    poolCount: await devtools.poolCount(),
    board,
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
  });
});

// ---- Affiliate Rolodex — the public demo ----------------------------
router.get('/rolodex-demo', (req, res) => {
  face(res, 'site/devtools-rolodex-demo', {
    path: '/rolodex-demo',
    face: FACES.rolodex,
    title: 'Affiliate Rolodex — the demo | Useful Appz Developer Tools',
    metaDescription: 'Paste your scattered affiliate links and watch the Rolodex organize them into one book — program, link, code, rate, cookie, disclosure, placements. Free demo, no signup, runs in your browser.',
    user: req.user || null,
    doors: {
      affiliateCents: devtools.ROLODEX_TIERS.affiliate.baseCents,
      socialCents: devtools.ROLODEX_TIERS.social.baseCents,
      masterCents: devtools.ROLODEX_TIERS.master.baseCents,
      appsUrl: '/apps',
      hubUrl: '/tester-hub',
    },
    // No house placements on the demo page: the demo is about the
    // VISITOR's book, and the house programs are tattoo-supply fit,
    // not developer fit. The sweeper doors below carry the page.
    partners: [],
    disclosureStandard: rolodex.disclosureStandard(),
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
    fill: devtools.FILL,
  });
});

// ---- Money Watch — for developers -----------------------------------
router.get('/money-watch', (req, res) => {
  face(res, 'site/devtools-moneywatch', {
    path: '/money-watch',
    face: FACES.moneywatch,
    title: 'Money Watch for Developers — never search for a payout again | Useful Appz',
    metaDescription: 'Money Watch, productized for other developers: every payout source watched, every landing flashed ("you made X in Y time"), your own split map drawn on every landing. Read-only first — it never moves your money. $4.99 one-time, on sale now.',
    user: req.user || null,
    priceCents: devtools.MONEY_WATCH.priceCents,
    feeCents: pricing.processingFeeCents(devtools.MONEY_WATCH.priceCents),
    registerCents: devtools.moneyWatchRegisterCents(),
    sourceDoors: devtools.MONEY_WATCH.sourceDoors,
    doors: { appsUrl: '/apps', hubUrl: '/tester-hub' },
    rolodexTiers: devtools.ROLODEX_TIERS,
    fill: devtools.FILL,
  });
});

// ---- Money Watch — the buy door (standard house PayPal checkout) ----
// Same shape as routes/buyApp.js: an orders row first, then a PayPal
// checkout order, capture on return, amount verified against the row,
// then fulfillment. Fulfillment for this product is the paid row
// itself: it fires the admin notification (the desk seats the buyer's
// source plugs at signup) and the buyer's confirmation email, and the
// welcome page is the buyer's on-screen receipt. Guests check out
// with just a delivery email — the PayPal return URL carries the HMAC
// guest token (lib/guestCheckout), scoped 'money_watch_dev'.
const MW_ORDER_TYPE = 'money_watch_dev';
const MW_SCOPE = 'money_watch_dev';

router.post('/money-watch/buy', formLimiter, checkHoneypot, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const sources = String(req.body.sources || '').trim().slice(0, 600);
  const guest = !req.user;
  let deliveryEmail = null;
  if (guest) {
    deliveryEmail = guestCheckout.parseGuestEmail(req.body.email);
    if (!deliveryEmail) {
      req.session.flash = 'Enter the email address your confirmation should go to — that is where your Money Watch setup starts.';
      return res.redirect('/money-watch#buy');
    }
  } else {
    deliveryEmail = String(req.user.email || '').trim().toLowerCase() || null;
  }
  const price = devtools.MONEY_WATCH.priceCents;
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: guest ? '' : req.user.id,
    order_type: MW_ORDER_TYPE,
    amount_cents: price,
    fee_cents: fee,
    status: 'pending',
    payment_method: 'paypal',
    guest_email: guest ? deliveryEmail : '',
    guest_note: JSON.stringify({ name, sources, deliveryEmail: deliveryEmail || '' }),
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: 'Money Watch for Developers — one-time',
      returnUrl: guest
        ? `${config.baseUrl}/money-watch/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, MW_SCOPE)}`
        : `${config.baseUrl}/money-watch/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/money-watch`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('money watch PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
    res.redirect('/money-watch#buy');
  }
});

// Shared gate for approve + welcome: guest orders prove ownership with
// the HMAC checkout token (?gt=); member orders need the buyer's own
// login. Returns the order, or null after responding.
async function loadMoneyWatchOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = ?${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId, MW_ORDER_TYPE]
  );
  if (!order) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This confirmation is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.isGuestOrder(order)) {
    if (guestCheckout.verifyGuestToken(req.query.gt, MW_SCOPE) !== String(order.id)) {
      res.status(403).render('error', {
        title: 'Invalid checkout link',
        message: 'This guest checkout link is not valid. Your confirmation is also emailed to you when payment completes.',
      });
      return null;
    }
    return order;
  }
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  if (order.buyer_id !== req.user.id) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This confirmation is not available.' : 'Order not found.',
    });
    return null;
  }
  return order;
}

function moneyWatchWelcomePath(req, order) {
  const base = `/money-watch/welcome/${order.id}`;
  return guestCheckout.isGuestOrder(order)
    ? `${base}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, MW_SCOPE))}`
    : base;
}

// Buyer confirmation email — best-effort by contract (payment is
// already captured when this runs; a mail failure never breaks the
// buyer's flow, it is logged and the welcome page still confirms).
async function sendMoneyWatchConfirmation(order) {
  let note = {};
  try { note = JSON.parse(order.guest_note || '{}'); } catch (e) { note = {}; }
  const to = order.guest_email || note.deliveryEmail || '';
  if (!to) return false;
  const ref = String(order.id).slice(0, 8);
  const lines = [
    `Hi there,`,
    ``,
    `Thanks for your purchase — payment is complete. Money Watch for Developers is yours (reference ${ref}).`,
    ``,
    `What happens next: the watch is read-only and never moves your money. Your source plugs seat at signup — sign in (or create your account) at ${config.baseUrl}/login with this email address, and the desk seats your PayPal plug first; the sources you named are added from there.`,
    ``,
    `Keep this email — it is your receipt. If you have any trouble, just reply to this email.`,
    ``,
    `— Useful Appz`,
  ];
  try {
    await sendMail({
      to,
      subject: `Money Watch for Developers — payment complete (reference ${ref})`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('money watch confirmation email failed:', e.message);
    return false;
  }
}

router.get('/money-watch/approve/:orderId', async (req, res) => {
  const order = await loadMoneyWatchOrder(req, res, { paidOnly: false });
  if (!order) return;
  if (order.status === 'paid') return res.redirect(moneyWatchWelcomePath(req, order));
  try {
    const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
    const capture = await captureFn(order.paypal_order_id);
    const expectedTotal = order.amount_cents + order.fee_cents;
    const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
    if (captured !== expectedTotal) {
      await seatVerify.logEvent({
        kind: 'fulfillment_mismatch',
        detail: `money-watch: captured ${captured} != expected ${expectedTotal} (order ${order.id})`,
        userId: order.buyer_id || null, req,
      });
      throw new Error('Amount mismatch');
    }
    await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
    try {
      await require('../lib/notify').notifyAdmins({
        kind: 'contact',
        title: `Money Watch (developers) SOLD: order ${String(order.id).slice(0, 8)}`,
        body: `Money Watch for Developers sold for ${pricing.money(expectedTotal)} (order ${order.id}). Buyer: ${order.guest_email || order.buyer_id}. Seat the buyer's source plugs at signup.`,
        link: '/money-watch',
      });
    } catch (e) { console.error('money watch sale notify failed:', e.message); }
    await sendMoneyWatchConfirmation(order);
    req.session.flash = 'Payment complete — Money Watch for Developers is yours.';
    res.redirect(moneyWatchWelcomePath(req, order));
  } catch (e) {
    console.error('money watch PayPal capture failed:', e.message);
    req.session.flash = 'Payment could not be completed — try again.';
    res.redirect('/money-watch#buy');
  }
});

router.get('/money-watch/welcome/:orderId', async (req, res) => {
  const order = await loadMoneyWatchOrder(req, res, { paidOnly: true });
  if (!order) return;
  let note = {};
  try { note = JSON.parse(order.guest_note || '{}'); } catch (e) { note = {}; }
  face(res, 'site/devtools-moneywatch-welcome', {
    path: '/money-watch',
    face: FACES.moneywatch,
    title: 'Money Watch for Developers — payment complete | Useful Appz',
    metaDescription: 'Your Money Watch for Developers purchase is complete.',
    user: req.user || null,
    order,
    orderRef: String(order.id).slice(0, 8),
    totalCents: order.amount_cents + order.fee_cents,
    deliveryEmail: order.guest_email || note.deliveryEmail || '',
    sources: note.sources || '',
    doors: { appsUrl: '/apps', hubUrl: '/tester-hub' },
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
    fill: devtools.FILL,
  });
});

router.post('/money-watch/interest', formLimiter, checkHoneypot, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const sources = String(req.body.sources || '').trim().slice(0, 600);
  if (!EMAIL_RE.test(email)) {
    req.session.flash = 'Enter a valid email and you are on the list — that is the whole form.';
    return res.redirect('/money-watch#interest');
  }
  try {
    const orderId = await devtools.recordMoneyWatchInterest({
      name, email, sources, userId: req.user ? req.user.id : '',
    });
    req.session.flash = `You are on the Money Watch interest list (reference ${orderId}). Joining takes no payment — and Money Watch is on sale now at ${pricing.money(devtools.MONEY_WATCH.priceCents)} if you'd rather skip the line: the buy door is at the top of this page.`;
  } catch (e) {
    console.error('money watch interest failed:', e.message);
    req.session.flash = 'The interest door hiccuped — try once more in a moment.';
  }
  res.redirect('/money-watch#interest');
});

module.exports = router;
