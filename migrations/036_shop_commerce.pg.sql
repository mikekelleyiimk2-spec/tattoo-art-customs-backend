-- 036: shop commerce (money movement + intake + waitlist + events).
CREATE TABLE IF NOT EXISTS booking_payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_booking_payments_booking ON booking_payments(booking_id);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NULL,
  gift_card_id TEXT NULL,
  kind TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  shop_receives_cents INTEGER NOT NULL,
  customer_total_cents INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_booking ON receipts(booking_id);
CREATE INDEX IF NOT EXISTS idx_receipts_giftcard ON receipts(gift_card_id);

CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  purchaser_user_id TEXT NOT NULL,
  recipient_email TEXT NULL,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  processing_cents INTEGER NOT NULL,
  total_paid_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  shop_user_id TEXT NULL,
  redeemed_booking_id TEXT NULL,
  expires_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_purchaser ON gift_cards(purchaser_user_id);

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  staff_id TEXT NULL,
  customer_user_id TEXT NOT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  offer_expires_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waitlist_shop ON waitlist(shop_user_id, status);

CREATE TABLE IF NOT EXISTS intake_forms (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  placement TEXT NULL,
  size_text TEXT NULL,
  cover_up INTEGER NOT NULL DEFAULT 0,
  details TEXT NULL,
  reference_photos_json TEXT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_events (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  starts_at BIGINT NOT NULL,
  ends_at BIGINT NULL,
  cap INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_events_shop ON shop_events(shop_user_id, starts_at);

CREATE TABLE IF NOT EXISTS event_signups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'signed_up',
  created_at BIGINT NOT NULL,
  UNIQUE(event_id, customer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_signups_event ON event_signups(event_id);
