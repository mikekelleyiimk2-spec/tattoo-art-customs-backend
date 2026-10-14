-- 087: Business card orders for tattoo-shop subscribers (owner order
-- 2026-10-14). One row per business-card order, linked to the generic
-- orders row (payment) and the print_orders row (fulfillment queue /
-- Printful submission). The card print files live under uploads/bcards/
-- (front = the shop's chosen art, back = the composed contact-lines card)
CREATE TABLE IF NOT EXISTS business_card_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  print_order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  shop_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email_line TEXT NOT NULL DEFAULT '',
  address_line TEXT NOT NULL DEFAULT '',
  website_line TEXT NOT NULL DEFAULT '',
  socials_line TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '100',
  quantity INTEGER NOT NULL DEFAULT 100,
  design_source TEXT NOT NULL DEFAULT 'upload',
  design_id TEXT,
  art_file TEXT NOT NULL DEFAULT '',
  back_file TEXT NOT NULL DEFAULT '',
  cost_cents BIGINT NOT NULL DEFAULT 0,
  price_cents BIGINT NOT NULL DEFAULT 0,
  fulfillment_note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bcard_user ON business_card_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_bcard_order ON business_card_orders (order_id);
