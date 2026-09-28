-- The app inserts rows with generated ids everywhere; give the join
-- table an id column too for uniformity.
ALTER TABLE conversation_participants ADD COLUMN id TEXT;
