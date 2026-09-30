-- 041: population_admin flag — explicit per-user exemption for the owner's
-- site-population inner circle (additive only).
--
-- Owner rule 2026-09-29 (narrowed): ONLY these six accounts are "super
-- admins with population setup". They are NEVER charged upload review fees
-- (their uploads never count against quota) and NEVER auto-charged monthly
-- subscription/membership fees. They MAY still make voluntary one-time
-- purchases (premade/custom checkout stays open).
--   1. the head_admin (site owner)
--   2. Chris Jones   <christopherstclairjones@yahoo.com>
--   3. Cayli Cradic  <caylicradic@gmail.com>
--   4. Aiden         <darkguitar6769@gmail.com>
--   5. Lesha Hughes  <alieshak85@gmail.com>
--   6. Carina        <c0rruptc0rtexx03@gmail.com>
-- Every other lifetime holder (e.g. Adolfo, Rhonda) follows the normal
-- quota/fee rules.
--
-- To flag/unflag an account later (head admin only), run in the Render shell:
--   node -e "const db=require('./src/db');(async()=>{await require('./src/db/migrate').migrate();await db.query('UPDATE users SET population_admin=1 WHERE LOWER(email)=LOWER(?)',['x@y.com']);console.log('flagged');process.exit(0)})()"
-- (or set population_admin=0 to unflag). No migration needed for toggles.
ALTER TABLE users ADD COLUMN IF NOT EXISTS population_admin BIGINT NOT NULL DEFAULT 0;
-- Seed idempotently: the head_admin row is the owner; the rest by email,
-- case-insensitive (some grants were recorded with mixed case).
UPDATE users SET population_admin = 1 WHERE role = 'head_admin';
UPDATE users SET population_admin = 1 WHERE LOWER(email) IN (
  'christopherstclairjones@yahoo.com',
  'caylicradic@gmail.com',
  'darkguitar6769@gmail.com',
  'alieshak85@gmail.com',
  'c0rruptc0rtexx03@gmail.com'
);
