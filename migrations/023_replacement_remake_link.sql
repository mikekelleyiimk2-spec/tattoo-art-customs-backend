-- 023: link a sold custom piece's replacement request to the artist's remake upload.
ALTER TABLE design_replacements ADD COLUMN remake_design_id TEXT;
