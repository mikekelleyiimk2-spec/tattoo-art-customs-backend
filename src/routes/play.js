// Google Play Billing verification intake for the Android app.
// The app POSTs each completed purchase here. Rows are recorded as 'pending'
// and verified against Google's servers once the Play Developer API service
// account is configured (Play Console, Tuesday). The admin links verified
// subscription rows to website accounts and fulfills design orders from them.
const express = require('express');
const db = require('../db');

const router = express.Router();

// Known Play product IDs (must match the SKUs created in the Play Console).
const KNOWN_PRODUCTS = new Set([
  'tac_membership_customer',
  'tac_membership_artist',
  'tac_membership_shop',
  'tac_premade',
  'tac_premade_sale',
  'tac_custom_deposit',
  'tac_custom_deposit_sale',
]);

router.post('/verify', async (req, res) => {
  const productId = String(req.body?.productId || '').slice(0, 128);
  const purchaseToken = String(req.body?.purchaseToken || '').slice(0, 512);
  const type = req.body?.type === 'subs' ? 'subs' : 'inapp';
  const email = String(req.body?.email || '').slice(0, 160);

  if (!productId || !KNOWN_PRODUCTS.has(productId) || !purchaseToken) {
    return res.status(400).json({ ok: false, error: 'invalid purchase' });
  }

  try {
    await db.insert('play_purchases', {
      id: db.newId(),
      product_id: productId,
      purchase_token: purchaseToken,
      purchase_type: type,
      status: 'pending',
      email,
      created_at: db.now(),
    });
  } catch (err) {
    // Duplicate token (already recorded) is fine — idempotent intake.
    if (!String(err?.message || '').includes('UNIQUE')) throw err;
  }
  return res.json({ ok: true });
});

module.exports = router;
