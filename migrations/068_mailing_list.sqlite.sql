-- 068: Mailing list for newsletter signups (footer form).
-- Idempotent: CREATE TABLE IF NOT EXISTS.
-- Uses TEXT id + INTEGER created_at to match db.insert() conventions.
CREATE TABLE IF NOT EXISTS mailing_list (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'footer',
  created_at INTEGER NOT NULL,
  unsubscribed_at INTEGER NULL
);
CREATE INDEX IF NOT EXISTS idx_mailing_list_email ON mailing_list(email);
