-- 028: track last 2h-SLA escalation so admins are re-notified at most once a day.
ALTER TABLE designs ADD COLUMN sla_escalated_at BIGINT;
