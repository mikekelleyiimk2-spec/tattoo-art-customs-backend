-- 108: Tester Hub "Fill My Tester List" (owner design 2026-10-26).
-- ONE developer purchase ($24.99, one app, one charge) puts an app
-- into the FILL CYCLE: pooled testers are routed in waves; each tester
-- opts in THEMSELVES on Google's page (the Hub never fakes the tap).
-- testers confirm in-app and the Hub counts confirmed opt-ins until
-- the list is FULL (12). Top-ups are free inside the app's 14-day
-- closed-test run ("full stays full"). A new app / new run = a new
-- charge. The tester side stays free + ad-supported; this is the
-- developer crowd's door only.
--
-- Payment-rail honesty: an order starts 'awaiting_payment' and can
-- NEVER enter the cycle in that state. It flips to 'filling' only
-- through the entitlement grant (src/lib/fillCycle.js), the same
-- managed-grant pattern the Profile Plug uses until Play Billing
-- receipt verification lands on the console train.
CREATE TABLE IF NOT EXISTS tester_fill_orders (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  package TEXT NOT NULL,
  developer_gmail TEXT NOT NULL,
  price_cents BIGINT NOT NULL DEFAULT 2499,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  wave BIGINT NOT NULL DEFAULT 0,
  target BIGINT NOT NULL DEFAULT 12,
  purchase_ref TEXT,
  simulated BIGINT NOT NULL DEFAULT 0,
  run_started_at BIGINT,
  run_ends_at BIGINT,
  full_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tester_fill_orders_package ON tester_fill_orders(package);
CREATE INDEX IF NOT EXISTS idx_tester_fill_orders_status ON tester_fill_orders(status);
-- One confirmation per tester per fill run. The confirmation is the
-- tester's own in-app attestation made AFTER Google's page told them
-- "You're a tester" (the house screenshot standard stays the proof
-- layer a developer can ask for; this row is what the counter reads).
CREATE TABLE IF NOT EXISTS tester_fill_confirmations (
  id TEXT PRIMARY KEY,
  fill_order_id TEXT NOT NULL,
  package TEXT NOT NULL,
  tester_gmail TEXT NOT NULL,
  confirmed_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tester_fill_conf_unique
  ON tester_fill_confirmations(fill_order_id, tester_gmail);
CREATE INDEX IF NOT EXISTS idx_tester_fill_conf_order ON tester_fill_confirmations(fill_order_id);
-- Who was routed in which wave (the roster slices the cycle sends).
CREATE TABLE IF NOT EXISTS tester_fill_wave_members (
  id TEXT PRIMARY KEY,
  fill_order_id TEXT NOT NULL,
  wave BIGINT NOT NULL,
  tester_gmail TEXT NOT NULL,
  routed_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tester_fill_wave_unique
  ON tester_fill_wave_members(fill_order_id, tester_gmail);
-- The dopamine light-board feed: REAL events only, written by the
-- cycle itself (fill started / wave out / tester confirmed / FULL /
-- top-up). Developer + app names are public Hub profile data; tester
-- personal data is NEVER written here.
CREATE TABLE IF NOT EXISTS tester_fill_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  package TEXT NOT NULL,
  app_name TEXT NOT NULL,
  developer_name TEXT,
  confirmed_count BIGINT,
  target BIGINT,
  wave BIGINT,
  elapsed_ms BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tester_fill_events_created ON tester_fill_events(created_at);
