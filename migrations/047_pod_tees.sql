-- 047: POD custom tees (owner rule 2026-09-30; additive only).
--
-- Tees ride the existing print_orders / Printful auto-fulfillment path:
-- size and color are apparel-only columns (blank for paper/canvas prints).
-- Tee ordering requires owning the design (same rule as prints), so the
-- designer was already paid on the design sale; the shirt itself is a
-- site-margin physical product (see the merch_tee guard in
-- recordSaleCommissions). merch_notify collects launch-notify emails while
-- Printful is not configured yet.
ALTER TABLE print_orders ADD COLUMN size TEXT NOT NULL DEFAULT '';
ALTER TABLE print_orders ADD COLUMN color TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS merch_notify (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merch_notify_email ON merch_notify(email);
