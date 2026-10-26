-- 111: Seat claims — the device-email link (owner correction
-- 2026-10-26: "Why can't no sign in get linked — it reads the email
-- of the device and send sign in / sign up / register / verify
-- emails"). A surface with no signed-in user starts a claim for the
-- email the person picked on their device (the pick is the consent,
-- never a silent harvest). The backend stores ONE pending claim per
-- email per surface and emails a single-use verify link. The tap IS
-- the sitting: the claim activates the seat (registering a new
-- account or passwordlessly signing in the existing one — same
-- email, same account, everything already held under it) and the
-- tie is written by src/lib/onemind.js. Only token/secret HASHES
-- are stored. claim_source records honestly how the seat was
-- claimed ('device-email'). Kids surfaces can never appear here:
-- startClaim validates against the surface registry first.
CREATE TABLE IF NOT EXISTS seat_claims (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  surface TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  claim_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_source TEXT NOT NULL DEFAULT 'device-email',
  user_id TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  verified_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_claims_token ON seat_claims (token_hash);
CREATE INDEX IF NOT EXISTS idx_seat_claims_email_surface ON seat_claims (email, surface, status);
