-- 025: audit trail for design/review approvals (supports the 1-hour
-- auto-approval rule: approved_by = 'auto:1h-no-admin-action' when the
-- system approves a design no admin personally reviewed within an hour).
ALTER TABLE designs ADD COLUMN approved_by TEXT;
ALTER TABLE review_queue ADD COLUMN decided_by TEXT;
