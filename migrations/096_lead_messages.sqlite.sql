-- 096: Lead AI lane for the AI Master Button (owner order 2026-10-22).
-- The button's core purpose is talking to the owner's Lead AI (Aria),
-- so the panel gets a first-class Lead destination: the owner posts a
-- message from the button (DEVICE auth, same pairing as the HQ queue),
-- Aria reads the thread through the service pipe and replies, and the
-- button polls the thread and speaks her reply. One row per message —
-- owner rows carry role 'owner', Aria's replies are their own rows with
-- role 'aria' and reply_to pointing at the owner message they answer.
CREATE TABLE IF NOT EXISTS lead_messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_messages_device_created ON lead_messages (device_id, created_at);
