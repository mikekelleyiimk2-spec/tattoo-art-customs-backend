// Developer Tools for other developers — the three Bundle B faces
// (owner approved all 12 month-end brainstorm ideas, Oct 28 2026).
// Each tool gets its OWN address and its own face (layout-devtools
// face variants), never the TAC skin:
//
//   GET  /fill-my-list        FillMyList as a standalone service
//   POST /fill-my-list/buy    buy -> fill order + orders + PayPal checkout
//   GET  /fill-my-list/approve/:orderId   PayPal return: capture + grant
//   GET  /fill-my-list/welcome/:orderId   buyer confirmation page
//   GET  /fill-my-list/cancelled          PayPal cancel return (no charge)
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
// the fill order records 'awaiting_payment' until a PayPal capture is
// verified, at which point the fill approve route calls
// grantFillEntitlement() server-side and the fill starts (web rail
// wired 2026-11-07); Money Watch sells through the standard house
// PayPal checkout (the routes/buyApp.js shape: order row -> checkout
// -> capture -> paid), wired 2026-11-05 for gap G-11. The interest
// list stays as the not-ready-to-buy door.
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
    fillFeeCents: pricing.processingFeeCents(devtools.FILL.baseCents),
    poolCount: await devtools.poolCount(),
    board,
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
  });
});

// ---- FillMyList — the buy door (standard house PayPal checkout) ----
// Same shape as the Money Watch door below (and routes/buyApp.js):
// a fill order first (born 'awaiting_payment' in the fill cycle),
// then a register orders row, then a PayPal one-time checkout for the
// register total (settled $24.99 + the house processing-fee
// pass-through = $26.35, from lib/devtools.js only — never re-priced
// here). Capture on return, amount verified exactly, and ONLY then
// grantFillEntitlement() is called server-side: no service token is
// ever exposed and an unpaid app never enters the cycle. The fill's
// ownership proof is the developer Gmail on the fill itself, so the
// register row always carries that Gmail as its guest_email and the
// PayPal return URL carries the HMAC guest token (lib/guestCheckout),
// scoped 'fill_my_list' — logged in or not, the flow is identical.
const FILL_ORDER_TYPE = 'fill_my_list';
const FILL_SCOPE = 'fill_my_list';

router.post('/fill-my-list/buy', formLimiter, checkHoneypot, async (req, res) => {
  const pkg = String(req.body.package || '').trim().toLowerCase().slice(0, 180);
  const developerGmail = String(req.body.developer_gmail || req.body.email || '')
    .trim().toLowerCase().slice(0, 160);
  if (!pkg || !developerGmail) {
    req.session.flash = 'Enter your app\'s package name and the developer Gmail on its FillMyList listing — both are needed to start a fill.';
    return res.redirect('/fill-my-list#start');
  }
  let created;
  try {
    created = await fillCycle.createFillOrder({ package: pkg, developer_gmail: developerGmail });
  } catch (e) {
    console.error('fill buy: fill order create failed:', e.message);
    req.session.flash = 'The fill order door hiccuped — try once more in a moment.';
    return res.redirect('/fill-my-list#start');
  }
  if (!created.ok) {
    req.session.flash = created.error;
    return res.redirect('/fill-my-list#start');
  }
  if (created.order.status !== 'awaiting_payment') {
    req.session.flash = `That app's fill is already ${created.order.status} — no second charge was started. Check its count below.`;
    return res.redirect('/fill-my-list#start');
  }
  const price = devtools.FILL.baseCents;
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: '',
    order_type: FILL_ORDER_TYPE,
    amount_cents: price,
    fee_cents: fee,
    status: 'pending',
    payment_method: 'paypal',
    guest_email: developerGmail,
    guest_note: JSON.stringify({ package: created.order.package, developerGmail }),
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: 'FillMyList — fill my tester list (one app, until FULL)',
      returnUrl: `${config.baseUrl}/fill-my-list/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, FILL_SCOPE)}`,
      cancelUrl: `${config.baseUrl}/fill-my-list/cancelled`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    // Includes PayPalNotConfigured: the rail degrades honestly — the
    // fill order stays 'awaiting_payment', no charge is started, and
    // the buyer is told plainly instead of being stranded.
    console.error('fill PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — no payment was taken. Your fill order is recorded as awaiting_payment and holds its place at the settled price; try checkout again later.';
    res.redirect('/fill-my-list#start');
  }
});

// PayPal cancel return: no capture is attempted, no payment was
// taken, and the fill order stays 'awaiting_payment'.
router.get('/fill-my-list/cancelled', (req, res) => {
  req.session.flash = 'PayPal checkout was cancelled — no payment was taken. Your fill order stays awaiting_payment and holds its place; you can run checkout again whenever you are ready.';
  res.redirect('/fill-my-list#start');
});

// Shared gate for fill approve + welcome: the register row must be a
// FillMyList row and the HMAC checkout token must prove it. Returns
// the order, or null after responding.
async function loadFillRegisterOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = ?${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId, FILL_ORDER_TYPE]
  );
  if (!order) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This confirmation is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.verifyGuestToken(req.query.gt, FILL_SCOPE) !== String(order.id)) {
    res.status(403).render('error', {
      title: 'Invalid checkout link',
      message: 'This checkout link is not valid. Your confirmation is also emailed to you when payment completes.',
    });
    return null;
  }
  return order;
}

function fillWelcomePath(order) {
  return `/fill-my-list/welcome/${order.id}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, FILL_SCOPE))}`;
}

function fillNote(order) {
  try { return JSON.parse(order.guest_note || '{}'); } catch (e) { return {}; }
}

// Buyer confirmation email — best-effort by contract (payment is
// already captured and the fill already started when this runs; a
// mail failure never breaks the buyer's flow).
async function sendFillConfirmation(order, fillOrder) {
  const note = fillNote(order);
  const to = order.guest_email || note.developerGmail || '';
  if (!to) return false;
  const ref = String(order.id).slice(0, 8);
  const lines = [
    `Hi there,`,
    ``,
    `Thanks for your purchase — payment is complete and your FillMyList fill has started for ${note.package || 'your app'} (reference ${ref}).`,
    ``,
    `The pool is now being routed to your app in waves until its list is FULL (${fillOrder ? fillOrder.target : 12} confirmed opt-ins). Testers tap their own Play opt-in themselves; confirmations are counted live — check the count any time at ${config.baseUrl}/fill-my-list`,
    ``,
    `Keep this email — it is your receipt. If you have any trouble, just reply to this email.`,
    ``,
    `— Useful Appz`,
  ];
  try {
    await sendMail({
      to,
      subject: `FillMyList — payment complete, your fill has started (reference ${ref})`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('fill confirmation email failed:', e.message);
    return false;
  }
}

router.get('/fill-my-list/approve/:orderId', async (req, res) => {
  const order = await loadFillRegisterOrder(req, res, { paidOnly: false });
  if (!order) return;
  if (order.status === 'paid') return res.redirect(fillWelcomePath(order));
  const note = fillNote(order);
  const pkg = note.package || '';
  try {
    let capture;
    try {
      const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
      capture = await captureFn(order.paypal_order_id);
    } catch (e) {
      // A previous attempt may have captured the money and then
      // crashed before bookkeeping: recover that capture, never
      // re-charge or lose it (the house gift-card pattern).
      if (!paypal.isAlreadyCapturedError(e)) throw e;
      console.error(`fill: already-captured recovery for register order ${order.id}`);
      capture = await paypal.getCheckoutOrder(order.paypal_order_id);
    }
    if (capture.status && capture.status !== 'COMPLETED') {
      throw new Error(`capture status is ${capture.status}, not COMPLETED`);
    }
    const expectedTotal = Number(order.amount_cents) + Number(order.fee_cents || 0);
    // Exact-amount verification (stub-aware, like routes/orders.js):
    // a short or over capture never marks the order paid.
    const paidCents = paypal.assertCaptureAmount(capture, expectedTotal);
    await db.update('orders', order.id, {
      status: 'paid', amount_paid_cents: paidCents, paid_at: db.now(),
    });
    // THE GRANT: verified capture in hand, flip the fill server-side.
    const captureId = (((capture.purchase_units || [])[0] || {}).payments || {}).captures?.[0]?.id
      || order.paypal_order_id;
    const grant = await fillCycle.grantFillEntitlement({
      package: pkg, purchase_ref: captureId, simulated: false,
    });
    let fillOrder = grant.ok ? grant.order : null;
    if (!grant.ok) {
      // Already cycling (e.g. a second register row for the same
      // fill) is success; anything else is a paid-but-not-started
      // state the desk must see — never dress it up as a start.
      const st = await fillCycle.fillStatus({ package: pkg }).catch(() => null);
      if (st && st.ok && (st.order.status === 'filling' || st.order.status === 'full')) {
        fillOrder = st.order;
      } else {
        console.error('fill grant after verified capture failed:', grant.error, `(register order ${order.id})`);
        try {
          await require('../lib/notify').notifyAdmins({
            kind: 'contact',
            title: `FillMyList PAID but fill did not start: ${pkg}`,
            body: `FillMyList payment captured (${pricing.money(expectedTotal)}, register order ${order.id}, capture ${captureId}) but the entitlement grant failed: ${grant.error}. Grant it for ${pkg} from the desk.`,
            link: '/fill-my-list',
          });
        } catch (e) { console.error('fill grant-failure notify failed:', e.message); }
        req.session.flash = 'Payment is complete and recorded — but your fill hit a snag starting. The desk has been notified and will start it from your paid order; no second payment is needed.';
        return res.redirect('/fill-my-list#start');
      }
    }
    try {
      await require('../lib/notify').notifyAdmins({
        kind: 'contact',
        title: `FillMyList SOLD: order ${String(order.id).slice(0, 8)}`,
        body: `FillMyList sold for ${pricing.money(expectedTotal)} (register order ${order.id}). App: ${pkg}. Buyer: ${order.guest_email}. The fill started automatically on capture.`,
        link: '/fill-my-list',
      });
    } catch (e) { console.error('fill sale notify failed:', e.message); }
    await sendFillConfirmation(order, fillOrder);
    req.session.flash = 'Payment complete — your fill has started.';
    res.redirect(fillWelcomePath(order));
  } catch (e) {
    console.error('fill PayPal capture failed:', e.message);
    try {
      await seatVerify.logEvent({
        kind: 'fulfillment_mismatch',
        detail: `fill-my-list: capture failed for register order ${order.id}: ${e.message}`,
        userId: null, req,
      });
    } catch (logErr) { /* logging never breaks the buyer's landing */ }
    req.session.flash = 'Payment could not be completed — no fill was started and your order stays awaiting_payment. You can try checkout again.';
    res.redirect('/fill-my-list#start');
  }
});

router.get('/fill-my-list/welcome/:orderId', async (req, res) => {
  const order = await loadFillRegisterOrder(req, res, { paidOnly: true });
  if (!order) return;
  const note = fillNote(order);
  let fillOrder = null;
  try {
    const st = await fillCycle.fillStatus({ package: note.package || '' });
    if (st && st.ok) fillOrder = st.order;
  } catch (e) { fillOrder = null; }
  face(res, 'site/devtools-fill-welcome', {
    path: '/fill-my-list',
    face: FACES.fill,
    title: 'FillMyList — payment complete, your fill has started | Useful Appz',
    metaDescription: 'Your FillMyList purchase is complete and your fill is running.',
    user: req.user || null,
    order,
    orderRef: String(order.id).slice(0, 8),
    totalCents: Number(order.amount_cents) + Number(order.fee_cents || 0),
    deliveryEmail: order.guest_email || note.developerGmail || '',
    packageName: note.package || (fillOrder && fillOrder.package) || '',
    fillOrder,
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
    fill: devtools.FILL,
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
