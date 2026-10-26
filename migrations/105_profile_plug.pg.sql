-- 105: Tester Hub slice 4 — the Profile Plug machine (owner strike
-- 2026-10-26 07:07: the Rolodex/Profile Plug numbers are SETTLED —
-- app $4.99 one-time, links $0.99 each, ride 15% band 10-20, referrer
-- payout at $5, first link FREE, Hub surface named "Profile Plug").
--
-- Developer profiles: one record per developer, keyed to the Gmail
-- they already use at app intake (POST /api/testers/apps). Holds the
-- display name, their referrer attribution (set once, at the door),
-- and whether their free first link is spent.
CREATE TABLE IF NOT EXISTS tester_hub_developers (
  id TEXT PRIMARY KEY,
  gmail TEXT NOT NULL,
  display_name TEXT NOT NULL,
  blurb TEXT,
  referrer_gmail TEXT,
  first_link_free_used BIGINT NOT NULL DEFAULT 0,
  rolodex_app_owned BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tester_hub_developers_gmail ON tester_hub_developers(gmail);
CREATE INDEX IF NOT EXISTS idx_tester_hub_developers_status ON tester_hub_developers(status);
-- Per-developer Rolodex: a developer's affiliate links in the SAME
-- entry shape as the house Rolodex (see PLUG.md), owned by a profile.
-- The plug contract rules carry over: disclosure is locked to the
-- link (an entry never renders without it) and only entitled, checked,
-- live entries render. kid_safe is 0 by construction for developer
-- entries — kids'-side pulls can never return them.
CREATE TABLE IF NOT EXISTS developer_rolodex_entries (
  id TEXT PRIMARY KEY,
  developer_gmail TEXT NOT NULL,
  name TEXT NOT NULL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  link TEXT,
  code TEXT,
  rate TEXT,
  cookie TEXT,
  payout TEXT,
  disclosure TEXT NOT NULL,
  kid_safe BIGINT NOT NULL DEFAULT 0,
  subid TEXT,
  entitlement TEXT NOT NULL DEFAULT 'none',
  allow_check_ok BIGINT NOT NULL DEFAULT 0,
  allow_check_note TEXT,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dev_rolodex_developer ON developer_rolodex_entries(developer_gmail);
CREATE INDEX IF NOT EXISTS idx_dev_rolodex_status ON developer_rolodex_entries(status);
-- The penny ledger: append-only (corrections are reversing entries,
-- never edits). One flat $0.99 link purchase writes its split rows
-- here (google fee / referrer / prize pot / buyer credit / house) so
-- the math is visible to both sides and sums to the purchase. Buyer
-- credit spends are negative rows of kind 'credit_spend'.
CREATE TABLE IF NOT EXISTS penny_ledger (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  entry_id TEXT,
  purchase_ref TEXT,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_penny_ledger_account ON penny_ledger(account);
CREATE INDEX IF NOT EXISTS idx_penny_ledger_entry ON penny_ledger(entry_id);
