-- 033: site key-value store (feature flags, alert watermarks, etc.).
CREATE TABLE IF NOT EXISTS site_kv (
  name TEXT PRIMARY KEY,
  val TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0
);
