-- Custom 48h fulfillment: artist routing + draft pipeline state on orders.
-- Note: delivery_due (set at order creation = created_at + 48h) is the SLA deadline.
ALTER TABLE orders ADD COLUMN requested_artist_id TEXT;
ALTER TABLE orders ADD COLUMN custom_status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE orders ADD COLUMN drafts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN admin_notes TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_orders_custom_status ON orders(custom_status);
