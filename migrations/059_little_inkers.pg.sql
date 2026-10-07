-- 059: Little Inkers pipeline — redeem codes (TAC -> app) and
-- submission codes (app -> TAC doodle-to-tattoo orders).
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  issued_to_user INTEGER NOT NULL,
  order_id TEXT,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_user ON redeem_codes(issued_to_user);

CREATE TABLE IF NOT EXISTS submission_codes (
  code TEXT PRIMARY KEY,
  created_by_user INTEGER,
  order_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_codes_order ON submission_codes(order_id);

-- Doodle-to-tattoo order fields.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS doodle_file TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS doodle_tier TEXT;
