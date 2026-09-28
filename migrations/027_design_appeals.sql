-- 027: one-appeal-per-rejected-design, decided by the site owner (head_admin).
-- The designer's appeal goes to the owner; the owner's decision is final.
CREATE TABLE IF NOT EXISTS design_appeals (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  decided_by TEXT,
  decided_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_design ON design_appeals(design_id);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON design_appeals(status, created_at);
