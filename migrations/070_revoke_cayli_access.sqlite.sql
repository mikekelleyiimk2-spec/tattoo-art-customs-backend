-- 070: Revoke Cayli Cradic's admin access and subscriptions (owner direct order 2026-10-09)
-- Demote to customer, clear population_admin flag, cancel all subscriptions
-- Emails: caylicradic@gmail.com, caylilynn@hotmail.com
-- Idempotent: safe to re-run (UPDATEs are conditional on current state)
UPDATE users SET role = 'customer', population_admin = 0 WHERE LOWER(email) IN ('caylicradic@gmail.com', 'caylilynn@hotmail.com') AND (role != 'customer' OR population_admin != 0);
UPDATE subscriptions SET status = 'canceled', canceled_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) IN ('caylicradic@gmail.com', 'caylilynn@hotmail.com')) AND status != 'canceled';
