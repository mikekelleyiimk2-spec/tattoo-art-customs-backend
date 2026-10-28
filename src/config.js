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
  // Sign in with Google — door #1 of the OneMind log (owner anchor,
  // 2026-10-26: ride the established structure everyone already has).
  // Both values come from the one OAuth client the owner creates in
  // Google Cloud Console. Until both are set the door is CLOSED —
  // the button does not render and /auth/google 404s (lib/googleSeat).
  googleSignin: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  playStoreUrl: process.env.PLAY_STORE_URL || '',
  playStoreProUrl: process.env.PLAY_STORE_URL_PRO || '',
  appStoreUrl: process.env.APP_STORE_URL || '',
  youtubeUrl: process.env.YOUTUBE_CHANNEL_URL || '',
  // Little Inkers YouTube channel (one-way cross-promo, owner 2026-10-07):
  // TAC side promotes the kids' channel; kids' content never links back.
  // Empty until the channel exists — links render only when set.
  littleInkersYoutubeUrl: process.env.LITTLE_INKERS_YOUTUBE_URL || '',
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
      // Tap-to-pay standalone tiers (owner-approved 2026-10-04): monthly
      // PayPal subscription plans, created in the PayPal dashboard by the
      // owner. Until set, tap checkout shows "being set up".
      tap_solo: process.env.PAYPAL_PLAN_TAP_SOLO || '',
      tap_studio: process.env.PAYPAL_PLAN_TAP_STUDIO || '',
      tap_shop: process.env.PAYPAL_PLAN_TAP_SHOP || '',
      // Dawnfold publication plans (owner order 2026-10-27): created
      // in the PayPal dashboard (mk4 business app) like every other plan
      // here. Until an ID is set, that plan's PayPal checkout shows the
      // house-standard "being set up" state — the plan still exists in
      // the register and the site-credit path works (see lib/thebigone).
      the_big_one: process.env.PAYPAL_PLAN_THE_BIG_ONE || '',
      the_big_one_annual: process.env.PAYPAL_PLAN_THE_BIG_ONE_ANNUAL || '',
      the_big_one_founding: process.env.PAYPAL_PLAN_THE_BIG_ONE_FOUNDING || '',
      the_big_one_supporter: process.env.PAYPAL_PLAN_THE_BIG_ONE_SUPPORTER || '',
      the_big_one_waiting_room: process.env.PAYPAL_PLAN_THE_BIG_ONE_WAITING_ROOM || '',
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
  // All three tap-to-pay tier plans must exist for tap checkout.
  paypalTapPlansConfigured() {
    const p = this.paypal.planIds;
    return this.paypalConfigured() && !!(p.tap_solo && p.tap_studio && p.tap_shop);
  },
  // Dedicated founding-shop plan (trial pricing defined in the plan itself —
  // PayPal rejects a 1-year TRIAL billing-cycle override at subscription
  // creation, so the founding discount lives in its own plan). Gated on the
  // plan ID alone: if API credentials are missing, checkout fails gracefully
  // with a friendly message anyway.
  paypalFoundingShopPlanConfigured() {
    return !!this.paypal.planIds.founding_shop;
  },
  // One Big One plan's PayPal checkout readiness (per-plan, like the
  // annual/6-month optionals): credentials + that plan's dashboard ID.
  paypalBigOnePlanConfigured(planKey) {
    return this.paypalConfigured() && !!this.paypal.planIds[planKey];
  },
  paypalBaseUrl() {
    return this.paypal.mode === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  },

  // Auto-charging for no-show forfeits + plan installments. OWNER RULE:
  // stays OFF until explicitly enabled — never attempt a charge otherwise.
  autoChargeEnabled: process.env.AUTO_CHARGE_ENABLED === '1',

  // Buy Now Pay Later providers (owner directive 2026-10-09).
  // Klarna: sign up at https://www.klarna.com/us/business/
  klarna: {
    username: process.env.KLARNA_USERNAME || '',
    password: process.env.KLARNA_PASSWORD || '',
    region: (process.env.KLARNA_REGION || 'us').toLowerCase(),
  },
  klarnaConfigured() {
    return !!(this.klarna.username && this.klarna.password);
  },
  // Afterpay/Clearpay: sign up at https://www.afterpay.com/
  afterpay: {
    merchantId: process.env.AFTERPAY_MERCHANT_ID || '',
    secretKey: process.env.AFTERPAY_SECRET_KEY || '',
    region: (process.env.AFTERPAY_REGION || 'us').toLowerCase(),
  },
  afterpayConfigured() {
    return !!(this.afterpay.merchantId && this.afterpay.secretKey);
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

  // Feedback inbox (owner order 2026-10-14): ALL feedback/support mail —
  // website contact form today, any future feedback surface — goes to ONE
  // inbox: mikekelleyii.mk2@gmail.com, where the daily feedback scan reads it.
  feedbackEmail: process.env.FEEDBACK_EMAIL || 'mikekelleyii.mk2@gmail.com',

  // Google AdSense — empty publisher ID means ads stay off.
  // slots: per-placement ad unit IDs created in the AdSense console
  // (Ads > By ad unit). A placement renders a real AdSense unit only when
  // its slot ID is set here; without one the ad-slot chain ends at the
  // house creative — a bare <ins> with no data-ad-slot can never fill, so
  // none is emitted (Polish Day fix 2026-10-27).
  adsense: {
    publisherId: process.env.ADSENSE_PUBLISHER_ID || '',
    slots: {
      leaderboard: process.env.ADSENSE_SLOT_LEADERBOARD || '',
      gallery_inline: process.env.ADSENSE_SLOT_GALLERY_INLINE || '',
      design_page: process.env.ADSENSE_SLOT_DESIGN_PAGE || '',
      home_inline: process.env.ADSENSE_SLOT_HOME_INLINE || '',
      merch_inline: process.env.ADSENSE_SLOT_MERCH_INLINE || '',
      apps_inline: process.env.ADSENSE_SLOT_APPS_INLINE || '',
      aftercare_inline: process.env.ADSENSE_SLOT_AFTERCARE_INLINE || '',
    },
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
      // Dawnfold publication (owner order 2026-10-27; base prices set
      // in the publication order, fee pass-through applied like every
      // plan above). lib/thebigone.js is the publication's own config
      // face (sponsor rate card, classifieds fees, founding cap) and
      // reads these plan rows — prices live in exactly one place each.
      the_big_one: { slug: 'the_big_one', name: 'Dawnfold — Subscription', priceCents: 565, interval: 'month' }, // $4.99 + $0.66
      the_big_one_annual: { slug: 'the_big_one_annual', name: 'Dawnfold — Subscription (Annual)', priceCents: 4188, interval: 'year' }, // $39.99 + $1.89
      the_big_one_founding: { slug: 'the_big_one_founding', name: 'Dawnfold — Founding Member', priceCents: 358, interval: 'month' }, // $2.99 + $0.59, locked rate, first 500
      the_big_one_supporter: { slug: 'the_big_one_supporter', name: 'Dawnfold — Supporter', priceCents: 1083, interval: 'month' }, // $9.99 + $0.84, name in the masthead
      the_big_one_waiting_room: { slug: 'the_big_one_waiting_room', name: 'Dawnfold — Waiting Room', priceCents: 2118, interval: 'month' }, // $19.99 + $1.19, business rate
    },
    // Subscription incentives (see memberships.js / referrals.js).
    firstMonth: {
      priceCents: 153, // $1.00 + $0.53 fee — first month on new monthly customer memberships
    },
    foundingShop: {
      priceCents: 8328, // $79.99 + $3.29 fee — first year during the founding window (vs $103.98)
    },
    // Show-featured discount (owner rule 2026-10-08): designs used on the
    // Little Inkers "Color With Us!" show (designs.show_featured = 1) are
    // this percent off for active TAC customer-plan members. Default 20.
    showFeaturedDiscountPct: 20,
  },

  // Business cards for tattoo-shop subscribers (owner order 2026-10-14).
  // PRICING — FINAL (owner, 2026-10-14, supersedes the morning's +5%):
  // BOTH models combined — paid orders at real fulfillment cost x 1.25
  // per tier, PLUS one FREE box for annual-plan shops: smallest set only
  // (50 cards), once per shop, ever. Selling prices are computed by
  // priceCentsFor() in src/lib/businessCards.js from the cost inputs
  // below; the free box is the freeTierKey tier below.
  // COST EVIDENCE: Printful POST /orders/estimate-costs, live API quotes on
  // 2026-10-14 for product 724 "Set of Business Cards" (3.5"x2", double-
  // sided) shipped to a US (Louisiana) address. Cost = Printful's total
  // charge to us (product subtotal + shipping + the tax Printful charges
  // us). Shipping/tax vary by destination; these are US-standard figures.
  // Re-quote and update the inputs if Printful pricing changes — the
  // selling price follows automatically at cost x 1.25.
  // Checkout kill-switch: BUSINESS_CARDS_CHECKOUT=0 disables purchasing
  // AND free-box claims (browse-only). Default ON for shop subscribers
  // (owner pricing ruling supersedes price approval — the formula IS
  // the approval).
  businessCards: {
    checkoutEnabled: process.env.BUSINESS_CARDS_CHECKOUT !== '0',
    marginRate: 0.25,
    // Free first box for annual tattoo_shop subscribers: this tier only
    // (the 50-card set, Printful variant 18554), one per shop account,
    // ever. Redemption is tracked on business_card_orders.is_free_box
    // (migration 088); see freeBoxStatus() in src/lib/businessCards.js.
    freeTierKey: '50',
    printfulProductId: 724,
    tiers: {
      // variantId 18554 = set of 50, 18555 = set of 100 (Printful catalog)
      '50': {
        cards: 50,
        printfulItems: [{ variantId: 18554, quantity: 1 }],
        cost: { subtotalCents: 1035, shippingCents: 659, taxCents: 186, totalCents: 1880 },
      },
      '100': {
        cards: 100,
        printfulItems: [{ variantId: 18555, quantity: 1 }],
        cost: { subtotalCents: 1868, shippingCents: 659, taxCents: 277, totalCents: 2804 },
      },
      '250': {
        cards: 250,
        printfulItems: [{ variantId: 18555, quantity: 2 }, { variantId: 18554, quantity: 1 }],
        cost: { subtotalCents: 4771, shippingCents: 1159, taxCents: 652, totalCents: 6582 },
      },
      '500': {
        cards: 500,
        printfulItems: [{ variantId: 18555, quantity: 5 }],
        cost: { subtotalCents: 9340, shippingCents: 1659, taxCents: 1209, totalCents: 12208 },
      },
      '1000': {
        cards: 1000,
        printfulItems: [{ variantId: 18555, quantity: 10 }],
        cost: { subtotalCents: 18680, shippingCents: 2909, taxCents: 2375, totalCents: 23964 },
      },
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
