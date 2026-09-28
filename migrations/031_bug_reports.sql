-- 031: tester bug reports. Testers submit through /report-bug; each report
-- is emailed to the owner (config.adminEmail) the moment it lands.
CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  reporter_email TEXT,
  page_url TEXT,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
