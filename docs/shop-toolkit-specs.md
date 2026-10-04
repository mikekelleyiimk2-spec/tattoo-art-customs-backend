# Shop Toolkit Expansion — Feature Specs (owner-approved 2026-09-30)

Nine features, priority order. Status: **sandboxed to v1.1** (owner decision 2026-09-30) — specs only, no
public copy may promise these as live. Partial implementation exists on branch
`v1.1-shop-toolkit` (modules, migration, hooks); nothing here has shipped to
`main`/production. Website+app parity: every website page below renders
inside the app's existing Shop WebView tab (`/shop` via `/api/bootstrap`
token bootstrap), so app parity is automatic; customer-facing pages
(waiver signing, aftercare check-in, autofill claim) are mobile-first EJS and
work in the app's browser/WebView equally.

Global constraints: **no SMS ever** (cost) — push via `pushToUser` + in-app
`notifyUser` + `sendMail` only. No paid services. No spending money.

---

## 1. Cancellation auto-fill (SPEC — v1.1 build)

**What:** When a confirmed booking is cancelled, the freed slot is broadcast to
the shop's waitlist (and optionally past clients) first-claim-wins, instead of
the existing one-at-a-time 24h waitlist offer. Fastest finger wins; the slot
never sits empty.

**Data model** (`slot_offers`):
- id, shop_user_id, staff_id NULL, start_at, end_at BIGINT, source_booking_id
- status: `open` → `claimed` | `expired`
- claim_token (unguessable, in the claim link), winner_customer_id NULL
- created_at, expires_at (2h default, shop-configurable)

**Endpoints** (`src/shop/routes-toolkit.js`, mounted `/toolkit`):
- `POST /bookings/:id/cancel` (existing, in `routes-bookings.js`) now calls
  `maybeAutofill({booking})` from `src/shop/autofill.js` after a confirmed
  booking cancels. Shop setting `autofill_enabled` (default 1) + audience
  (`waitlist` | `waitlist+past`) controls it.
- `GET /toolkit/autofill/claim/:token` — customer claim page (shows slot time,
  shop name; requires login; one-tap claim button).
- `POST /toolkit/autofill/claim/:token` — race-safe conditional flip
  `open`→`claimed` (exactly one winner); winner is routed into the booking
  flow with the slot pre-filled; losers see "already claimed".
- `GET /toolkit/autofill` (shop) — open/past offers.

**Logic:** on cancel, create one `slot_offers` row, then `notifyUser` +
`pushToUser` + email to every `waitlist` entry in `waiting` status for that
shop/staff (plus past completed-booking customers if audience includes them).
Dedup by customer. A 15-min sweeper expires stale offers. If nobody claims,
the slot simply returns to the public pool (nothing else needed — open slots
are computed, not stored).

**UI:** shop dashboard card "Auto-fill" with toggle + audience select; claim
page is a single big button, mobile-first.

## 2. Digital waivers + ID capture (SPEC — v1.1 build)

**What:** Shops write their own consent/waiver text; clients sign on their
phone before the appointment; optional ID photo capture stored encrypted with
an auto-delete retention policy.

**Data model:**
- `shop_waivers`: id, shop_user_id, title, legal_text (shop-supplied), active,
  created_at. Shops may have several (e.g. standard, minor-with-guardian).
- `waiver_signatures`: id, waiver_id, booking_id, customer_user_id,
  signer_name, signature_svg (drawn signature, stored as SVG text), signed_at.
- `waiver_id_docs`: id, signature_id, enc_blob (AES-256-GCM ciphertext, base64),
  iv, created_at, delete_after BIGINT. Plaintext ID bytes NEVER touch disk/DB.

**Crypto:** `src/shop/waivers.js` — AES-256-GCM, key from `ID_DOC_KEY` env
(64 hex chars). Fail closed: if the key is missing, ID capture endpoints
return 503 "ID capture is not configured" (waiver signing still works).
Retention: `shop_booking_settings.id_retention_days` (default 730, min 30,
max 2555); a daily sweeper hard-deletes `waiver_id_docs` past `delete_after`.

**Endpoints** (`/toolkit`):
- `GET/POST /toolkit/waivers` (shop) — list, create/edit/deactivate templates.
- `GET /toolkit/waivers/sign/:bookingId` (customer) — renders the shop's active
  waiver text + signature pad + optional ID photo upload.
- `POST /toolkit/waivers/sign/:bookingId` — stores signature (+ encrypted ID).
- `GET /toolkit/waivers/s/:id` (shop) — view a signed waiver (decrypts ID in
  memory only, never logs it).

**UI/legal:** the template editor page carries the standing disclaimer copy:
"Tattoo Art Customs provides this tool only and is not your lawyer. Have a
licensed attorney in your state review your waiver text before you use it."
Customer signing page shows the same short disclaimer above the signature pad.
Booking confirmation nudges the customer to sign waivers in advance
(`booking-confirmation` body extended).

## 3. Aftercare autopilot (SPEC — v1.1 build)

**What:** Branded aftercare guide + timed healing check-ins (day 3 / 7 / 14
after a completed booking) with a one-tap "send a healed photo" request.
Feeds the healed wall and powers the review machine.

**Data model:**
- `shop_aftercare_templates`: id, shop_user_id, title, body_md, active,
  created_at. `{{shop_name}}` placeholder supported.
- `aftercare_checkins`: id, booking_id, shop_user_id, customer_user_id,
  kind (`day3`|`day7`|`day14`), due_at BIGINT, status
  (`pending`→`sent`→`responded`), response (`great`|`ok`|`concern`) NULL,
  healed_photo_requested 0/1, review_requested_at NULL, created_at.
- `healed_photos`: id, checkin_id, shop_user_id, customer_user_id,
  image_path, consent_to_post 0/1, posted_to_wall 0/1, created_at.

**Flow:** `completeBooking` (existing) calls `scheduleAftercare(bookingId)` —
creates the 3 check-in rows. An hourly sweeper (`runAftercareSweep`,
registered in `src/lib/scheduler.js`) sends due check-ins via `notifyUser` +
`pushToUser` + email, each with a one-tap response link
(`GET /toolkit/aftercare/r/:token?r=great|ok|concern`) and a photo-upload link
(`GET /toolkit/aftercare/photo/:token`). Uploads reuse the intake photo
pipeline; `consent_to_post` gates healed-wall posting. Dedup via the
`notifications` table (kind `aftercare-day3/7/14`), same pattern as
`bookingReminders.js`. A `concern` response immediately notifies the SHOP
(`notifyUser` kind `aftercare-concern`) so they can reach out.

**UI:** shop page `/toolkit/aftercare` — template editor + check-in log with
response badges; customer pages are single-tap, mobile-first.

## 4. Review machine (SPEC — v1.1 build)

**What:** After a customer taps "healing great" on a check-in, and only then,
the shop's Google review link is sent. Asks at the moment of delight, never
after a concern.

**Data model:** `shop_review_settings` (shop_user_id PK, google_review_url,
enabled default 1). `aftercare_checkins.review_requested_at` records the ask.

**Flow:** in the check-in response handler, when `response='great'` and shop
has `google_review_url` + enabled and `review_requested_at IS NULL`: set the
timestamp, send `notifyUser` + push + email (kind `review-ask`) with the
Google URL. Never fires on `ok`/`concern`/no-response. One ask per booking
ever (a second great on day 14 does not re-ask).

**UI:** URL + toggle on `/toolkit/aftercare`; dashboard card shows
"reviews requested" count (from `notifications` kind `review-ask`).

## 5. Slow-day blast (SPEC — v1.1 build)

**What:** One-tap push/email blast to past clients: "2 chairs open Friday —
book now". Fills dead days without discounting.

**Data model:** `shop_blasts`: id, shop_user_id, message (≤280 chars),
audience (`past_clients`), recipient_count, status (`sent`), sent_at,
created_at.

**Flow:** `POST /toolkit/blasts` (shop) — recipients = distinct customers with
a `completed` booking at this shop in the last 365 days. Sends `notifyUser` +
`pushToUser` + email per recipient (batched, best-effort). Guardrails: max 2
blasts per rolling 7 days per shop; empty recipient list → friendly error, no
send. Each blast logged with recipient_count for the dashboard.

**UI:** `/toolkit/blasts` — textarea with live char count, audience note,
history table. Dashboard card links it.

## 6. Client reactivation (SPEC — v1.1 build)

**What:** Automatic lapsed-client nudges with a booking link. Past clients are
the cheapest bookings to win back.

**Flow:** daily sweeper (`runReactivationSweep`, in scheduler): for each shop
with `shop_booking_settings.reactivation_enabled` (default 1): find customers
whose last `completed` booking was `reactivation_lapse_days` (default 180)
ago, with no booking (any status except cancelled/expired) since, and no
`reactivation-nudge` notification in the last 90 days. Send `notifyUser` +
push + email (kind `reactivation-nudge`) with the shop's booking page link.
Dedup is the notifications table — no new tables.

**Data model:** two columns on `shop_booking_settings`:
`reactivation_enabled INTEGER DEFAULT 1`, `reactivation_lapse_days INTEGER
DEFAULT 180`. Edited on the existing booking settings page.

**UI:** settings toggle + days input on `/bookings/settings`; dashboard card
shows nudges sent (30d).

## 7. Booking attribution (SPEC — v1.1 build)

**What:** The shop dashboard proves Tattoo Art Customs earns its keep:
"X bookings came from the marketplace", with deposit revenue attached.

**Data model:** `bookings.attribution_source TEXT` — `'direct'` default,
`'tac_marketplace'` when the booking originates from the marketplace design
flow ("Get this tattooed" on a design page → `/bookings/start?design_id=…&ref=tac`).
`routes-bookings.js` start flow accepts `ref=tac` and stamps it through
`createPendingBooking`.

**UI:** new dashboard card "Marketplace attribution": bookings count + gross
deposit revenue from `tac_marketplace` (30d and all-time), pulled by a helper
`getAttributionStats(shopUserId)` in the extended `src/shop/attribution.js`.
This is the renewal argument for the $103.98/yr subscription.

## 8. No-show enforcement (SPEC DONE — build gated on live PayPal)

**What:** Card-held deposits + policy-based auto-charge. Customer's card is
authorized (held) at booking; the shop's cancellation policy executes itself:
cancel inside window → hold released; cancel outside window / no-show →
deposit auto-forfeited to the shop.

**Data model** (tables ship now; money movement waits for PayPal):
- `deposit_holds`: id, booking_id, customer_user_id, shop_user_id,
  amount_cents, status (`pending`→`authorized`→`captured`|`released`|`forfeited`),
  paypal_order_id NULL, paypal_authorization_id NULL, decided_at NULL,
  created_at. Unique per booking (one active hold).
- Policy inputs already exist: `shop_booking_settings.noshow_forfeit_deposit`,
  `cancel_window_hours`, `deposit_amount_cents`.

**Policy engine (BUILT, no PayPal needed):** `src/shop/noshow.js`
`evaluateForfeit(booking, settings)` → `{ outcome: 'release'|'forfeit',
reason }` pure function, fully unit-tested. `POST /bookings/:id/no-show` and
the cancel path call `recordHoldDecision()` which stamps the decision on the
hold row and — if PayPal live — would capture/release; until then the hold
stays `authorized` with `decision='forfeit_pending_paypal'` and the shop sees
"PayPal connection needed to auto-collect" in the UI. A `runForfeitureSweep`
(cron, hourly) picks up decided-but-unexecuted holds; with no live PayPal it
logs and re-queues — never attempts a charge.

**UI (BUILT):** `/toolkit/noshow` — policy summary, holds table with status
badges, pending-forfeiture callouts. Copy never promises auto-collection
until PayPal is live.

**BLOCKED ON:** PayPal live Client ID/secret + Payouts approval (separate
owner track). When live: wire `paypal.js` authorize/capture into
`executeHoldDecision()` — the seam is isolated to one function.

## 9. Payment plans (SPEC DONE — build gated on live PayPal)

**What:** Big work split across sessions: customer books a sleeve, pays per
visit automatically. Bigger tickets close when the number isn't scary.

**Data model** (tables ship now; charging waits for PayPal):
- `payment_plans`: id, shop_user_id, customer_user_id, booking_id NULL,
  title, total_cents, sessions_count, status
  (`draft`→`active`→`completed`|`defaulted`|`cancelled`), created_at.
- `plan_installments`: id, plan_id, seq, amount_cents, due_at BIGINT
  (per-session date), status (`pending`→`paid`|`failed`|`waived`),
  paypal_capture_id NULL, charged_at NULL.

**Flow (BUILT, no PayPal needed):** shop creates a plan from a booking
(`POST /toolkit/plans`), picks sessions count (2–12); installments split
evenly (remainder pennies on the last). `runPlanChargeSweep` (cron, hourly)
finds due installments and — without live PayPal — marks them
`due_awaiting_paypal`, notifies the shop ("collect manually or connect
PayPal"), never attempts a charge. `executeInstallmentCharge()` is the single
seam for live PayPal later (authorize at plan start, capture per session —
vault/subscription per PayPal's terms; spec notes the compliance choice is
the owner's call with PayPal).

**UI (BUILT):** `/toolkit/plans` — plan list, create form, installment table
with status badges, customer view of their plan. Copy: "automatic charging
activates when the shop connects PayPal".

---

## Cross-cutting

- **Migrations:** `045_shop_toolkit_expansion.pg.sql` +
  `045_shop_toolkit_expansion.sqlite.sql` (new tables/columns only; additive).
- **Scheduler:** `registerToolkitJobs()` in `src/shop/toolkitJobs.js`, called
  from `src/lib/scheduler.js`: aftercare sweep (hourly), waiver ID purge
  (daily), reactivation sweep (daily), forfeiture sweep (hourly, no-op without
  PayPal), plan-charge sweep (hourly, no-op without PayPal).
- **Tests:** `test/shoptools-phase7.js` (db + http), wired into `test/run.js`.
- **App parity:** all shop pages render in the existing Shop WebView tab;
  customer pages (claim, waiver sign, check-in response, photo upload) are
  mobile-first and linkable from push/email deep links.
- **Docs:** `SETUP.md` gains `ID_DOC_KEY` setup notes (v1.1).

> v1.1 build plan (order, dependencies, PayPal-blocked items, and the
> platform-wide liability policy): see [v1.1-plan.md](./v1.1-plan.md).
