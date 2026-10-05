// Central configuration — every secret/credential comes from the environment.
// See .env.example and SETUP.md. Nothing sensitive is hardcoded here.
require('dotenv').config();
const path = require('path');
const fs = require('fs');

function required(name, fallback = '') {
  const v = process.env[name] || fallback;
  return v;
}

const assetDir = process.env.ASSET_DIR || path.join(__dirname, '..', 'assets');
// User uploads live here. On Render UPLOAD_DIR=/var/data/uploads points at
// the persistent disk (tac-uploads). When UPLOAD_DIR is unset the legacy
// local path is kept, so dev/test and existing deploys behave exactly as
// before (migration-safe).
const uploadDir = process.env.UPLOAD_DIR || path.join(assetDir, 'uploads');
try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (e) {
  // Loud but non-fatal: individual write sites also mkdirSync and will
  // surface the real error per request.
  console.error('[config] could not create upload dir', uploadDir, e.message);
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
  playStoreUrl: process.env.PLAY_STORE_URL || '',
  playStoreProUrl: process.env.PLAY_STORE_URL_PRO || '',
  appStoreUrl: process.env.APP_STORE_URL || '',
  youtubeUrl: process.env.YOUTUBE_CHANNEL_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  // Muse service pipe token. Documented here; the route reads process.env
  // live so tests can toggle it. Never commit a real value.
  museServiceToken: process.env.MUSE_SERVICE_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL || '',
  sqlitePath: process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  assetDir,
  uploadDir,
  // AES-256-GCM key for shop waiver ID photos (64 hex chars = 32 bytes).
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // NEVER commit the value. When missing, ID capture endpoints fail closed.
  idDocKey: (process.env.ID_DOC_KEY || '').trim(),
  idDocConfigured() {
    return /^[0-9a-fA-F]{64}$/.test(this.idDocKey);
  },

  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: (process.env.PAYPAL_MODE || 'sandbox').toLowerCase(),
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    planIds: {
      customer: process.env.PAYPAL_PLAN_CUSTOMER || '',
      customer_annual: process.env.PAYPAL_PLAN_CUSTOMER_ANNUAL || '',
      // Pro-app perk 6-month plan (owner directive 2026-10-05): dedicated
      // PayPal plan with a 6-month (MONTH x 6) billing cycle. Create via
      // scripts/create-6month-plan.js, then set PAYPAL_PLAN_CUSTOMER_6MONTH.
      customer_6month: process.env.PAYPAL_PLAN_CUSTOMER_6MONTH || '',
      artist: process.env.PAYPAL_PLAN_ARTIST || '',
      shop: process.env.PAYPAL_PLAN_SHOP || '',
      // Dedicated founding-shop plan ($83.28 first year as a plan-level
      // trial, then $103.98/yr). Created via scripts/create-founding-shop-plan.js.
      // When missing, founding checkout falls back to the regular shop plan
      // at full price rather than failing.
      founding_shop: process.env.PAYPAL_PLAN_FOUNDING_SHOP || '',
    },
  },
  paypalConfigured() {
    return !!(this.paypal.clientId && this.paypal.clientSecret);
  },
  paypalPlansConfigured() {
    const p = this.paypal.planIds;
    return this.paypalConfigured() && !!(p.customer && p.artist && p.shop);
  },
  // Annual customer plan is optional: when PAYPAL_PLAN_CUSTOMER_ANNUAL is
  // missing the annual plan shows as "coming soon" instead of disabling
  // all checkout.
  paypalAnnualPlanConfigured() {
    return this.paypalConfigured() && !!this.paypal.planIds.customer_annual;
  },
  // 6-month Pro-perk plan is optional like the annual plan: when
  // PAYPAL_PLAN_CUSTOMER_6MONTH is missing the plan shows as "coming soon"
  // to eligible users instead of disabling all checkout.
  paypalCustomer6MonthPlanConfigured() {
    return this.paypalConfigured() && !!this.paypal.planIds.customer_6month;
  },
  // Dedicated founding-shop plan (trial pricing defined in the plan itself —
  // PayPal rejects a 1-year TRIAL billing-cycle override at subscription
  // creation, so the founding discount lives in its own plan). Gated on the
  // plan ID alone: if API credentials are missing, checkout fails gracefully
  // with a friendly message anyway.
  paypalFoundingShopPlanConfigured() {
    return !!this.paypal.planIds.founding_shop;
  },
  paypalBaseUrl() {
    return this.paypal.mode === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  },

  // Auto-charging for no-show forfeits + plan installments. OWNER RULE:
  // stays OFF until explicitly enabled — never attempt a charge otherwise.
  autoChargeEnabled: process.env.AUTO_CHARGE_ENABLED === '1',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Tattoo Art Customs <no-reply@example.com>',
  },
  smtpConfigured() {
    return !!(this.smtp.host && this.smtp.user && this.smtp.pass);
  },

  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Google AdSense — empty publisher ID means ads stay off.
  adsense: {
    publisherId: process.env.ADSENSE_PUBLISHER_ID || '',
  },

  // Apple Pay (via PayPal) — the domain association file content goes here
  // once the domain is registered in the PayPal developer dashboard.
  applePay: {
    domainAssociation: process.env.APPLE_PAY_DOMAIN_ASSOCIATION || '',
  },

  // Wise (bank payouts) — without these, bank cashouts queue for manual admin send.
  wise: {
    apiToken: process.env.WISE_API_TOKEN || '',
    profileId: process.env.WISE_PROFILE_ID || '',
  },
  adsenseConfigured() {
    return !!this.adsense.publisherId;
  },

  // Business rules (cents) — single source of truth for pricing.
  pricing: {
    premadeRegular: 7500,   // $75
    premadeSale: 5000,      // $50 Saturday sale
    customFull: 15000,      // $150 regular
    customSaleFull: 12500,  // $125 Saturday sale
    customDeposit: 7500,    // 50% deposit (regular price; use pricing.js for sale-aware)
    plans: {
      // Prices INCLUDE the 3.5% + $0.49 web processing fee (standing rule:
      // fees are passed through, never absorbed). Base + fee shown in parens.
      customer: { slug: 'customer', name: 'Customer Membership', priceCents: 567, interval: 'month' }, // $5.00 + $0.67
      customer_annual: { slug: 'customer_annual', name: 'Customer Membership (Annual)', priceCents: 5224, interval: 'year' }, // $50.00 + $2.24
      // Pro-app perk (owner directive 2026-10-05): 6 months for the price of
      // 5 ($25.00 + $1.37 fee), purchasable ONLY by verified Pro-app owners
      // with no active customer-plan membership (anti-gaming: not a
      // downgrade path for existing members; lapsed members eligible).
      customer_6month: { slug: 'customer_6month', name: 'Customer Membership (6-Month)', priceCents: 2637, interval: '6month' }, // $25.00 + $1.37
      artist: { slug: 'design_artist', name: 'Design Artist', priceCents: 567, interval: 'month' }, // $5.00 + $0.67
      shop: { slug: 'tattoo_shop', name: 'Tattoo Shop', priceCents: 10398, interval: 'year' }, // $99.99 + $3.99
    },
    // Subscription incentives (see memberships.js / referrals.js).
    firstMonth: {
      priceCents: 153, // $1.00 + $0.53 fee — first month on new monthly customer memberships
    },
    foundingShop: {
      priceCents: 8328, // $79.99 + $3.29 fee — first year during the founding window (vs $103.98)
    },
  },

  // Campaign caps — reusable mechanism for opening sales and future promos.
  // The first-custom 20% "Opening sale" auto-disables when EITHER cap is
  // reached, whichever comes first. "Sales" = orders reaching paid status
  // (all order types); "visitors" = one count per session (see lib/visitors).
  campaignCaps: {
    visitorCap: 5500,
    paidSalesCap: 150,
  },

  // Shop purchase incentives (owner rule 2026-09-29).
  // Referral volume tiers: a shop's referral commission rises with its
  // VERIFIED (paid, unrefunded) referral sales in a calendar month —
  // 20% base, 22% at 25+, 25% at 50+. Tiers reset on the 1st of each
  // month. The uplift comes ONLY from the owner's share; designer
  // percentages never move.
  referralTiers: {
    baseRate: 0.20,
    tiers: [
      { minMonthlySales: 50, rate: 0.25 },
      { minMonthlySales: 25, rate: 0.22 },
    ],
  },
  // Booking-conversion bonus: a referred purchase (orders.referred_shop_id)
  // that converts into a confirmed booking at the same shop, by the same
  // buyer, within 30 days earns the shop a bonus — flat $5 on premade
  // orders, 5% of the order base on customs. One bonus per order, even
  // with multiple bookings. Funded from site operations; designer and
  // base shop splits are untouched.
  bookingBonus: {
    premadeFlatCents: 500,
    customRate: 0.05,
    windowDays: 30,
  },

  // Founding tattoo-shop window: shops that join before this date pay
  // $79.99 for their first year instead of $99.99. Set FOUNDING_SHOP_WINDOW_END
  // to an ISO date in production; the fallback is a FIXED date (2027-03-01)
  // so the window always closes — never a rolling Date.now() fallback.
  get foundingShopWindowEnd() {
    const raw = (process.env.FOUNDING_SHOP_WINDOW_END || '').trim();
    const parsed = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
    return Date.parse('2027-03-01T00:00:00-06:00');
  },
  foundingShopActive(now = Date.now()) {
    return now < this.foundingShopWindowEnd;
  },
};

module.exports = config;
