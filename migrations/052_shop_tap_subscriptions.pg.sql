-- 052: tap-to-pay standalone subscription billing (owner-approved 2026-10-04)
-- Shops-only monthly tiers (solo/studio/shop). Bill-current = service-active.
-- Comped accounts (Adolfo standing rule) live in code, not rows.
CREATE TABLE IF NOT EXISTS shop_tap_subscriptions (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'solo',
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_subscription_id TEXT NOT NULL DEFAULT '',
  comped INTEGER NOT NULL DEFAULT 0,
  current_period_start BIGINT,
  current_period_end BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0,
  canceled_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tap_subs_shop ON shop_tap_subscriptions(shop_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tap_subs_paypal ON shop_tap_subscriptions(paypal_subscription_id);
