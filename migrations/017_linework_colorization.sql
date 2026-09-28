-- Linework-only uploads, site colorization workflow, and daily owner sweep
-- (2026-09-28).
--
-- designs.color_source:
--   'designer' = the upload included a full-color version (default; all
--     pre-existing designs get this).
--   'site'     = the designer uploaded linework only and approved the
--     site-created color version.
--   'none'     = linework only; no color version exists.
-- designs.status gains two workflow states (both hidden from every public
-- listing until resolved):
--   'awaiting_color'           = linework-only upload waiting on the
--     site-created color version.
--   'pending_designer_approval' = color version attached; designer must
--     approve (or request changes) in /artist/portfolio.
-- designs.colorization_note: the designer's change-request note, visible in
-- the admin colorization queue.
-- commission_ledger.commission_type: 'split' (normal split row) or
--   'colorization_fee' (the 5-point website fee on sales where the designer
--   did not provide color).
-- commission_ledger.cleared_at: set by the daily owner sweep when the sale
-- passes the 24h clearing window.
-- orders.linework_only: buyer chose (or was auto-given) the linework-only
-- purchase at the 3% discount.
-- orders.on_hold: admin flag that keeps an order OUT of the daily owner
-- sweep (disputes / manual review).
ALTER TABLE designs ADD COLUMN color_source TEXT NOT NULL DEFAULT 'designer';
ALTER TABLE designs ADD COLUMN colorization_note TEXT NOT NULL DEFAULT '';
ALTER TABLE commission_ledger ADD COLUMN commission_type TEXT NOT NULL DEFAULT 'split';
ALTER TABLE commission_ledger ADD COLUMN cleared_at INTEGER;
ALTER TABLE orders ADD COLUMN linework_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_designs_color_status
  ON designs(color_source, status);
CREATE INDEX IF NOT EXISTS idx_ledger_cleared
  ON commission_ledger(recipient_type, cleared_at);
