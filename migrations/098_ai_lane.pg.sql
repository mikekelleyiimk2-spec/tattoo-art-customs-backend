-- 098: AI Master Button API lane, slice 1 (owner approval 2026-10-22).
-- ai_commands gains the lane routing and claim bookkeeping the backend
-- worker needs. origin says who sent the command (hq or device), lane
-- says who executes it (api means the backend worker over the members'
-- official APIs, device means the phone app as today). Existing rows
-- default to lane device so the on-device behavior is untouched.
-- claimed_by and claimed_at record the worker claim, and attempts
-- counts executions so the watchdog can fail a command honestly after
-- 3 tries instead of leaving it in limbo forever.
-- ai_runs is the run ledger: one row per command execution plus one
-- child row per member hop (member set on hop rows, NULL on the root),
-- carrying measured token usage and estimated cost in micro-USD, so
-- "who answered and what did it cost" is a query, not a guess.
ALTER TABLE ai_commands ADD COLUMN origin TEXT NOT NULL DEFAULT 'hq';
ALTER TABLE ai_commands ADD COLUMN lane TEXT NOT NULL DEFAULT 'device';
ALTER TABLE ai_commands ADD COLUMN claimed_by TEXT;
ALTER TABLE ai_commands ADD COLUMN claimed_at BIGINT;
ALTER TABLE ai_commands ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ai_commands_lane_status ON ai_commands (lane, status, created_at);
CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  member TEXT,
  model TEXT,
  status TEXT NOT NULL,
  error TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_microusd INTEGER,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_command ON ai_runs (command_id, started_at);
