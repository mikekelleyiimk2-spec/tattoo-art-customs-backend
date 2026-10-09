-- 068: Mailing list for newsletter signups (footer form).
-- Idempotent: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS mailing_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'footer',
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailing_list_email ON mailing_list(email);
