-- 007: subscriber design combiner — saved combinations of owned (paid) premade designs.
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  design_ids TEXT NOT NULL DEFAULT '[]',
  layout TEXT NOT NULL DEFAULT 'row',
  style TEXT NOT NULL DEFAULT 'color',
  background TEXT NOT NULL DEFAULT 'white',
  output_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_combos_user ON combos(user_id, created_at);
