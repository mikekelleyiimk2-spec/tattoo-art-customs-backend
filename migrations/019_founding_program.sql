-- Founding Members launch program (2026-09-28).
--
-- Founding design artists (first 50): 80% commission instead of 70%,
--   for 6 months after activation.
--   users.is_founding_artist / users.founding_artist_ends_at (unix-ms)
-- Founding tattoo shops (first 100): $79.99 first year instead of $99.99,
--   plus 25% referral commission instead of 20% for 6 months.
--   users.is_founding_shop / users.founding_shop_ends_at (unix-ms)
-- founding_counters: single global row enforcing the 50/100 claim caps.
-- raffle_entries: one row per user (UNIQUE on user_id gives one entry ever),
--   prize_won is filled in when the draw runs ('grand', 'annual', 'credit').
-- The raffle window lives in settings.raffle_ends_at (unix-ms as TEXT) and
--   defaults to 60 days after this migration is applied (the launch); the
--   admin can change it on /admin/founding.
ALTER TABLE users ADD COLUMN is_founding_artist BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN founding_artist_ends_at BIGINT;
ALTER TABLE users ADD COLUMN is_founding_shop BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN founding_shop_ends_at BIGINT;

CREATE TABLE IF NOT EXISTS founding_counters (
  id TEXT PRIMARY KEY,
  artists_claimed BIGINT NOT NULL DEFAULT 0,
  shops_claimed BIGINT NOT NULL DEFAULT 0
);
INSERT INTO founding_counters (id, artists_claimed, shops_claimed)
  SELECT 'global', 0, 0 WHERE NOT EXISTS (SELECT 1 FROM founding_counters WHERE id = 'global');

CREATE TABLE IF NOT EXISTS raffle_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entered_at BIGINT NOT NULL,
  prize_won TEXT,
  drawn_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raffle_entry_user ON raffle_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_raffle_entry_drawn ON raffle_entries(drawn_at);
