// Public ad-space sales: /advertise page + order form, and /ads/go/:id click tracking.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { SLOTS, slotIds, validLinkUrl, recordClick } = require('../lib/ads');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();

const adStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(config.assetDir, 'uploads', 'ads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `ad-${db.newId()}${ext}`);
  },
});
const uploadAd = multer({
  storage: adStorage,
  limits: { fileSize: 500 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, GIF, or WebP images are accepted.'));
  },
});

router.get('/advertise', (req, res) => {
  res.render('site/advertise', {
    title: 'Advertise — Tattoo Art Customs',
    metaDescription: 'Buy ad space on Tattoo Art Customs. Banner placements on every page, the gallery, and design pages.',
    slots: SLOTS,
    money: res.locals.money,
  });
});

router.post('/advertise', formLimiter, checkHoneypot, (req, res) => {
  uploadAd.single('creative')(req, res, async (err) => {
    try {
      if (err) throw err;
      const { advertiser_name, advertiser_email, slot, months, title, link_url, website } = req.body;
      if (website) return res.redirect('/advertise'); // honeypot
      if (!advertiser_name || !advertiser_email || !title) throw new Error('Name, email, and ad title are required.');
      if (!slotIds().includes(slot)) throw new Error('Choose a valid ad placement.');
      const m = Math.min(12, Math.max(1, parseInt(months, 10) || 1));
      if (!validLinkUrl(link_url)) throw new Error('Link URL must start with http:// or https://.');
      if (!req.file) throw new Error('Upload your banner creative (JPG/PNG/GIF/WebP, under 500 KB).');

      const id = db.newId();
      await db.insert('ads', {
        id,
        slot,
        title: String(title).slice(0, 120),
        image_path: `/img/ads/${req.file.filename}`,
        link_url: link_url.trim(),
        advertiser_name: String(advertiser_name).slice(0, 120),
        advertiser_email: String(advertiser_email).slice(0, 160),
        months: m,
        starts_at: 0,
        ends_at: 0,
        active: 0,
        impressions: 0,
        clicks: 0,
        created_at: db.now(),
      });
      const price = res.locals.money(SLOTS[slot].price_cents * m);
      // TODO (Tier-3 ad funding): when this ad's payment is confirmed, call
      // recordAdRevenue({ amountCents, source: 'direct:' + slot }) from
      // lib/ads.js — 50% sweeps into the site overhead pool (cushion for
      // Tier-2 admin task pay + storage), 50% stays with the owner.
      req.session.flash = `Order received — ${m} month(s) of "${SLOTS[slot].name}" for ${price}. We'll email ${advertiser_email} with payment instructions, then your ad goes live.`;
      return res.redirect('/advertise');
    } catch (e) {
      req.session.flash = e.message || 'Could not submit your order.';
      return res.redirect('/advertise');
    }
  });
});

// Click tracking → redirect to the advertiser.
router.get('/ads/go/:id', async (req, res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id = ?', [req.params.id]);
  if (!ad || !validLinkUrl(ad.link_url)) return res.redirect('/');
  await recordClick(ad.id);
  return res.redirect(ad.link_url);
});

module.exports = router;
