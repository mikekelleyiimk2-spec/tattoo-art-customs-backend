-- 117: The Big One "Your Local" insert — one saved locality per user
-- (owner order 2026-10-28). The reader's own town for the publication's
-- local page: weather and briefs for where they actually are. Written
-- only when the reader picks a town (typed search pick or a
-- tap-initiated device location) — never collected silently, never
-- from an IP guess. Guests keep their pick on-device (localStorage) —
-- this table is the signed-in copy that follows them to every device.
-- One row per user (user_id UNIQUE) — re-picking a town updates the row.
CREATE TABLE IF NOT EXISTS user_localities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  name TEXT,
  region TEXT,
  country TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_localities_user ON user_localities (user_id);
