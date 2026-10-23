-- 101: Little Inkers hearts — kid-safe like counts for coloring pages.
-- Fully separate from design_likes (055) and merch_likes (100) so the
-- kids numbers can never mix with tattoo-side numbers.
-- page_key is a surface-prefixed slug and the three LI page namespaces
-- can never collide: app:<slug> for flagship launch pages,
-- bundle:<YYYY-Www>:<slug> for weekly bundle pages and
-- coloring:<slug> for the Coloring app's local catalog.
-- voter_key is an anonymous per-install UUID minted by the app and kept
-- in its local storage. No account and no personal data — a page name
-- and a random number only (owner ruling 2026-10-23).
-- lil_like_counts is a maintained rollup for fast ranking.
CREATE TABLE IF NOT EXISTS lil_likes (
  page_key TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (page_key, voter_key)
);
CREATE INDEX IF NOT EXISTS idx_lil_likes_page ON lil_likes(page_key, created_at);
CREATE TABLE IF NOT EXISTS lil_like_counts (
  page_key TEXT PRIMARY KEY,
  like_count BIGINT NOT NULL DEFAULT 0
);
