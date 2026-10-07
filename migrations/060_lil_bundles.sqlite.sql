-- Little Inkers weekly coloring-page bundles (2026-10-07).
-- A weekly cron publishes new bundles here; the app fetches the manifest
-- at GET /api/little-inkers/bundles and downloads new bundle files.
CREATE TABLE IF NOT EXISTS lil_bundles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  theme TEXT NOT NULL,
  design_count INTEGER NOT NULL DEFAULT 0,
  published_at BIGINT NOT NULL,
  file_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lil_bundles_published ON lil_bundles(published_at DESC);
