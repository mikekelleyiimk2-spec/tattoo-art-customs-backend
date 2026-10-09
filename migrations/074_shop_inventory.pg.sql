-- 074: Shop supply inventory with low-stock alerts (owner order 2026-10-09)
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Convention: TEXT ids generated in JS, unix-ms timestamps (see src/db/index.js).
CREATE TABLE IF NOT EXISTS shop_inventory_items (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  unit TEXT,
  updated_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_inventory_items_shop ON shop_inventory_items(shop_user_id);
