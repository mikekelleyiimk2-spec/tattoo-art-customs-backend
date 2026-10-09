-- 079: By-request designer enticement systems (owner directive 2026-10-09)
-- Character claims (first come, first served), by-request design tagging,
-- leaderboard + spotlight support.
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
CREATE TABLE IF NOT EXISTS by_request_claims (
  id TEXT PRIMARY KEY,
  character_slug TEXT NOT NULL,
  character_name TEXT NOT NULL DEFAULT '',
  designer_id TEXT NOT NULL,
  claimed_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  completed_design_id TEXT,
  released_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_brc_slug ON by_request_claims(character_slug);
CREATE INDEX IF NOT EXISTS idx_brc_designer ON by_request_claims(designer_id);
CREATE INDEX IF NOT EXISTS idx_brc_status ON by_request_claims(status);
ALTER TABLE designs ADD COLUMN IF NOT EXISTS by_request_character TEXT;
CREATE INDEX IF NOT EXISTS idx_designs_byrequest ON designs(by_request_character);
