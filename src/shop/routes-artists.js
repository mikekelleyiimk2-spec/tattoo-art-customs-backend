// Artist commission tracker routes (mounted at /shop/artists by the coordinator).
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const {
  getArtist, createArtist, getArtists, updateArtist,
  deactivateArtist, reactivateArtist, logEarning, getEarnings, getArtistTotals,
} = require('./artistCommissions');

const router = express.Router();
const gate = [requireLogin, requireSubscription('tattoo_shop')];

// Default period: last 30 days. ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive).
function periodBounds(req) {
  const now = Date.now();
  let from = now - 30 * 24 * 3600 * 1000;
  let to = now + 1;
  if (req.query.from) {
    const d = new Date(`${req.query.from}T00:00:00`);
    if (!Number.isNaN(d.getTime())) from = d.getTime();
  }
  if (req.query.to) {
    const d = new Date(`${req.query.to}T00:00:00`);
    if (!Number.isNaN(d.getTime())) to = d.getTime() + 24 * 3600 * 1000;
  }
  return { from, to };
}

// Dashboard: artists + per-artist and shop totals for the period.
router.get('/', ...gate, async (req, res) => {
  const { from, to } = periodBounds(req);
  const artists = await getArtists(req.user.id, { includeInactive: true });
  const { artists: totals, totals: shopTotals } = await getArtistTotals(req.user.id, from, to);
  const totalsByArtist = new Map(totals.map((t) => [t.artist_id, t]));
  res.render('shop/artists/list', {
    title: 'Artist Commissions — Tattoo Art Customs',
    artists, totalsByArtist, shopTotals, from, to,
  });
});

// Create an artist.
router.post('/', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await createArtist({
      shopUserId: req.user.id,
      name: req.body.name,
      commissionRatePct: req.body.commission_rate_pct,
    });
    req.session.flash = 'Artist added.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/artists');
});

// Earnings list (filterable by date + artist).
router.get('/earnings', ...gate, async (req, res) => {
  const { from, to } = periodBounds(req);
  const artistId = req.query.artist_id || null;
  const earnings = await getEarnings(req.user.id, from, to, artistId);
  const artists = await getArtists(req.user.id, { includeInactive: true });
  res.render('shop/artists/earnings', {
    title: 'Earnings — Tattoo Art Customs',
    earnings, artists, from, to, artistId,
  });
});

// Log an earning (amount entered in dollars).
router.post('/earnings', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const dollars = parseFloat(req.body.amount_dollars);
    if (!Number.isFinite(dollars) || dollars <= 0) throw new Error('Enter a valid dollar amount.');
    await logEarning(
      req.user.id,
      req.body.artist_id,
      Math.round(dollars * 100),
      req.body.booking_id || null,
      req.body.note || null,
    );
    req.session.flash = 'Earning logged — split recorded.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/artists/earnings');
});

// Artist detail: totals + earnings + edit form.
router.get('/:id', ...gate, async (req, res) => {
  const { from, to } = periodBounds(req);
  try {
    const artist = await getArtist(req.user.id, req.params.id);
    const earnings = await getEarnings(req.user.id, from, to, artist.id);
    const totals = earnings.reduce((acc, e) => {
      acc.amount_cents += e.amount_cents;
      acc.artist_share_cents += e.artist_share_cents;
      acc.shop_share_cents += e.shop_share_cents;
      acc.entries += 1;
      return acc;
    }, { amount_cents: 0, artist_share_cents: 0, shop_share_cents: 0, entries: 0 });
    res.render('shop/artists/detail', {
      title: `${artist.name} — Tattoo Art Customs`,
      artist, earnings, totals, from, to,
    });
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/shop/artists');
  }
});

// Update an artist.
router.post('/:id', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await updateArtist({
      shopUserId: req.user.id,
      artistId: req.params.id,
      name: req.body.name,
      commissionRatePct: req.body.commission_rate_pct,
    });
    req.session.flash = 'Artist updated.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect(`/shop/artists/${req.params.id}`);
});

// Deactivate / reactivate an artist (deactivated artists keep their history).
router.post('/:id/deactivate', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await deactivateArtist({ shopUserId: req.user.id, artistId: req.params.id });
    req.session.flash = 'Artist deactivated — past earnings are kept.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/artists');
});

router.post('/:id/reactivate', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await reactivateArtist({ shopUserId: req.user.id, artistId: req.params.id });
    req.session.flash = 'Artist reactivated.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/artists');
});

module.exports = router;
