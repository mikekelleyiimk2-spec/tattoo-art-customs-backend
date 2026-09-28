-- 008: print-on-demand orders for purchased art (manual fulfillment v1; POD provider hook in lib/print.js).
CREATE TABLE IF NOT EXISTS print_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  design_id TEXT,
  combo_id TEXT,
  product TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  style TEXT NOT NULL DEFAULT 'color',
  ship_name TEXT NOT NULL DEFAULT '',
  ship_address1 TEXT NOT NULL DEFAULT '',
  ship_address2 TEXT NOT NULL DEFAULT '',
  ship_city TEXT NOT NULL DEFAULT '',
  ship_state TEXT NOT NULL DEFAULT '',
  ship_zip TEXT NOT NULL DEFAULT '',
  ship_country TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  fulfilled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_print_orders_status ON print_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_print_orders_user ON print_orders(user_id, created_at);
