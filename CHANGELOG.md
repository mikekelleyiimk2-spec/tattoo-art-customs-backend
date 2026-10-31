# Changelog — Tattoo Art Customs (website/backend)

All notable changes to the website and API. Live at
https://tattoo-art-customs.onrender.com.
**Versioning:** the deployed git commit (reported by `/health`) is the
website's version — package.json stays 1.0.0 between releases.

## 2026-10-30

### Changed — site-wide visual audit: the old cream face is retired (owner order, late 2026-10-30)
- The owner caught the new Brambleforce buy pages wearing the legacy TAC template and ordered every page checked: "NOTHING looks like our old flat boring shit ever again." Full audit (76 routes, phone + desktop screenshots): 41 public routes still wore the classic face — cream paper field, 16-link classic header, faded linework wallpaper. Audit + evidence: `~/workspace/your_files/site-visual-audit-2026-10-30.md`.
- Fix = the house's own Oct 27 trickle-down, completed: the `homeFace + darkFace + page-dark` flags applied to every remaining classic render — content pages (by-request, doodle, wishlist, top-loved, watch, worlds, about, show-designs), articles (guides ×5, aftercare, terms, privacy + 25 app policies), forms (contact, report-bug, login/signup/forgot/reset — the login is also the visitor face of every login-walled surface), sales pages (membership shops/healed-wall/plans, contests, advertise, discounts, raffles, gift-card redeem), social pages, the merch catalog/tee order pages (index was dark, the order pages weren't), TAC/iOS sideload landings, Chorvix branch pages (`/onemind/tools`, `/onemind/killintime`), public shop storefronts, and the 404/500 error renders.
- Support in `dark.css`: linework wallpaper at .05 on dark pages, `.muted` stepped up for article readability, and the only three hard-coded light panels in the set (testers gold card, join panel, raffle progress trough) moved to CSS vars that re-point to deep tinted wells on the dark face. No copy, logic, checkout, or money mechanics changed; kid surfaces untouched.
- Kept as-is (own current faces): home, gallery, design, merch index, apps, FillMyList, Little Inkers / Poppy & Ziggy, the Chorvix app shell, Dawnfold's newspaper face, HerbHaul founding, and the redesigned Brambleforce pages (separate lane — audited: they pass the standard).
- Suite: 3,261 tests ok before the harness's own fetch to its spawned server dropped (environment flakiness, seen all evening); exactly the 12 documented pre-existing failures, all stale "OneMind"-wording copy assertions predating the Chorvix rename — none in the changed surfaces, whose HTTP sections (login 59, signup 58, membership 23, merch 33, checkout 33, social 16, sideload 13, gift cards 8) all ran green.

### Added — Brambleforce website sale door (the game's first live door)
- New `src/routes/brambleforce.js` + `src/lib/brambleforce.js`: the completed game sells HERE first (owner orders 2026-10-30 — full price, every in-app purchase available; Google's door joins when Google catches up). Landing at `/brambleforce`; buy pages at `/brambleforce/buy/<product_id>` for the game ($6.99) + all 13 struck IAPs — the exact URLs the sideload build's Supply Store opens. Fleet guest/member PayPal checkout (business PayPal = mk4); the game order carries `sideload:com.usefulappz.game2runandgun` so the gated app-updates route delivers the APK (registered in `src/data/app-updates.json`, gated, vc10/1.0.0 public build — BFTEST-free, sha256 2514b6d1…).
- Unlock codes: a paid IAP order mints ONE single-use code (migration 118, `brambleforce_codes`, SHA-256 hash only at rest), shown once on the success page and emailed. `POST /api/brambleforce/redeem` implements the game's contract — 200 `{product}` / `{error:"spent"}` / `{error:"unknown"}` — with its own scoped CORS (the game page posts cross-origin from a file:// origin) and a per-IP rate limit. Race-safe spent flip via conditional UPDATE.
- The public sideload APK was rebuilt from a patched staging tree (`~/workspace/app/game2-runandgun-public`): BFTEST test-code branch removed and the three baked `usefulappz.com` store constants repointed at this backend (`tattoo-art-customs.onrender.com` — usefulappz.com is a separate static host where /brambleforce/* 404s, and the tattooartcustoms.com DNS does not resolve). The internal BFTEST build is kept under a clearly internal name only.
- Verified: 33 new suite tests (test/brambleforce.js) pass; store proof re-run on the public build 17/17; local payment-TEST-mode end-to-end (stub capture → code issued → redeemed in the public APK's own page → CRT unlock granted/persisted; spent + BFTEST codes refused). The one remaining step to the first real sale is the owner-approved live $0.99 test purchase.

### Fixed — POST forms no longer hang forever on "Working…" when a submission dies mid-flight
- Root cause (owner hit it on the Brambleforce buy button, 2026-10-30 ~21:45 CDT): this service's persistent disk means every Render deploy fully stops the old instance before the new one boots — a minutes-long total outage per deploy (probes caught a 502 window around the 03:05 UTC deploy swap; the owner's two buy taps landed in the 7408a5b deploy window). His POST died with the old instance, and the house layout's submit guard (disable button + "Working…" label, no recovery path) left the page frozen forever — no error, no way to retry.
- `src/views/layout.ejs`: the submit guard gains a stall watchdog — 60s after a submit (beyond the server's worst-case PayPal budget of two 25s-capped calls), if the page is still on the same form, the form is restored (buttons enabled, labels back, submittable again) and a visible `.flash` notice appears ("This is taking too long — it may not have gone through. Please try again." — new `common.stall` string in all 12 locales). A `pageshow` restore also unlocks forms frozen in the back/forward cache. Happy-path submissions unload the page, so the watchdog never fires for them. Covers every POST form in the house layout — all 14 Brambleforce buy pages as currently served, the paid-app doors, checkout, login, newsletter.
- Tests (`test/brambleforce.js` §1b): rendered-page assertions that the house layout carries the watchdog + stall notice, and that the buy page carries a stall-restore watchdog in whichever skin serves it.

### Changed — Everything Bundle: $27.99, and a bundle code grants all 15 extras (owner ruling 2026-10-30)
- `everything_bundle` price $16.99 → $27.99 (the 15 extras total $28.85 bought separately; the bundle sits ~$1 under). The only price site was `src/lib/brambleforce.js`; buy-page and landing copy render from the catalogue, so no other copy carried the old price.
- Grant mapping (redeem-side): new `BUNDLE_GRANTS` in `src/lib/brambleforce.js` — every IAP except the bundle itself, derived from the catalogue so it cannot drift (original 12 + fighter_zola / fighter_otto / fighter_yusuf = 15). `POST /api/brambleforce/redeem` for a bundle code now returns `{product:"everything_bundle", grants:[…15 ids…]}` (additive field; the `{product}` contract is unchanged).
- Tests (`test/brambleforce.js` §9): struck price, grant-set composition, $28.85 extras total, $27.99 on the rendered buy page, and a stub-capture bundle E2E (capture → code → redeem returns the product + full grant set → second redeem spent).
- Sequenced in the same deploy as the "Working…" repair above. Pre-swap correction applied to the (not-yet-live) Brambleforce skin in the working tree: `layout-brambleforce.ejs`'s submit guard now carries the same house semantics — 60s + visible `role="alert"` stall notice (its 25s silent restore would have re-enabled the buy button mid-checkout); it uses the `common.stall` string added with the repair.

### Added — Brambleforce: three new fighters on the website sale door
- Catalogue (`src/lib/brambleforce.js`) gains three $1.99 fighter IAPs, same pattern as the existing entries (kind `iap`, orders carry `brambleforce:<id>`, one unlock code minted at capture): `fighter_zola` — Fighter — Zola "Sickle" Adeyemi (pendulum grapple-swing physics, full voice + kit); `fighter_otto` — Fighter — Otto "Auger" Fenn (committed drill-dash physics); `fighter_yusuf` — Fighter — Yusuf "Trowel" Barakat (planter/setup kit — turrets, decoy, snare). Buy pages live at `/brambleforce/buy/<id>`; existing products, prices, and the Everything Bundle are unchanged. Pages are live but unannounced — nothing links or promotes them beyond the store landing's catalogue list.
- Tests (`test/brambleforce.js`): per-fighter catalogue/order-type checks, buy pages render 200 with name + $1.99, and a stub-capture E2E for fighter_zola (guest checkout → capture mints exactly one code → redeem returns `{product:"fighter_zola"}` → second redeem `spent`). No real money moved.

## 2026-10-09

### Added — automatic ZIP delivery for paid request orders
- New `src/lib/requestZipDelivery.js`: when a custom request order is confirmed PAID (PayPal capture, site-credit, or admin manual confirm), the matching request-only ZIP collection is delivered automatically — download token issued + receipt email with the private link, same bearer-token mechanism as premade purchases.
- Order-type → ZIP mapping (exactly one ZIP each): request-only design orders (`Request-only design "…" (ID: …)`, design verified request-only in DB) → `zips/Tattoo-Art-Customs-Request-Only-Designs-Linework-and-Color-31.zip`; by-request character orders for the 19 video-game franchises → `zips/video-game-characters-request-only.zip`; all other listed by-request characters → `zips/By-Request-Designs.zip`.
- Fail-closed safety: unparseable briefs, unknown design IDs, non-request-only designs, or off-list character names are NEVER delivered — the order lands in `request_zip_review` and the owner gets an email with the order details.
- ZIPs served from the private R2 bucket via 15-minute presigned URL (`r2://tattoo-art-customs-private/zips/…`), falling back to the baked-in `assets/library/` copy; bucket stays private, only the paying buyer gets a link.
- Migration 080 (`request_zip_deliveries` delivery records, `request_zip_review` owner queue); download page shows a single ZIP link for these orders; i18n keys added across all 12 locales.
- Verified with a no-money end-to-end test (27 assertions: mapping, idempotency, fail-closed, token issuance, ZIP bytes served, emails) — all passing; full backend suite (1766 tests) green.

### Added — raffle entrant watcher pipe
- New service-token endpoint `GET /api/muse/raffle-entrants` (read-only): returns recent opening-raffle entrants with warmth signals (entry date, signup date, email_verified, referred_by, order_count, last_order_at). Same Bearer auth as the other Muse pipes; 404s when MUSE_SERVICE_TOKEN is unset. Feeds the daily warm-entrant watcher cron (`raffle-entrant-watch`).
- Test coverage in the backend suite for the new endpoint (401 on missing/wrong token, 200 with valid token, entrant row shape verified).

### Changed — Leda Art Supply affiliate link live
- Swapped both Leda merch entries (`leda-sketchbook-large`,
  `leda-sketchbook-medium`) from placeholder brand-direct URLs to the real
  Lasso affiliate link (https://lasso.to/hARs5ZDmxA/, ~10.5–15.8%, 14-day
  cookie). TAC public /merch; rel="noopener nofollow sponsored" + FTC
  disclosure render from the shared merch view.

## 2026-10-02

### Changed — codebase optimization pass (no behavior changes)
- Removed dead code: old homepage view (`site/index.ejs`, replaced by the
  landing page), old upload form (`artist/upload.ejs`, replaced by
  `artist/portfolio-upload`), and the superseded `fulfillmentProvider` /
  `submitToProvider` stubs in `lib/print.js` (live Printful fulfillment runs
  through `lib/printful.js`).
- Trimmed unused exports: `AUTO_APPROVER`, `ONE_HOUR_MS` (autoApprove),
  `sourceFile` (combine), `sendToBankAccount` (wise),
  `DOWNLOAD_TTL_MS` (fulfillment), `CLEARING_WINDOW_MS` (ownerSweep),
  `isMemberSaleWindow`, `customDepositCents`, `chicagoParts`,
  `FIRST_CUSTOM_DISCOUNT_RATE`, `TEE_PRICE_CENTS` (pricing), `uploadFlash`
  (portfolioUpload). All remain defined/used internally where needed.
- Removed 70+ redundant `metaDescription: ''` render params (the layout
  already omits the tag when no description is set).
- Audit: all 88 internal view links resolve, all 131 POST forms hit real
  routes, all 490 i18n keys used in views exist — no broken links found.

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
