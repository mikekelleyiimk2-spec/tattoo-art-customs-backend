-- 118: Brambleforce sideload unlock codes (owner orders 2026-10-30).
-- The sideload edition sells its in-app extras through this website:
-- a paid IAP order issues ONE single-use unlock code; the game redeems
-- it at POST /api/brambleforce/redeem. Only the SHA-256 hash of the
-- normalized code is stored — the raw code is shown once on the success
-- page and emailed to the buyer. spent flips 0 -> 1 at redemption and
-- a spent code stays spent (the game shows its spent message).
CREATE TABLE IF NOT EXISTS brambleforce_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL,
  order_id TEXT,
  spent BIGINT NOT NULL DEFAULT 0,
  spent_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brambleforce_codes_order ON brambleforce_codes (order_id);
