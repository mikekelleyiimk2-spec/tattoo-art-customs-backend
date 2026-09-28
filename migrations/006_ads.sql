-- 006: direct-sold ad space (advertisers buy banner placements; admin activates after payment).
CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  title TEXT NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL,
  advertiser_name TEXT NOT NULL DEFAULT '',
  advertiser_email TEXT NOT NULL DEFAULT '',
  months INTEGER NOT NULL DEFAULT 1,
  starts_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_slot_active ON ads(slot, active, starts_at, ends_at);
