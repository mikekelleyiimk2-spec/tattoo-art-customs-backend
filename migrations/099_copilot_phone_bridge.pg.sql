-- 099: Copilot phone-lane bridge (owner order 2026-10-22).
-- Copilot has no API, so when an API-lane command needs it, the
-- worker spawns a linked device-lane CHILD command that the phone
-- executes through the Copilot app surface it already runs, and
-- the child's posted result is linked back into the parent record.
-- ai_commands gains parent_id (NULL on ordinary commands, the API
-- parent's id on a delegated child). ai_runs gains lane so every
-- hop records which lane executed it (api or device).
ALTER TABLE ai_commands ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_commands_parent ON ai_commands (parent_id);
ALTER TABLE ai_runs ADD COLUMN lane TEXT;
