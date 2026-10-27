-- 114: CannaDash founding-list (waitlist) signups from the standalone
-- host's /cannadash door (owner order 2026-10-27). Intake ONLY:
-- CannaDash is not live in any market yet — no ordering, no payments,
-- nothing promised beyond a launch notice. Three roles, one row per
-- (role, email): order = customer/patient, drive = driver,
-- partner = licensed dispensary/retailer. email stored lowercase.
-- area = the city/ZIP the person asked about or wants to join from,
-- detail = role-specific basics (vehicle / business name / notes).
CREATE TABLE IF NOT EXISTS cannadash_waitlist (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  area TEXT,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'cannadash-door',
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cannadash_waitlist_role_email ON cannadash_waitlist (role, email);
CREATE INDEX IF NOT EXISTS idx_cannadash_waitlist_created ON cannadash_waitlist(created_at);
