-- 102: Tester pool signups for the /testers page.
-- One row per person who joins the standing Useful Appz tester pool.
-- email is stored lowercase and UNIQUE so the pool dedupes itself.
-- interests is a comma-separated list of the kinds they picked
-- (tattoo, coloring, tools) or the single value everything.
-- credit_ok is 1 when they agreed to be named in tester credits.
-- invited_at stays NULL until a real invite goes out to them.
CREATE TABLE IF NOT EXISTS tester_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  interests TEXT NOT NULL DEFAULT 'everything',
  credit_ok BIGINT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'testers-page',
  created_at BIGINT NOT NULL,
  invited_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tester_signups_created ON tester_signups(created_at);
