-- 109: AI-to-AI Messenger, slice 1 — Registry + 1:1 (spec
-- ~/workspace/your_files/ai-to-ai-messenger-spec-2026-10-25.md §8
-- Slice 1; owner demand 2026-10-26 "I still have not seen this
-- muse to muse thing APK... my friend wants to talk to my AI").
-- The Messenger is a MODE of OneMind (Addendum 2 — never a second
-- app) riding the existing ai-commands pipeline: a send is an
-- ai_commands row (lane 'api') whose messenger_pairing_id points
-- at the pairing here; the worker's messenger routing rule
-- (src/worker/apiLane.js, spec §4 item 4) settles it against the
-- RECIPIENT's seat — one named target, NO failover, an honest
-- failure block when the seat cannot answer. Never delivered limbo.
--
-- THE AI CODE is the primary connect path (owner framing
-- 2026-10-26: "AI codes — communication between devices"): every
-- listing carries a short shareable code; another device enters
-- the code and the pairing request fires. Handle/Directory lookup
-- is the secondary path. Consent is per-owner and timestamped on
-- every row; either owner can end a pairing at any time.
--
-- Owner identity note (spec §4 gap, flagged not papered over): the
-- shipped estate identity the OneMind app holds is the registered
-- device (ai_devices, migration 095) — site accounts are
-- web-session only and have no app token — so listings bind to
-- owner_device_id. owner_user_id exists for the day the unified
-- sign-in (overhaul) links a site account to a device.
ALTER TABLE ai_commands ADD COLUMN messenger_pairing_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_commands_messenger ON ai_commands (messenger_pairing_id);
CREATE TABLE IF NOT EXISTS ai_listings (
  id TEXT PRIMARY KEY,
  owner_device_id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT,
  handle TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  ai_name TEXT NOT NULL,
  owner_display_name TEXT,
  about TEXT,
  findability TEXT NOT NULL DEFAULT 'unlisted',
  connect_policy TEXT NOT NULL DEFAULT 'approval',
  open_1to1 INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ai_listings_findability ON ai_listings (findability);
-- A pairing request is the consent handshake. Approval creates the
-- pairing; an 'open' connect policy on the target listing approves
-- instantly (still recorded here, still revocable — spec §2.1).
CREATE TABLE IF NOT EXISTS ai_pairing_requests (
  id TEXT PRIMARY KEY,
  from_listing_id TEXT NOT NULL,
  to_listing_id TEXT NOT NULL,
  seat_from TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ai_pairing_requests_to ON ai_pairing_requests (to_listing_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_pairing_requests_from ON ai_pairing_requests (from_listing_id, status);
-- Seats are FIXED at pairing (slice 1 — swaps are slice 2, spec
-- §2.2). status: active | paused | closed. Closed is terminal; the
-- record stays readable to both owners (spec §2.1).
CREATE TABLE IF NOT EXISTS ai_pairings (
  id TEXT PRIMARY KEY,
  listing_a_id TEXT NOT NULL,
  listing_b_id TEXT NOT NULL,
  seat_a TEXT NOT NULL,
  seat_b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  consent_a_at BIGINT,
  consent_b_at BIGINT,
  created_at BIGINT NOT NULL,
  closed_at BIGINT,
  closed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_pairings_a ON ai_pairings (listing_a_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_pairings_b ON ai_pairings (listing_b_id, status);
-- The shared record. One row per send: the sender's verbatim words
-- live here; the run's status + verbatim answer live on the linked
-- ai_commands row (claim → run → post), read together. A send
-- refused because the pairing is paused/closed is RECORDED here
-- with status 'refused' and no command — refused is a state in the
-- record, never a silent drop (spec §2 law + slice-1 acceptance).
CREATE TABLE IF NOT EXISTS messenger_messages (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL,
  command_id TEXT UNIQUE,
  from_listing_id TEXT NOT NULL,
  to_listing_id TEXT NOT NULL,
  seat_member TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  refusal_reason TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messenger_messages_pairing ON messenger_messages (pairing_id, created_at);
