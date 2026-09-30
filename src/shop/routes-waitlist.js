// Waitlist routes (mounted at /waitlist by the coordinator).
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const db = require('../db');
const {
  joinWaitlist, claimOffer,
  getWaitlistForShop, getWaitlistForCustomer, cancelWaitlistEntry,
} = require('./waitlist');

const router = express.Router();

// Customer: join a shop's waitlist.
router.post('/join', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await joinWaitlist({
      shopUserId: req.body.shop_user_id,
      staffId: req.body.staff_id || null,
      customerUserId: req.user.id,
      notes: req.body.notes,
    });
    req.session.flash = "You're on the waitlist — we'll notify you the moment a spot opens up.";
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/waitlist/mine');
});

// Customer: my waitlist entries.
router.get('/mine', requireLogin, async (req, res) => {
  const entries = await getWaitlistForCustomer(req.user.id);
  res.render('waitlist/mine', {
    title: 'My Waitlist — Tattoo Art Customs', entries, metaDescription: '',
  });
});

// Customer: leave the waitlist.
router.post('/:id/leave', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await cancelWaitlistEntry({ id: req.params.id, customerUserId: req.user.id });
    req.session.flash = 'Removed from the waitlist.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/waitlist/mine');
});

// Offer claim page (must own the entry; offer must be live).
router.get('/claim/:id', requireLogin, async (req, res) => {
  const entry = await db.get(
    `SELECT w.*, u.display_name AS shop_name FROM waitlist w
     JOIN users u ON u.id = w.shop_user_id WHERE w.id = ?`, [req.params.id]);
  if (!entry || entry.customer_user_id !== req.user.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Offer not found.' });
  }
  const expired = entry.offer_expires_at && entry.offer_expires_at <= Date.now();
  const startAt = req.query.start ? Number(req.query.start) : null;
  const endAt = req.query.end ? Number(req.query.end) : null;
  res.render('waitlist/claim', {
    title: 'Claim Your Spot — Tattoo Art Customs',
    entry, expired, usable: entry.status === 'offered' && !expired,
    startAt, endAt, metaDescription: '',
  });
});

// Claim the offered spot. Returns the slot info for booking.
router.post('/claim/:id', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { startAt, endAt, shopName, already } = await claimOffer({
      id: req.params.id, customerUserId: req.user.id,
      startAt: req.body.start || null, endAt: req.body.end || null,
    });
    if (already) {
      req.session.flash = 'You already claimed this spot.';
      return res.redirect('/waitlist/mine');
    }
    if (startAt && endAt) {
      req.session.flash =
        `Spot claimed at ${shopName}! Book it now: ${new Date(startAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })}.`;
    } else {
      req.session.flash = `Spot claimed at ${shopName}! Pick your time with the shop to lock it in.`;
    }
    // Stash the claimed slot so the booking flow can prefill it.
    req.session.claimed_slot = { waitlist_id: req.params.id, start_at: startAt, end_at: endAt };
    res.redirect('/waitlist/mine');
  } catch (e) {
    req.session.flash = e.message;
    res.redirect(`/waitlist/claim/${req.params.id}`);
  }
});

// Shop: full waitlist (waiting + offered first).
router.get('/list', requireLogin, requireSubscription('tattoo_shop'), async (req, res) => {
  const entries = await getWaitlistForShop(req.user.id);
  const waiting = entries.filter((e) => e.status === 'waiting').length;
  const offered = entries.filter((e) => e.status === 'offered').length;
  res.render('waitlist/list', {
    title: 'Waitlist — Tattoo Art Customs', entries, waiting, offered, metaDescription: '',
  });
});

// Shop: manually offer the next person in line (no concrete slot — "next opening").
router.post('/offer-next', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const { offerNextInLine } = require('./waitlist');
  const offered = await offerNextInLine({ shopUserId: req.user.id, staffId: req.body.staff_id || null });
  req.session.flash = offered
    ? 'Offer sent — the next person in line has 24 hours to claim.'
    : 'Nobody is waiting in line right now.';
  res.redirect('/waitlist/list');
});

module.exports = router;
