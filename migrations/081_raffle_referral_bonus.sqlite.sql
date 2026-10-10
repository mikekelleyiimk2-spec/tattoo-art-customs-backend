-- 081: opening-raffle refer-a-friend bonus entries.
-- raffle_entries.bonus_entries: extra tickets earned when a friend signs up
-- through the entrant's personal share link (3 per referral). The draw
-- weights each row by 1 + bonus_entries.
-- raffle_referral_credits: one row per credited referral (UNIQUE on
-- referred_user_id makes the 3-entry credit idempotent).
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
ALTER TABLE raffle_entries ADD COLUMN bonus_entries INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS raffle_referral_credits (
  id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  bonus_entries INTEGER NOT NULL DEFAULT 3,
  credited_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raffle_referral_credit_referred ON raffle_referral_credits(referred_user_id);
CREATE INDEX IF NOT EXISTS idx_raffle_referral_credit_referrer ON raffle_referral_credits(referrer_user_id);
