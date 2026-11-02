-- 124: The THIEF TRAP (owner design, 2026-11-01 20:40 CST: when a
-- theft hack is caught, no ban — the game turns on them: "rubber
-- bullet 0.100th strength and constant frenzy — stole my shit, my
-- game becomes impossible to beat. Files reverted to normal and
-- checks against verification — hacker thief trap lifts and resume
-- play. I don't need to lifetime ban anyone.")
--
-- seat_traps — ONE row per seat that has ever been trapped.
-- lifted_at NULL = the trap is ON right now; the client reads the
-- state on the responses it already consumes (session open,
-- POST /api/onemind/verify, redeem) and applies the effects itself
-- (rubber bullets x0.1, constant enemy frenzy — impossible to
-- beat, not impossible to play). lifted_at set = the seat
-- reconciled clean and the trap lifted automatically. There is NO
-- permanent-ban state anywhere in this design, by the owner's word.
--
-- Set ONLY by behavior — theft-class events the verification layer
-- catches at the attempt: a replayed unlock code presented by the
-- seat, repeated forged entitlement claims / forged codes, an
-- entitlement found held with no living source of truth (the
-- reconciliation sweep's pull). NEVER set by client configuration:
-- a root declaration is recorded, never judged (standing doctrine).
CREATE TABLE IF NOT EXISTS seat_traps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  trigger_kind TEXT,
  detail TEXT,
  set_at BIGINT NOT NULL,
  lifted_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seat_traps_active ON seat_traps (lifted_at);
