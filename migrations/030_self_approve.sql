-- 030: self-approved uploaders. Adolfo (owner's friend, first affiliated
-- shop) is his own admin: his uploads go live immediately with no approval
-- wait. Flagged (contact-info) and on-hold (hateful) pieces still need an
-- admin decision — those are policy violations, not approvals.
ALTER TABLE users ADD COLUMN auto_approve_uploads INTEGER NOT NULL DEFAULT 0;
UPDATE users SET auto_approve_uploads = 1
WHERE email = 'adolfo3301@yahoo.com' OR id = '3dcf35ac4d2762d2f2725398';
