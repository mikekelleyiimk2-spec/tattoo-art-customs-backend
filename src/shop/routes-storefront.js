// Shop storefront routes (shop toolset).
//
// Public: GET /:shopId — the shop's branded design store.
// Shop-only: GET /manage/settings + POST /manage/settings (tattoo_shop sub).
// Mounted at /store by src/index.js.
//
// NOTE: /manage/* must be defined BEFORE /:shopId so "manage" is not
// captured as a shop id.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireSubscription, hasActiveSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { money } = require('../lib/pricing');
const storefront = require('./storefront');

const router = express.Router();

// --- shop: storefront settings --------------------------------------------

router.get('/manage/settings', requireLogin, requireSubscription('tattoo_shop'), async (req, res) => {
  const settings = await storefront.getSettings(req.user.id);
  res.render('shop/storefront-settings', {
    title: 'Storefront settings — Tattoo Art Customs',
    settings, money,
    storeUrl: `${config.baseUrl}/store/${req.user.id}`,
  });
});

router.post('/manage/settings', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  await storefront.saveSettings(req.user.id, {
    enabled: req.body.enabled === '1',
    headline: req.body.headline,
    welcomeText: req.body.welcome_text,
  });
  req.session.flash = 'Storefront settings saved.';
  res.redirect('/store/manage/settings');
});

// --- public storefront -------------------------------------------------------

router.get('/:shopId', async (req, res) => {
  const shop = await db.get(
    "SELECT id, display_name FROM users WHERE id = ? AND role = 'tattoo_shop'",
    [req.params.shopId]);
  if (!shop) return res.status(404).render('error', { title: 'Not found', message: 'Shop not found.' });
  if (!(await hasActiveSubscription(shop.id, 'tattoo_shop'))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Shop not found.' });
  }
  const settings = await storefront.getSettings(shop.id);
  if (!settings || Number(settings.enabled) !== 1) {
    return res.status(404).render('error', { title: 'Not found', message: 'This shop has not opened its store yet.' });
  }
  const designs = await storefront.getShopDesigns(shop.id);
  const refCode = await storefront.getShopReferralCode(shop.id);
  res.render('shop/storefront', {
    title: `${settings.headline || shop.display_name + ' — Shop Store'} — Tattoo Art Customs`,
    shop, settings, designs, money, refCode,
  });
});

module.exports = router;
