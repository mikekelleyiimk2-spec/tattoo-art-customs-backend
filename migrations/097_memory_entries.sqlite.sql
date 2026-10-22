-- 097: AI Memory Store (owner order 2026-10-22). AIs retain nothing
-- between calls, so memory lives OUTSIDE the AI: this table is the
-- durable store that gets retrieved and injected into every call.
-- One row per version of an entry — a correction inserts version+1
-- with supersedes_id pointing at the prior current row, so history
-- is never overwritten or deleted. An entry is CURRENT when no other
-- row supersedes it. scope is 'owner', 'global', or an AI name; kind
-- is 'order', 'fact', 'preference', or 'event'.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id TEXT,
  source TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_key_version ON memory_entries (scope, key, version);
CREATE INDEX IF NOT EXISTS idx_memory_entries_supersedes ON memory_entries (supersedes_id);
