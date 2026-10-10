-- 080: automatic request-ZIP delivery for paid request orders.
-- request_zip_deliveries: one row per paid request order that got its ZIP
-- (the delivery record: which ZIP, which buyer, when). The download token
-- lives in the existing downloads table (issueDownloadToken).
-- request_zip_review: fail-closed queue — orders whose ZIP mapping was
-- ambiguous are NEVER auto-delivered; the owner resolves them by hand.
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
CREATE TABLE IF NOT EXISTS request_zip_deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  zip_key TEXT NOT NULL,
  zip_file TEXT NOT NULL,
  buyer_email TEXT NOT NULL DEFAULT '',
  delivered_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_zip_deliveries_order ON request_zip_deliveries(order_id);
CREATE TABLE IF NOT EXISTS request_zip_review (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  brief_snippet TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_request_zip_review_order ON request_zip_review(order_id);
CREATE INDEX IF NOT EXISTS idx_request_zip_review_open ON request_zip_review(resolved_at);
