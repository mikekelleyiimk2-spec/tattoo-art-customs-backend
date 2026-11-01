-- 120: Cayli's Opinion on Everything (gag app, owner order 2026-10-31).
-- Questions asked in the app are stored here first, then emailed to
-- Cayli through the site mailer. A question is NEVER reported as sent
-- until the mailer actually accepts it: rows sit at status 'queued'
-- while SMTP is unconfigured and flush when the transport is ready.
-- Answers are filed back (by the inbox watch, through the key-gated
-- ingest endpoint) so the app can show them and notify the asker.
CREATE TABLE IF NOT EXISTS cayli_opinion_questions (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  asker_name TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  mail_error TEXT,
  created_at BIGINT NOT NULL,
  sent_at BIGINT
);
CREATE TABLE IF NOT EXISTS cayli_opinion_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT,
  answer TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cayli_opinion_q_status ON cayli_opinion_questions (status);
CREATE INDEX IF NOT EXISTS idx_cayli_opinion_a_question ON cayli_opinion_answers (question_id);
