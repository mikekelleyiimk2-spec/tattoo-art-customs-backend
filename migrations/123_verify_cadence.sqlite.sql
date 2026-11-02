-- 123: Verification CADENCE (owner directive 2026-11-01 20:34 CST:
-- "long as file verification runs as often as needed to catch store
-- thieves immediately"). The Chorvix layer (122) verifies at sign-in
-- and at redeem; this migration arms the RECONCILIATION SWEEP
-- (lib/entitlementSweep.js) that re-checks every granted entitlement
-- against its source of truth on a recurring cadence, so a refund,
-- chargeback, or revoked purchase PULLS the entitlement and the pull
-- lands in the watch — nothing lives on a source that died.
--
-- seat_entitlements.revoke_reason — why a binding was pulled
--   ('source_refunded' | 'source_gone' | 'source_revoked' | ...),
--   recorded next to revoked_at by the sweep.
-- play_purchases.recheck_at — the sweep's round-robin cursor: the
--   last time this verified row was re-proven against Google. Rows
--   are re-verified oldest-check-first, a bounded batch per run, so
--   every verified purchase is re-proven on a steady cadence
--   without ever bursting the Play API.
ALTER TABLE seat_entitlements ADD COLUMN revoke_reason TEXT;
ALTER TABLE play_purchases ADD COLUMN recheck_at BIGINT;
