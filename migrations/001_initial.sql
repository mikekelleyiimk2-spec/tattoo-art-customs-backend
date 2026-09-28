-- Tattoo Art Customs initial schema.
-- Single dialect for PostgreSQL and SQLite: TEXT ids, BIGINT flags,
-- BIGINT unix-ms timestamps, money in BIGINT cents.

CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  display_name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  email_verified BIGINT NOT NULL DEFAULT 0,
  reset_token TEXT,
  reset_expires BIGINT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents BIGINT NOT NULL,
  interval TEXT NOT NULL,
  paypal_plan_id TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  active BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_subscription_id TEXT NOT NULL DEFAULT '',
  current_period_end BIGINT,
  created_at BIGINT NOT NULL,
  canceled_at BIGINT
);

CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',
  color_path TEXT NOT NULL DEFAULT '',
  linework_path TEXT NOT NULL DEFAULT '',
  linework_wm_path TEXT NOT NULL DEFAULT '',
  price_cents BIGINT NOT NULL DEFAULT 7500,
  artist_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  sale_count BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artist_profiles (
  user_id TEXT PRIMARY KEY,
  bio TEXT NOT NULL DEFAULT '',
  bio_status TEXT NOT NULL DEFAULT 'ok',
  payout_paypal_email TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_profiles (
  user_id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  appointment_requirements TEXT NOT NULL DEFAULT '',
  profile_status TEXT NOT NULL DEFAULT 'ok',
  referral_code TEXT UNIQUE,
  payout_paypal_email TEXT NOT NULL DEFAULT '',
  verified BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  design_id TEXT,
  order_type TEXT NOT NULL DEFAULT 'premade',
  amount_cents BIGINT NOT NULL,
  deposit_cents BIGINT NOT NULL DEFAULT 0,
  amount_paid_cents BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_order_id TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'paypal',
  referral_code TEXT NOT NULL DEFAULT '',
  referred_shop_id TEXT,
  custom_brief TEXT NOT NULL DEFAULT '',
  delivery_due BIGINT,
  created_at BIGINT NOT NULL,
  paid_at BIGINT
);

CREATE TABLE IF NOT EXISTS commission_ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT,
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  paid_at BIGINT
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  paypal_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  screened BIGINT NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_designs_status ON designs(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON commission_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_recipient ON commission_ledger(recipient_type, recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
