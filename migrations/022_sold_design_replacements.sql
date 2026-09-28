-- 022: sold designs are delisted (exclusive sale) and queue a replacement.
-- Each premade sale marks the design 'sold' (gallery/shop/app filter on
-- status = 'approved', so it disappears automatically) and records a row in
-- design_replacements so the catalog pipeline can make a replacement.
ALTER TABLE designs ADD COLUMN sold_at BIGINT;
CREATE TABLE IF NOT EXISTS design_replacements (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',
  artist_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_replacements_status ON design_replacements(status);
