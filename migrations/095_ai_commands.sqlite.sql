-- 095: HQ command queue for the AI Master Button (owner Door 0,
-- 2026-10-21). Aria enqueues a command through the /api/muse pipe, the
-- owner's AI Master Button polls for its device's queued commands,
-- executes on-device, and posts the result back. ai_devices holds the
-- pairing registry: a device is registered by service call with its
-- pairing code, and the first device poll binds the hash of its key.
CREATE TABLE IF NOT EXISTS ai_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  answer TEXT,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ai_commands_device_status ON ai_commands (device_id, status);
CREATE TABLE IF NOT EXISTS ai_devices (
  device_id TEXT PRIMARY KEY,
  pairing_code TEXT NOT NULL UNIQUE,
  key_hash TEXT,
  created_at BIGINT NOT NULL,
  registered_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ai_devices_pairing ON ai_devices (pairing_code);
