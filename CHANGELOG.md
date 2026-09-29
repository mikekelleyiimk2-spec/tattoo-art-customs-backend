# Changelog — Tattoo Art Customs (website/backend)

All notable changes to the website and API. Live at
https://tattoo-art-customs.onrender.com.
**Versioning:** the deployed git commit (reported by `/health`) is the
website's version — package.json stays 1.0.0 between releases.

## 2026-09-29

### Added
- Per-task administrator pay out of the website's 10% overhead (owner rule):
  admins earn only by completing paid tasks — no base pay. Rate card, in
  cents: design approve/reject/hold 25; review approve/reject 10; custom
  approve/request-changes/reassign/deliver 100; replacement close 50;
  manual order confirm 50; referral verify 50; appeal decide 200; shop
  verify 100; membership cancel 25; bug triage 25; cashout complete 25;
  payout complete 25; designer restrict/unsuspend/forgive/lift 50;
  colorization attach 50; print fulfill 50; ad activate/deactivate 10.
  Total granted task pay may never exceed 25% of cumulative site overhead
  (`ADMIN_TASK_PAY_OVERHEAD_CAP_PCT`); anything beyond is held and released
  oldest-first as overhead grows (released at the start of each Monday
  payout run). Task pay stacks into the admin's normal payable balance and
  goes out with the weekly payout at the $5 minimum; payout requires an
  admin account with an active designer or tattoo shop subscription plus a
  payout destination (same forfeiture rule as everyone else). Self-pay
  guard: no pay for moderating your own designs. Site overhead ledger rows
  are never debited — task pay is a separate capped obligation.
  Migration 034 (`admin_task_pay`); `/admin/payouts` gains an "Admin task
  earnings" section (earned / stacked payable balance / paid to date +
  rate card).

## 2026-09-28

### Added
- 919-design owner catalog imported to the public gallery at boot
  (watermarked previews baked into the Docker image; seeder runs once when
  the designs table is empty). Originals stay local — never regenerated.
- `POST /api/orders/quick-buy/:designId` — one-tap website checkout for the
  app: creates a pending order, app opens it signed in via `/api/bootstrap`.
- Bug reports: `/report-bug` (emailed to owner) + `/admin/bugs` triage.
- Membership checkout hardening: subscribe idempotency, approve only on
  PayPal ACTIVE, resume-payment link, cancel for pending subs
  (+ regression tests with a test-only PayPal stub).
- 1-hour designer auto-approval (watermark gate kept).
- Message-artist initiation buttons on artist + design pages.
- Admin design delete (moderation) with sales guard.
- Apple Pay via PayPal (domain association file served byte-exact).
- AdSense wired (`ADSENSE_PUBLISHER_ID` env; `/ads.txt` auto-served).

### Changed
- Replacement rule: only custom one-off pieces delist on sale and queue a
  remake request for the original artist; premade keeps selling repeatedly.
- Fee pass-through: web prices carry +3.5% + $0.49; commissions computed
  on the base price (fee excluded).
- Commission splits locked: premade 60% designer / 20% shop / 10% owner /
  10% site (70/20/10 with no referring shop); custom 70% designer
  (80% founding); self-referral loophole closed.
- Adolfo-only +2% dual-subscription loyalty bonus (design_artist +
  tattoo_shop), funded from the owner's share.
- Payout setup is website-only; app Wallet tab points at `/wallet/app`.
- `/membership` and `/orders/custom` require login (anonymous users are
  redirected to `/login?next=…`).
- Cookie banner + mobile nav CSP fixes.

### Fixed
- pg BIGINT timestamps returned as strings (coerced before `new Date()`).
- Render migrations tracker repair (empty tracker + partial DDL now
  idempotent — see AGENTS.md).
- VAPID key persistence on PostgreSQL.
- Order dupes, PayPal founding-plan first-year trial, error leaks.

## Earlier (2026-09-26 → 2026-09-27)

- Initial production deploy on Render (Docker + render.yaml, Blueprint).
- PayPal checkout (manual CashApp/Venmo fallback until verified).
- Weekly Monday commission payouts via PayPal Payouts ($5 minimum).
- Custom-design SLA enforcement (late penalties, buyer site-credit,
  repeat-offender tiers).
- Designer portfolios (`/artist/portfolio`, public `/artists/:id`,
  admin approval gate).
- Dual watermark process; watermarked linework only shown publicly.
- Hire-inquiry auto-reply cron (Gmail + Instagram DMs).
- Saturday-night sale pricing windows; 6h design carousel crons.
