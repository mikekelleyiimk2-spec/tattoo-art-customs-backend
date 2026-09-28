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
      artist: process.env.PAYPAL_PLAN_ARTIST || '',
      shop: process.env.PAYPAL_PLAN_SHOP || '',
    },
  },
  paypalConfigured() {
    return !!(this.paypal.clientId && this.paypal.clientSecret);
  },
  paypalPlansConfigured() {
    const p = this.paypal.planIds;
    return this.paypalConfigured() && !!(p.customer && p.artist && p.shop);
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
      customer: { slug: 'customer', name: 'Customer Membership', priceCents: 500, interval: 'month' },
      artist: { slug: 'design_artist', name: 'Design Artist', priceCents: 500, interval: 'month' },
      shop: { slug: 'tattoo_shop', name: 'Tattoo Shop', priceCents: 9999, interval: 'year' },
    },
  },
};

module.exports = config;
