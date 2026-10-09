-- 068: Mailing list for newsletter signups (footer form).
-- Idempotent: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS mailing_list (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'footer',
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_mailing_list_email ON mailing_list(email);
