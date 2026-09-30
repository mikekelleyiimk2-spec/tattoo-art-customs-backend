-- 045: shop toolkit expansion (owner-approved 2026-09-30). [sqlite mirror]
-- Cancellation auto-fill, digital waivers + ID capture, aftercare autopilot,
-- review machine, slow-day blasts, client reactivation, booking attribution,
-- no-show enforcement holds, payment plans. All additive; no behavior change
-- to existing tables.

-- F1: cancellation auto-fill — first-claim-wins broadcast offers.
CREATE TABLE IF NOT EXISTS slot_offers (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  staff_id TEXT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  source_booking_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claim_token TEXT NOT NULL,
  winner_customer_id TEXT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slot_offers_shop ON slot_offers(shop_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_offers_token ON slot_offers(claim_token);

-- F2: digital waivers + ID capture.
CREATE TABLE IF NOT EXISTS shop_waivers (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  legal_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_waivers_shop ON shop_waivers(shop_user_id, active);

CREATE TABLE IF NOT EXISTS waiver_signatures (
  id TEXT PRIMARY KEY,
  waiver_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signature_svg TEXT NOT NULL,
  signed_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waiver_signatures_booking ON waiver_signatures(booking_id);
CREATE INDEX IF NOT EXISTS idx_waiver_signatures_customer ON waiver_signatures(customer_user_id);

-- ID photos: ciphertext only (AES-256-GCM, base64). Plaintext never stored.
CREATE TABLE IF NOT EXISTS waiver_id_docs (
  id TEXT PRIMARY KEY,
  signature_id TEXT NOT NULL,
  enc_blob TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  delete_after BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waiver_id_docs_sig ON waiver_id_docs(signature_id);
CREATE INDEX IF NOT EXISTS idx_waiver_id_docs_purge ON waiver_id_docs(delete_after);

-- F3: aftercare autopilot.
CREATE TABLE IF NOT EXISTS shop_aftercare_templates (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aftercare_tpl_shop ON shop_aftercare_templates(shop_user_id, active);

CREATE TABLE IF NOT EXISTS aftercare_checkins (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  shop_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT NULL,
  healed_photo_requested INTEGER NOT NULL DEFAULT 0,
  review_requested_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aftercare_due ON aftercare_checkins(status, due_at);
CREATE INDEX IF NOT EXISTS idx_aftercare_booking ON aftercare_checkins(booking_id);

CREATE TABLE IF NOT EXISTS healed_photos (
  id TEXT PRIMARY KEY,
  checkin_id TEXT NOT NULL,
  shop_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  image_path TEXT NOT NULL,
  consent_to_post INTEGER NOT NULL DEFAULT 0,
  posted_to_wall INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healed_photos_shop ON healed_photos(shop_user_id, posted_to_wall);

-- F4: review machine.
CREATE TABLE IF NOT EXISTS shop_review_settings (
  shop_user_id TEXT PRIMARY KEY,
  google_review_url TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- F5: slow-day blasts.
CREATE TABLE IF NOT EXISTS shop_blasts (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'past_clients',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_blasts_shop ON shop_blasts(shop_user_id, sent_at);

-- F1/F2/F6: new shop booking settings columns.
ALTER TABLE shop_booking_settings ADD COLUMN autofill_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_booking_settings ADD COLUMN autofill_audience TEXT NOT NULL DEFAULT 'waitlist';
ALTER TABLE shop_booking_settings ADD COLUMN autofill_expiry_minutes INTEGER NOT NULL DEFAULT 120;
ALTER TABLE shop_booking_settings ADD COLUMN id_retention_days INTEGER NOT NULL DEFAULT 730;
ALTER TABLE shop_booking_settings ADD COLUMN reactivation_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_booking_settings ADD COLUMN reactivation_lapse_days INTEGER NOT NULL DEFAULT 180;

-- F7: booking attribution.
ALTER TABLE bookings ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'direct';

-- F8: no-show enforcement — card-hold records (money movement gated on live PayPal).
CREATE TABLE IF NOT EXISTS deposit_holds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  shop_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT NULL,
  paypal_order_id TEXT NULL,
  paypal_authorization_id TEXT NULL,
  decided_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_holds_booking ON deposit_holds(booking_id);
CREATE INDEX IF NOT EXISTS idx_deposit_holds_status ON deposit_holds(status);

-- F9: payment plans (charging gated on live PayPal).
CREATE TABLE IF NOT EXISTS payment_plans (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  customer_user_id TEXT NOT NULL,
  booking_id TEXT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  sessions_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_plans_shop ON payment_plans(shop_user_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_plans_customer ON payment_plans(customer_user_id, status);

CREATE TABLE IF NOT EXISTS plan_installments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_capture_id TEXT NULL,
  charged_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_installments_plan ON plan_installments(plan_id, seq);
CREATE INDEX IF NOT EXISTS idx_plan_installments_due ON plan_installments(status, due_at);
