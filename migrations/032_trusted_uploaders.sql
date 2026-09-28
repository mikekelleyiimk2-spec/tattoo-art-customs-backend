-- 032: trusted self-approved uploaders. Chris Jones and Cayli Cradic join
-- Adolfo: every upload they make (including designs produced for them by the
-- assistant) goes live immediately, approved by themselves — no review queue,
-- no holds. Screening flags are still logged to the review queue for audit.
UPDATE users SET auto_approve_uploads = 1
WHERE email IN ('christopherstclairjones@yahoo.com', 'caylicradic@gmail.com');
