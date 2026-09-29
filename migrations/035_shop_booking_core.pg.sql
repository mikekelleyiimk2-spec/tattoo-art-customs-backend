-- 035: shop booking core (scheduling). Phase 1 of the shop toolset.
-- Deposit-before-booking flow: the customer pays the deposit first
-- (booking_deposits), gets a credit, then picks a slot.
CREATE TABLE IF NOT EXISTS shop_booking_settings (
  shop_user_id TEXT PRIMARY KEY,
  deposit_before_booking INTEGER NOT NULL DEFAULT 0,
  deposit_amount_cents INTEGER NULL,
  deposit_policy_text TEXT NULL,
  noshow_forfeit_deposit INTEGER NOT NULL DEFAULT 1,
  cancel_window_hours INTEGER NOT NULL DEFAULT 24,
  slot_hold_minutes INTEGER NOT NULL DEFAULT 30,
  deposit_credit_expiry_days INTEGER NOT NULL DEFAULT 90,
  booking_instructions TEXT NULL
);

CREATE TABLE IF NOT EXISTS shop_chairs (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_chairs_shop ON shop_chairs(shop_user_id);

CREATE TABLE IF NOT EXISTS shop_staff (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  artist_user_id TEXT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_staff_shop ON shop_staff(shop_user_id);

CREATE TABLE IF NOT EXISTS availability_rules (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  staff_id TEXT NULL,
  chair_id TEXT NULL,
  weekday INTEGER NOT NULL,
  start_minutes INTEGER NOT NULL,
  end_minutes INTEGER NOT NULL,
  slot_length_minutes INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_availability_shop ON availability_rules(shop_user_id);
CREATE INDEX IF NOT EXISTS idx_availability_staff ON availability_rules(staff_id);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  staff_id TEXT NULL,
  chair_id TEXT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_deposit',
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'shop_page',
  design_id TEXT NULL,
  intake_form_id TEXT NULL,
  cancelled_at BIGINT NULL,
  completed_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(shop_user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

CREATE TABLE IF NOT EXISTS booking_deposits (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  processing_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  booking_id TEXT NULL,
  paypal_capture_id TEXT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_deposits_shop ON booking_deposits(shop_user_id, customer_user_id);
CREATE INDEX IF NOT EXISTS idx_booking_deposits_booking ON booking_deposits(booking_id);
