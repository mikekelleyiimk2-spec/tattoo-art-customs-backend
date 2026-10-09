# src/shop — Shop toolkit module

All shop-exclusive code for Tattoo Art Customs lives here. This module powers
the marketplace's shop features today (shop profiles, dashboard, referral
program, booking toolset, gift cards, intake forms, waitlist) and is kept as
a clean, self-contained unit so it can later be extracted and sold as a
standalone product.

Move-only refactor (2026-09-30): files were relocated here with zero behavior
changes — same function names, same signatures, same routes.

## What the module owns

| File | Responsibility |
|---|---|
| `routes.js` | Shop area (`/shop`): dashboard, profile (location/hours/appointment-requirements only), referral link + stats, commission dashboard, payout email setup |
| `routes-bookings.js` | Booking toolset routes (`/bookings`): shop appointment scheduling, deposits/balances, receipts, "Get this tattooed", booking settings |
| `routes-giftcards.js` | Gift card routes (`/giftcards`) |
| `routes-intake.js` | Intake form routes (`/intake`): customer fill-in + shop view |
| `routes-waitlist.js` | Waitlist routes (`/waitlist`): join, claim, shop management |
| `routes-clients.js` | Client CRM routes (`/shop/clients`): client profiles, tattoo history (phase 8) |
| `routes-reviews.js` | Review request routes (`/shop/reviews`): settings + manual send (phase 8) |
| `routes-artists.js` | Artist commission tracker (`/shop/artists`): artists, splits, earnings log (phase 8) |
| `routes-inventory.js` | Inventory alerts (`/shop/inventory`): stock items, low-stock flags (phase 8) |
| `routes-expenses.js` | Expense tracker (`/shop/expenses`): monthly + category totals (phase 8) |
| `routes-storefront.js` | Public shop storefront (`/store/:shopId`): shop's own designs for sale (phase 8) |
| `clients.js` | Client profiles: CRUD + per-client tattoo history |
| `reviewRequests.js` | Review request auto-send sweep + manual send; unified sent-log with the aftercare review machine (phase 8) |
| `artistCommissions.js` | Shop-internal artist registry + earnings log with frozen splits (phase 8) |
| `inventory.js` | Supply items, qty adjust, low-stock detection (phase 8) |
| `expenses.js` | Expense log, monthly/category totals (phase 8) |
| `storefront.js` | Storefront settings + the shop's approved designs with referral code (phase 8) |
| `touchups.js` | Touch-up bookings: linked follow-ups for completed tattoos, free or reduced deposit (phase 8) |
| `sharekit.js` | Portfolio share kit: image + caption + share deep links per completed booking (phase 8) |
| `shopDesigner.js` | Shop-included designer membership: an active `tattoo_shop` subscription carries full designer access (portfolio, commissions, request-artist dropdown). Also the Adolfo-only dual-subscription loyalty bonus gate |
| `shopIncentives.js` | Referral volume tiers (20% → 22% at 25+/mo → 25% at 50+/mo, Chicago calendar month) and booking-conversion bonuses ($5 flat on premades, 5% of base on customs) |
| `attribution.js` | `resolveShopReferral(code)`: referral code → shop user id, recorded on orders as `referred_shop_id` |
| `routes-clients.js` | Client profiles CRM routes (`/shop/clients`): list, create, detail/edit, tattoo history |
| `routes-reviews.js` | Review request automation routes (`/shop/reviews`): settings (shared with the aftercare review machine), manual send, sent log |
| `clients.js` | Client profiles CRM: per-shop client records + tattoo history, all shop-scoped |
| `reviewRequests.js` | Review request automation: manual trigger + auto-send sweep, settings delegated to `aftercare.js`; never double-asks across the aftercare 'great' ask |
| `verification.js` | `verifyShop(shopUserId)`: mark a shop profile verified (called from the admin members page) |
| `bookingFlow.js` | Booking state machine (standard + deposit-first flows), PayPal deposit/balance capture, confirm/complete/cancel/no-show |
| `bookingSlots.js` | Open-slot computation for shop calendars |
| `bookingFees.js` | Booking fee math: shop nets base, platform nets 5%, customer pays grossed-up; receipt lines |
| `bookingReminders.js` | Scheduled booking reminders (registered via `registerBookingReminderJobs()`) |
| `giftcards.js` | Gift card lifecycle (pending → active → redeemed/expired), fee model mirroring bookings |
| `intake.js` | Intake form storage (one per booking, up to 5 reference photos) |
| `waitlist.js` | Waitlist queue: join, offer on freed slots (24h claim window), auto-advance |

## Entry points (how the marketplace uses this module)

- **Route mounts** (`src/index.js`): `/shop` → `shop/routes.js`, `/bookings` → `shop/routes-bookings.js`, `/giftcards` → `shop/routes-giftcards.js`, `/intake` → `shop/routes-intake.js`, `/waitlist` → `shop/routes-waitlist.js`
- COORDINATOR MOUNTING PENDING: `/shop/clients` → `shop/routes-clients.js`, `/shop/reviews` → `shop/routes-reviews.js`
- **`designerAccess` / `requireDesignerAccess` / `dualSubBonusActive`** (`shopDesigner.js`) — used by `src/routes/account.js`, `src/routes/artist.js`
- **`shopVolumeTierRate`** (`shopIncentives.js`) — used by `src/lib/commissions.js` at commission time
- **`maybeAwardBookingBonus`** (`shopIncentives.js`) — used by `shop/bookingFlow.js` on booking confirmation
- **`resolveShopReferral`** (`attribution.js`) — used by `src/routes/orders.js` when recording orders
- **`verifyShop`** (`verification.js`) — used by `src/routes/admin.js` (`POST /admin/members/:id/verify-shop`)
- **`registerBookingReminderJobs`** (`bookingReminders.js`) — used by `src/lib/scheduler.js`
- **`registerReviewRequestJobs`** (`reviewRequests.js`) — COORDINATOR WIRING PENDING: call once from `src/lib/scheduler.js` startScheduler() to run the 6-hour review auto-send sweep (conservative: bookings completed 24h–7d ago, shop enabled + URL set, active shop subscription)

## Shared modules this depends on (stays outside)

`../db`, `../config`, `../middleware/auth`, `../middleware/rateLimit`,
`../lib/commissions` (commission engine, `payableBalance`, `recipientEligible`),
`../lib/payoutRoutes` (generic payout dashboard shared with artist/customer),
`../lib/profiles` (generic `upsertProfile`), `../lib/screening` (contact-info
screener), `../lib/pricing` (money formatting), `../lib/paypal` (marketplace
PayPal client), `../lib/notify` + `../lib/mail` (marketplace notifications).

Deliberately NOT moved (generic or excluded by scope): `referrals.js`
(refer-a-friend membership rewards — not shop attribution), `commissions.js`,
`planRoles.js` (shared checkout/Play role grants), `payoutRoutes.js`,
`cashout.js`, `admin.js` (admin review queue), `memberships.js`.

## Integration points that stayed in marketplace code

- `POST /admin/members/:id/verify-shop` route shell lives in `src/routes/admin.js` and delegates to `shop/verification.js`; the $1 `shop_verify` admin task pay is booked there via the generic Tier-2 `payAdmin`.
- `referred_shop_id` is *consumed* by `commissions.js` and `shopIncentives.js`; the recording call site is `src/routes/orders.js` via `shop/attribution.js`.
- Shop subscription role grants (incl. founding-shop claims and `shop_profiles` creation) live in `src/lib/planRoles.js` — shared with the artist checkout and Play verification flows.
- Migrations touching shop tables stay in `src/db/migrations/` — migrations are never moved.

## Extraction notes (what would need work to sell this standalone)

These are marketplace-specific imports *into* shop modules; a standalone
product would need to replace or interface them. Not refactored — listed only.

1. **`../db`** — direct SQL against the marketplace schema (`shop_profiles`, `orders`, `bookings`, `commission_ledger`, …). Standalone needs a defined storage interface.
2. **`../lib/commissions`** — tier rates are applied inside the marketplace commission engine; `payableBalance`/`recipientEligible` encode marketplace payout rules (incl. the forfeiture rule).
3. **`../lib/payoutRoutes`** — payout dashboard is generic across customer/artist/shop; shop would need its own payout UI.
4. **`../lib/paypal`** — bookings/gift cards use the marketplace PayPal client (credentials, fee pass-through config).
5. **`../middleware/auth`** — `requireSubscription('tattoo_shop')` and `hasActiveSubscription` assume the marketplace plan/subscription model.
6. **`../lib/notify` / `../lib/mail`** — marketplace notification infra (on-site messages + SMTP).
7. **Views** — `res.render('shop/…')`, `res.render('bookings/…')` etc. still resolve from the shared `src/views/` tree; templates were not moved.
8. **`shopDesigner.js` dual-sub bonus** — hardcodes one marketplace user id (owner rule); meaningless outside this marketplace.
9. **Config coupling** — `config.referralTiers`, `config.bookingBonus`, `config.baseUrl` live in the marketplace config.
