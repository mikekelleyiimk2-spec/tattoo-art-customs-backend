-- 113: The guest bridge (owner ruling 2026-10-26 19:21 + refinement
-- 19:23). The guest checkout lanes STAY; no-entry governs member
-- areas and seats, commerce keeps its doors — and the bridge makes
-- the exception temporary, differently per lane:
--   * DESIGN purchases bridge on buy: the completed guest buy fires
--     a §7 seat claim (claim_source 'guest-purchase', seat_claims)
--     for the delivery email; the verify tap seats the buyer and
--     attaches the order (src/lib/seatClaims.js).
--   * PAID-APP / SIDELOAD purchases do NOT claim on buy. While an
--     app is sideload-only its buyers stay guests like everyone
--     else; the purchase records a PENDING TIE here (buyer email x
--     app x order). When the app goes live on the store, the
--     pending ties for that app fire — one claim email per buyer —
--     via POST /api/onemind/pending-ties/fire (service token),
--     which also flips app_store_live so later guest buys of that
--     app bridge on buy like designs do.
-- app_key is the checkout flow's app identifier: the buy-app
-- package name (e.g. com.usefulappz.odometer), 'tac_android_pro',
-- or 'ios_app'.
CREATE TABLE IF NOT EXISTS guest_pending_ties (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  app_key TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_id TEXT,
  created_at BIGINT NOT NULL,
  fired_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_pending_ties_order ON guest_pending_ties (order_id);
CREATE INDEX IF NOT EXISTS idx_guest_pending_ties_app ON guest_pending_ties (app_key, status);
CREATE INDEX IF NOT EXISTS idx_guest_pending_ties_email ON guest_pending_ties (email);

CREATE TABLE IF NOT EXISTS app_store_live (
  id TEXT PRIMARY KEY,
  app_key TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  live_at BIGINT,
  updated_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_store_live_key ON app_store_live (app_key);
