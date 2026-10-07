-- 058: track which private-library collection fulfilled each custom order,
-- so the publishing artist gets compensated.
CREATE TABLE IF NOT EXISTS library_fulfillments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  collection_file TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  artist_user_id INTEGER,
  fulfilled_by INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_fulfillments_order ON library_fulfillments(order_id);
CREATE INDEX IF NOT EXISTS idx_library_fulfillments_artist ON library_fulfillments(artist_user_id);
