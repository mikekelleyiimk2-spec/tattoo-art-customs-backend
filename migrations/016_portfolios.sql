-- Designer portfolios + per-upload listing/watermark options (2026-09-28).
-- listing_scope: 'gallery' = listed on the main design gallery (existing rows
--   and designer pre-design opt-ins); 'portfolio' = visible only on the
--   artist's own portfolio page.
-- listing_type: 'predesign' = sells at the premade price; 'custom' = sells at
--   the current custom-design price (sale-aware at purchase time).
-- style: single style fixed at upload (never drifts if site categories change).
-- watermark_choice: 'site' = site standard pipeline; 'custom' = artist's own
--   uploaded watermark image (custom_watermark_path). Solid-black anti-trace
--   marks are applied in BOTH cases by the pipeline.
ALTER TABLE designs ADD COLUMN listing_scope TEXT NOT NULL DEFAULT 'gallery';
ALTER TABLE designs ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'predesign';
ALTER TABLE designs ADD COLUMN style TEXT NOT NULL DEFAULT '';
ALTER TABLE designs ADD COLUMN watermark_choice TEXT NOT NULL DEFAULT 'site';
ALTER TABLE designs ADD COLUMN custom_watermark_path TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_designs_scope_status
  ON designs(listing_scope, status);
CREATE INDEX IF NOT EXISTS idx_designs_artist
  ON designs(artist_id, status);
