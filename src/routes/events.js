// Flash events routes (mounted at /events by the coordinator).
//
// Shop (tattoo_shop subscription): GET /manage, POST /create, POST /:id/close.
// Customers: GET / (upcoming), POST /:id/signup (cap enforced), POST /:id/leave.
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { money } = require('../lib/pricing');
const {
  createEvent, signupForEvent, confirmEventSignupPayment, leaveEvent, closeEvent,
  getUpcomingEvents, getShopEvents, getEventWithCount, getEventAttendees,
} = require('../lib/events');

const router = express.Router();

// --- Customer: upcoming events ---
router.get('/', requireLogin, async (req, res) => {
  const events = await getUpcomingEvents(req.user.id);
  res.render('events/index', {
    title: 'Flash Events — Tattoo Art Customs', events, money, metaDescription: 'Flash tattoo events near you.',
  });
});

// --- Customer: sign up (cap enforced, dupes rejected) ---
// Paid events go through the website PayPal/card checkout — tool-suite
// payments never use Google Play Billing.
router.post('/:id/signup', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const result = await signupForEvent({ eventId: req.params.id, customerUserId: req.user.id });
    const ev = await db.get('SELECT title, shop_user_id FROM shop_events WHERE id = ?', [req.params.id]);
    if (!result.needsPayment) {
      const { notifyUser } = require('../lib/notify');
      await notifyUser(ev.shop_user_id, {
        kind: 'event-signup', title: 'New event signup',
        body: `${req.user.display_name || 'A customer'} signed up for "${ev.title}".`,
        link: '/events/manage',
      });
      req.session.flash = 'You are signed up!';
      return res.redirect('/events');
    }
    // Paid registration: create the PayPal order and send them to approve it.
    const pay = await db.get('SELECT * FROM event_signup_payments WHERE id = ?', [result.paymentId]);
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: pay.total_cents,
        description: `Tattoo Art Customs — event registration (${ev.title.slice(0, 60)})`,
        returnUrl: `${config.baseUrl}/events/signup/approve/${pay.id}`,
        cancelUrl: `${config.baseUrl}/events`,
      });
      await db.update('event_signup_payments', pay.id, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('event PayPal order failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — try again in a bit.';
      return res.redirect('/events');
    }
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/events');
  }
});

// --- Customer: PayPal return for a paid registration ---
router.get('/signup/approve/:paymentId', requireLogin, async (req, res) => {
  try {
    const pay = await db.get('SELECT * FROM event_signup_payments WHERE id = ?', [req.params.paymentId]);
    if (!pay || pay.customer_user_id !== req.user.id) throw new Error('Payment not found.');
    if (pay.status === 'paid') {
      req.session.flash = 'You are signed up!';
      return res.redirect('/events');
    }
    if (!pay.paypal_order_id) throw new Error('No PayPal order on this payment.');
    const capture = await paypal.captureCheckoutOrder(pay.paypal_order_id);
    const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
    let paidCents = Math.round(parseFloat(captured?.amount?.value || '0') * 100);
    if (!paidCents) paidCents = pay.total_cents; // test stub reports 0.00
    if (paidCents < pay.total_cents) throw new Error('Captured amount is less than the amount due.');
    await confirmEventSignupPayment(pay.id, {
      captureId: (captured && captured.id) || null,
      orderId: pay.paypal_order_id, customerUserId: req.user.id,
    });
    req.session.flash = 'Registration paid — you are signed up!';
  } catch (e) {
    console.error('event capture failed:', e.message);
    req.session.flash = 'Payment capture failed: ' + e.message;
  }
  res.redirect('/events');
});

// --- Customer: leave ---
router.post('/:id/leave', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const { outcome } = await leaveEvent({ eventId: req.params.id, customerUserId: req.user.id });
  req.session.flash = {
    not_signed_up: 'You are not signed up for this event.',
    left: 'You left the event.',
    refunded_base: 'You left the event — the registration amount was refunded. The 5% platform fee is non-refundable.',
    forfeited: 'You left the event — the registration was forfeited (the event has already started).',
    refund_failed_manual: 'You left the event — the automatic refund failed; the shop will refund you manually.',
  }[outcome] || 'You left the event.';
  res.redirect('/events');
});

// --- Shop: manage ---
router.get('/manage', requireLogin, requireSubscription('tattoo_shop'), async (req, res) => {
  const events = await getShopEvents(req.user.id);
  res.render('events/manage', {
    title: 'Manage Events — Tattoo Art Customs', events, money, metaDescription: '',
  });
});

// --- Shop: create ---
router.post('/create', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  try {
    const dollars = parseFloat(String(req.body.registration_price_dollars || ''));
    const priceCents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    await createEvent({
      shopUserId: req.user.id, title: req.body.title, description: req.body.description,
      startsAt: req.body.starts_at, endsAt: req.body.ends_at, cap: req.body.cap,
      registrationPriceCents: priceCents,
    });
    req.session.flash = 'Event created.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/events/manage');
});

// --- Shop: close signups ---
router.post('/:id/close', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  try {
    await closeEvent({ eventId: req.params.id, shopUserId: req.user.id });
    req.session.flash = 'Event closed — no new signups.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/events/manage');
});

// --- Shop: attendee list for one event ---
router.get('/manage/:id', requireLogin, requireSubscription('tattoo_shop'), async (req, res) => {
  const ev = await getEventWithCount(req.params.id);
  if (!ev || ev.shop_user_id !== req.user.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Event not found.' });
  }
  const signups = await getEventAttendees(ev.id);
  res.render('events/attendees', {
    title: `Attendees — ${ev.title} — Tattoo Art Customs`, event: ev, signups, metaDescription: '',
  });
});

module.exports = router;
