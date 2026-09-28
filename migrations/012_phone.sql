-- Complimentary phone contact for users (used for comp accounts like Adolfo).
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
