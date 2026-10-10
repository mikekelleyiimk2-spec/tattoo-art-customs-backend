-- 083: Job queue for full-auto merch creation from the admin sorter.
-- When an admin ticks "Merch" on a design, a job is queued; the scheduler
-- worker picks it up and runs the full Printful pipeline (print asset,
-- product creation, catalog + i18n, deploy).
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
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
