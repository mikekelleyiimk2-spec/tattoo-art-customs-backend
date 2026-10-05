-- 052: Pro-app purchase registry (owner directive 2026-10-05).
-- The paid Pro app (no ads, ever) unlocks a 6-month customer membership
-- perk (customer_6month plan). This table records VERIFIED Pro purchases so
-- the perk is gated to real purchasers only. Android Pro = Play Billing
-- one-time purchase verified via src/lib/playverify.js (service account).
-- iOS sideload Pro ($1.67) = recorded by the website at capture time in
-- src/routes/iosApp.js. Exactly-once: purchase_token is UNIQUE, so a replayed
-- or duplicated token can never grant the perk twice.

CREATE TABLE IF NOT EXISTS pro_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purchase_token TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  verified_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pro_purchases_user ON pro_purchases(user_id);
