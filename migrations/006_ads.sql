-- 006: direct-sold ad space (advertisers buy banner placements; admin activates after payment).
CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  title TEXT NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL,
  advertiser_name TEXT NOT NULL DEFAULT '',
  advertiser_email TEXT NOT NULL DEFAULT '',
  months BIGINT NOT NULL DEFAULT 1,
  starts_at BIGINT NOT NULL DEFAULT 0,
  ends_at BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_slot_active ON ads(slot, active, starts_at, ends_at);
