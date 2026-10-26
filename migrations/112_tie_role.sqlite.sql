-- 112: ties record the ROLE at the sitting (owner widening
-- 2026-10-26: business counterparties are seats too — advertisers,
-- affiliate partners, developers, testers, vendors — and one
-- person holds ONE seat with roles stacking on it: customer +
-- affiliate partner + tester is one identity, never one account
-- per role). account_ties.role stamps the account's role at each
-- seating, so the book shows not just where a seat sat but AS
-- WHAT. The account's current primary role stays on users.role —
-- roles attach to the seat, never to a separate account.
ALTER TABLE account_ties ADD COLUMN role TEXT;
