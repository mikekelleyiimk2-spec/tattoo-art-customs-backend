-- 073: Shop-internal artist commission tracker (owner order 2026-10-09)
-- INTERNAL shop bookkeeping only — separate from the marketplace commission
-- engine (src/lib/commissions.js), which this does not touch.
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Convention: TEXT ids generated in JS, unix-ms timestamps (see src/db/index.js).
CREATE TABLE IF NOT EXISTS shop_artists (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  commission_rate_pct INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_artist_earnings (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES shop_artists(id) ON DELETE CASCADE,
  booking_id TEXT,
  amount_cents INTEGER NOT NULL,
  artist_share_cents INTEGER NOT NULL,
  shop_share_cents INTEGER NOT NULL,
  note TEXT,
  earned_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_artist_earnings_shop_time ON shop_artist_earnings(shop_user_id, earned_at);
