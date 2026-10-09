-- 075: Shop expense tracker (owner order 2026-10-09)
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Convention: TEXT ids generated in JS, unix-ms timestamps (see src/db/index.js).
CREATE TABLE IF NOT EXISTS shop_expenses (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  description TEXT,
  spent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_expenses_shop_time ON shop_expenses(shop_user_id, spent_at);
