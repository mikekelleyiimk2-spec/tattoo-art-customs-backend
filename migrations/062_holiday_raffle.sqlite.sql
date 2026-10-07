-- 062: Holiday Doodle Raffle (Dec 2026) — entry ledger, winners, prize codes.
-- Separate tables from the opening raffle (raffle_entries) in lib/founding.js.
CREATE TABLE IF NOT EXISTS holiday_raffles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ends_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS holiday_raffle_entries (
  id TEXT PRIMARY KEY,
  raffle_id TEXT NOT NULL REFERENCES holiday_raffles(id),
  user_id TEXT NOT NULL,
  entries INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (raffle_id, source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_holiday_raffle_entries_raffle
  ON holiday_raffle_entries (raffle_id);
CREATE INDEX IF NOT EXISTS idx_holiday_raffle_entries_user
  ON holiday_raffle_entries (raffle_id, user_id);
CREATE TABLE IF NOT EXISTS holiday_raffle_winners (
  id TEXT PRIMARY KEY,
  raffle_id TEXT NOT NULL REFERENCES holiday_raffles(id),
  user_id TEXT NOT NULL,
  entries_snapshot INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL UNIQUE,
  drawn_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS holiday_raffle_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  raffle_id TEXT NOT NULL REFERENCES holiday_raffles(id),
  winner_id TEXT REFERENCES holiday_raffle_winners(id),
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_at BIGINT,
  created_at BIGINT NOT NULL
);
-- Track entry-pack bundle size on the order for the paid hook.
-- SQLite has no IF NOT EXISTS for ADD COLUMN before 3.35; the migrate()
-- idempotency rewrite handles re-runs, so plain ADD COLUMN is safe here.
ALTER TABLE orders ADD COLUMN raffle_entries_bought INTEGER NOT NULL DEFAULT 0;
