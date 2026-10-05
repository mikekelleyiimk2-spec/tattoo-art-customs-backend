-- 054: customer<->shop art pipeline (send-to-shop transfers + shop buy-for-client).
-- Money-safety: every transfer traces to a PAID order. No free transfers.
CREATE TABLE IF NOT EXISTS art_transfers (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  design_id TEXT,
  from_user_id TEXT NOT NULL,
  to_shop_user_id TEXT,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'to_shop',
  token TEXT UNIQUE NOT NULL,
  expires_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  license_note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  claimed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_art_transfers_token ON art_transfers(token);
CREATE INDEX IF NOT EXISTS idx_art_transfers_shop ON art_transfers(to_shop_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_art_transfers_order ON art_transfers(order_id, created_at);
-- Client bills: when a shop buys art for a client, the cost lands here for
-- the shop to collect from the client and mark paid.
CREATE TABLE IF NOT EXISTS client_bills (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_user_id TEXT,
  order_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',
  note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  paid_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_client_bills_shop ON client_bills(shop_user_id, created_at);
-- Buy-for-client linkage on orders (NULL = normal customer purchase).
ALTER TABLE orders ADD COLUMN client_email TEXT;
ALTER TABLE orders ADD COLUMN client_user_id TEXT;
