-- 050: user profile pictures.
-- avatar_url holds the public /img/avatars/<file> path (local disk) or a full
-- https URL (R2 mode). NULL means "no picture yet" and the header falls back
-- to the initial-circle chip.
ALTER TABLE users ADD COLUMN avatar_url TEXT;
