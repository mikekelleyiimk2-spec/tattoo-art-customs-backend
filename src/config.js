// Central configuration — every secret/credential comes from the environment.
// See .env.example and SETUP.md. Nothing sensitive is hardcoded here.
require('dotenv').config();
const path = require('path');

function required(name, fallback = '') {
  const v = process.env[name] || fallback;
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
  playStoreUrl: process.env.PLAY_STORE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || '',
  sqlitePath: process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  assetDir: process.env.ASSET_DIR || path.join(__dirname, '..', 'assets'),

  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: (process.env.PAYPAL_MODE || 'sandbox').toLowerCase(),
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    planIds: {
      customer: process.env.PAYPAL_PLAN_CUSTOMER || '',
      customer_annual: process.env.PAYPAL_PLAN_CUSTOMER_ANNUAL || '',
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
