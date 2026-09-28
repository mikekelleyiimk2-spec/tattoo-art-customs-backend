-- 009: app account linking (api_token), Play purchase linking/verification,
-- Printful auto-fulfillment tracking.
ALTER TABLE users ADD COLUMN api_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token ON users(api_token);

ALTER TABLE play_purchases ADD COLUMN user_id TEXT;
ALTER TABLE play_purchases ADD COLUMN linked_membership_id TEXT;
CREATE INDEX IF NOT EXISTS idx_play_purchases_user ON play_purchases(user_id);

ALTER TABLE print_orders ADD COLUMN printful_order_id TEXT;
ALTER TABLE print_orders ADD COLUMN tracking_number TEXT;
ALTER TABLE print_orders ADD COLUMN tracking_url TEXT;
ALTER TABLE print_orders ADD COLUMN fulfill_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_orders_fulfill_token ON print_orders(fulfill_token);
