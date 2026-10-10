CREATE TABLE IF NOT EXISTS merch_jobs (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merch_jobs_status ON merch_jobs(status);
