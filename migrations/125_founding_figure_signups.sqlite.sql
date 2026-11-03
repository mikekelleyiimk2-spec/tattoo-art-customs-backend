-- 125: Founding Figure interest list (additive only).
--
-- The /brambleforce/founding-figure page collects emails to notify if and
-- when the first Brambleforce figure (Tor) opens. Interest only: no figure
-- is in production, there is no price and no pre-order — the list is the
-- demand evidence the figure program runs on.
CREATE TABLE IF NOT EXISTS founding_figure_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  UNIQUE(email)
);
CREATE INDEX IF NOT EXISTS idx_founding_figure_signups_created ON founding_figure_signups(created_at);
