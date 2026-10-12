-- 086: lil_bundles.active must be INTEGER, per the codebase-wide convention
-- (src/db/index.js: "INTEGER 0/1 for booleans"). Migration 060 created it as
-- BOOLEAN, which makes `WHERE active = 1` fail on Postgres with
-- "operator does not exist: boolean = integer" and 500s the public
-- GET /api/little-inkers/bundles manifest the kids app fetches on launch.
-- NOTE: must DROP DEFAULT before the type change — Postgres cannot auto-cast
-- a boolean DEFAULT to integer (error 42804, broke Render deploys 2026-10-12).
ALTER TABLE lil_bundles ALTER COLUMN active DROP DEFAULT;
ALTER TABLE lil_bundles ALTER COLUMN active TYPE INTEGER USING (active::int);
ALTER TABLE lil_bundles ALTER COLUMN active SET DEFAULT 1;
