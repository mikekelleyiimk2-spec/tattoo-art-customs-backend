-- 038: paid event registrations + session-balance support (additive only).
-- Shop tools payments route exclusively through the website PayPal/card
-- checkout; never Google Play Billing.
ALTER TABLE shop_events ADD COLUMN IF NOT EXISTS registration_price_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS event_signup_payments (
  id TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  base_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  processing_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_order_id TEXT NULL,
  paypal_capture_id TEXT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_signup_payments_signup ON event_signup_payments(signup_id);
