-- 039: one-time 20%-off-first-custom discount for subscribers (additive only).
-- Redemption is recorded exactly once per user; the orders table carries
-- which discount (if any) priced the order for receipts and line items.
CREATE TABLE IF NOT EXISTS first_custom_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  redeemed_at BIGINT NOT NULL
);
ALTER TABLE orders ADD COLUMN discount_applied TEXT;
-- Lightweight site counters (opening-sale campaign caps; one row per counter).
CREATE TABLE IF NOT EXISTS site_counters (
  name TEXT PRIMARY KEY,
  counter_value BIGINT NOT NULL DEFAULT 0
);
