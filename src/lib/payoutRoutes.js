// Shared payout-settings + cashout routes for the artist and shop dashboards.
// Mounted by each router as registerPayoutRoutes(router, 'artist' | 'shop').
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const db = require('../db');
const { payableBalance } = require('./commissions');
const cashout = require('./cashout');

function registerPayoutRoutes(router, recipientType) {
  const dashPath = recipientType === 'artist' ? '/artist' : recipientType === 'shop' ? '/shop' : '/account';
  const isCustomer = recipientType === 'customer';

  // Add a payout destination (PayPal, bank, Cash App, Venmo, Zelle, ...).
  router.post('/payout-destination/add', formLimiter, checkHoneypot, async (req, res) => {
    try {
      await cashout.addDestination({
        userId: req.user.id, recipientType,
        destType: String(req.body.dest_type || ''),
        details: req.body,
      });
      req.session.flash = 'Payout destination added.';
    } catch (e) {
      req.session.flash = e.message;
    }
    res.redirect(dashPath);
  });

  router.post('/payout-destination/:id/default', formLimiter, checkHoneypot, async (req, res) => {
    try {
      await cashout.setDefaultDestination(req.user.id, req.params.id);
      req.session.flash = 'Default payout destination updated.';
    } catch (e) {
      req.session.flash = e.message;
    }
    res.redirect(dashPath);
  });

  router.post('/payout-destination/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
    await cashout.deleteDestination(req.user.id, req.params.id);
    req.session.flash = 'Payout destination removed.';
    res.redirect(dashPath);
  });

  // Weekly (free, automatic) vs manual (on-demand early cashout, 3% fee).
  // Artists and shops only — customers have no commission payouts.
  if (!isCustomer) {
    router.post('/cashout-mode', formLimiter, checkHoneypot, async (req, res) => {
      try {
        await cashout.setCashoutMode(req.user.id, recipientType, String(req.body.mode || ''));
        req.session.flash = req.body.mode === 'manual'
          ? 'Cashout mode set to manual — use "Cash out now" whenever you want (3% early-cashout fee applies).'
          : 'Cashout mode set to weekly — your full balance pays out automatically every Monday morning.';
      } catch (e) {
        req.session.flash = e.message;
      }
      res.redirect(dashPath);
    });

    // Early cashout: 97% now, 3% penalty, once per 24h.
    router.post('/cashout-now', formLimiter, checkHoneypot, async (req, res) => {
      try {
        const result = await cashout.requestEarlyCashout({
          userId: req.user.id, recipientType,
          destinationId: String(req.body.destination_id || ''),
        });
        const net = (result.net_cents / 100).toFixed(2);
        const fee = (result.penalty_cents / 100).toFixed(2);
        req.session.flash = result.status === 'completed'
          ? `Cashed out $${net} (3% early fee: $${fee}).`
          : `Cashout of $${net} requested (3% early fee: $${fee}) — the admin will send it to your ${JSON.parse(result.dest_snapshot).label} shortly.`;
      } catch (e) {
        req.session.flash = e.message;
      }
      res.redirect(dashPath);
    });
  }

  // Keep payable commissions as site credit (no fee — nothing is withdrawn).
  if (!isCustomer) {
    router.post('/commissions-to-credit', formLimiter, checkHoneypot, async (req, res) => {
      try {
        const { moveCommissionsToCredit } = require('./credits');
        const { creditedCents } = await moveCommissionsToCredit({ userId: req.user.id, recipientType });
        req.session.flash = `$${(creditedCents / 100).toFixed(2)} moved to your site credit — spend it on the site anytime, or withdraw it later from My Account.`;
      } catch (e) {
        req.session.flash = e.message;
      }
      res.redirect(dashPath);
    });
  }

  router.post('/cashout/:id/cancel', formLimiter, checkHoneypot, async (req, res) => {
    try {
      await cashout.cancelCashout({ userId: req.user.id, cashoutId: req.params.id });
      req.session.flash = 'Pending cashout canceled — balance restored.';
    } catch (e) {
      req.session.flash = e.message;
    }
    res.redirect(dashPath);
  });
}

// Dashboard data shared by both dashboards.
async function payoutDashboardData(userId, recipientType) {
  await cashout.ensureLegacyDestination(userId, recipientType);
  const [destinations, mode, balance] = await Promise.all([
    cashout.listDestinations(userId),
    cashout.getCashoutMode(userId, recipientType),
    payableBalance(recipientType, userId),
  ]);
  const requests = await db.all(
    'SELECT * FROM cashout_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [userId]);
  const quote = balance >= cashout.MIN_CASHOUT_CENTS ? cashout.earlyQuote(balance) : null;
  return {
    destinations, cashoutMode: mode, balance, cashoutRequests: requests,
    earlyQuote: quote, destTypes: cashout.DEST_TYPES,
    minCashoutCents: cashout.MIN_CASHOUT_CENTS,
  };
}

module.exports = { registerPayoutRoutes, payoutDashboardData };
