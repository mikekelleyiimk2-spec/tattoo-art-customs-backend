# The OneMind Sign-In Contract

*RENAME NOTE (Oct 28 2026): the platform brand is now **Chorvix** (owner
strike, coined-word clearance round). This contract's law is unchanged —
every "OneMind" below reads as Chorvix; internal working names (files,
routes, `onemind_id`, env) keep the onemind names by standing law.*

*The plug contract for identity across everything Useful Appz makes.
Foundation: migrations 110–111 + `src/lib/onemind.js` +
`src/lib/surfaces.js` + `src/lib/seatClaims.js` +
`src/routes/onemind.js` (backend repo). Owner law, restated and
extended 2026-10-26.*

## 1. The law

> "Logging into anything we own is your login to OneMind because
> everything's going to it. So if I bought a port or a single bar or
> any other single thing that we have that requires sign in to my
> Gmail login anything like that — which should be pretty much all
> of them, by the way, anything that ain't on the kids surface —
> that's the OneMind sign up/login. You're tied to the table the
> moment you sit down anywhere. Anything I have ties you to it. This
> is how Jeff Bezos does it — it's the original sign in."

Consequences, all binding on every surface:

1. **One account.** There is exactly one account store — the
   backend's `users` table — and every account in it is a OneMind
   account, identified across all surfaces by `users.onemind_id`.
   A surface never creates, mirrors, or syncs its own account
   store. **No app rolls its own sign-in. Ever.**
2. **Tied at the sitting.** The moment an account signs in on a
   tieable surface, a tie is written: account × surface ×
   first-seated timestamp × last-seen (`account_ties`). The tie
   attaches at the sitting — there is no untied interval, and **no
   sign-in never means no link** (§7: the device-email link seats
   people who have never typed a password anywhere).
3. **Kids' surfaces never tie.** Kids' Corner, Little Inkers, the
   Poppy & Ziggy surfaces, and Color With Us are excluded
   absolutely — see §5 (enforced by construction) and §8.3 (the
   one pop never enters the kid play space; the parent is the
   seat).
4. **Counterparties are seats too — ain't no tours of the
   factory** (owner, 2026-10-26: *"Your ad company logged, your
   affiliate group logged — in the door, anyone. Ain't no tours
   of my factory."*). Business counterparties — advertisers and
   ad companies, affiliate partners and groups, developers,
   testers, vendors — are people at the table like anyone else:
   any human or org who comes in any door gets the same OneMind
   seat. There is **no observer, guest, or tour class of access
   to anything internal** — visibility itself is a seat with a
   role, named in the book. And **one person, one seat, roles
   stack**: a person who is customer + affiliate partner + tester
   holds ONE OneMind identity; roles attach to the seat (the
   account's role, plus the role stamped on each tie at the
   sitting — migration 112), never a separate account per role.
5. **Everyone logs, or no entry** (owner absolute, 2026-10-26:
   *"Any section, parents, customers, anyone — I don't care if
   it's Bezos, Zuckerberg, the damn Andy and the penguin walking
   in together — everyone logs or no entry."*). Every section or
   surface that admits a person — member areas, buying/checkout,
   the parent gate, app seats, any account-touching section —
   requires the OneMind log. **No guest lanes, no alternate
   account systems, no VIP/god-mode bypasses, for anyone, ever.**
   The same one pop / one log applies to a parent, a customer, or
   a tech CEO — the door is one tap by design (§7, §8), so the
   wall can be total. Account-gated sections that already require
   the website account satisfy this rule, because those accounts
   ARE OneMind accounts (§3): the mapping is — *site account =
   OneMind account; a section gated on the site account is gated
   on OneMind.* Sections found admitting a person without the
   canonical account are named in §10, never left silent.
   **Settled commerce exception (owner ruling 2026-10-26 19:21,
   refined 19:23 — this paragraph is part of the rule, not a
   loophole in it):** the two guest checkout lanes named in §10
   stay open. A guest may *buy* without the log; no-entry governs
   member areas, the parent gate, seats, and everything internal.
   The exception is temporary by construction — **the bridge**:
   a completed guest DESIGN purchase fires the §7 claim for the
   delivery email immediately (the verify tap seats the buyer and
   attaches the order to the seat); a completed guest PAID-APP
   (sideload) purchase does NOT claim on buy — while the app is
   sideload-only its buyers stay guests like everyone else, the
   purchase records a pending tie, and the ties fire (one claim
   email per buyer) when that app goes live on the store. Either
   way, commerce keeps its door and nobody stays a guest forever
   by accident.
6. **Door #1 is the structure everyone already has: Google**
   (owner anchor, 2026-10-26: *"see them Gmail over there — the
   ones everyone has... that established structure on here... use
   that."*). The OneMind sign-in's primary door is **Sign in with
   Google** — the Gmail/Google identity people already carry. We
   never make anyone invent a new identity to sit at the table:
   a verified Google sign-in resolves **by email** to the one
   seat (§4, door #1) — an existing account is the same seat with
   its password untouched (one identity, two keys, never a
   duplicate seat), and a new email is seated in the same tap.
   Where no Google door exists on a surface, the device-email
   link (§7) is the same thread: both mint/resolve the one seat
   by email. Email + password remains a working key for every
   account that has one — carry-over stands, nobody is forced
   onto any single door.

## 2. What OneMind is (read this before building anything)

**The backend service is OneMind** — the hub where all the plugs
run together. The OneMind *app* is one client, one window into it.

> "Even if you never own the OneMind app, it's still the one in
> charge here because that's our browser. That's all our AIs tied
> together. That's where all the plugs run together at."

A customer who never installs the OneMind app is still under
OneMind: their account is a OneMind account and their tie is in
OneMind's book, because they signed in on *some* surface.
**No surface may depend on the OneMind app being installed for the
tie to attach.** The app is never a gate, a prerequisite, or a
fallback for identity.

## 3. The identity

- `users.id` — the account's primary key (unchanged; every existing
  surface already keys on it).
- `users.onemind_id` — the canonical seat id (`om_` + 24 hex),
  minted once per account and stable forever.
- Resolution rule: **one email = one account = one seat.** The
  doors are email + password (§4), the device-email link (§7), and
  — where a surface offers Google/Gmail sign-in — resolution by
  verified email to the same `users` row. Same seat, same ties,
  never a second account.

### 3.1 The existing accounts are the population (migration)

The migration population is the **existing Tattoo Art Customs
website accounts**. Their logins and passwords **carry over
as-is**: the OneMind identity wraps the existing account and its
existing credential store — **no re-registration, no forced
reset, no password ever changes hands.** At boot the backend:

- mints a `onemind_id` for every account that lacks one, and
- seats every existing account on the `website` surface with
  **first_seated_at = the account's own `created_at`** — their
  first sitting on the website was joining it; the book records
  the true date, not the migration moment. (`signin_count` starts
  at 0 for migrated ties: it counts foundation-era seatings, and
  the first real sign-in bumps it through the normal tie write,
  first-seated unmoved.)

Both passes are idempotent and reversible-safe: they write only an
id column value and tie rows; credentials and account data are
never mutated. The boot log line (`onemind: existing accounts
migrated — N id(s) minted, M website tie(s) seated…`) is the
migration report for the existing population.

## 4. The doors (what an integrating surface calls)

All doors resolve to the same account record.

### Door #1 — Sign in with Google (the established structure)

The primary door rides the identity everyone already has
(§1.6). On the website: `GET /auth/google` sends the person to
Google's own consent screen; `GET /auth/google/callback` takes
the verified profile back. The resolve is **by email**
(`src/lib/googleSeat.js`):

- Google email matches an existing account → **the same seat**.
  The account's password is untouched; Google is a second key to
  the one identity, never a duplicate seat.
- No account under that email → the seat is created in the same
  tap (role `customer`, email verified by Google; passwordless —
  an unusable random hash until the person sets a password via
  `/forgot`). The website tie is written at the sitting, exactly
  like every other door.
- An email Google has **not** verified is refused outright.

The door is config-gated and honest: it exists only when
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set (the owner's
one-time OAuth client in Google Cloud Console, redirect URI
`{BASE_URL}/auth/google/callback`). Unset → no button renders on
the login/sign-up pages and both routes answer 404. A dead or
fake Google door is never shipped. Surfaces that gain a native
Google door later follow the same rule: verify with Google,
resolve by email to the one seat.

### App door — `POST /api/onemind/signin`

JSON body: `{ "email": "...", "password": "...", "surface": "<surface id>" }`

- The surface is validated against the registry (§5) **before**
  credentials are checked. An unregistered or kids' surface gets
  `400 { ok:false, error:"surface_not_tieable" }` and seats
  nothing.
- Bad credentials: `401 { ok:false, error:"invalid credentials" }`.
- Success: `200` with the seat payload:

```json
{
  "ok": true,
  "user_id": "...", "onemind_id": "om_...",
  "email": "...", "display_name": "...", "role": "customer",
  "api_token": "...",            // the account credential for later seat reads
  "seat_surface": "killintime-console",
  "tie": { "surface": "killintime-console", "first_seated_at": 1793059200000,
           "last_seen_at": 1793059200000, "signin_count": 1 },
  "recognized": true,
  "first_seated_at": 1792800000000,   // earliest seating on ANY surface
  "tie_count": 2,
  "surfaces": ["website", "killintime-console"],
  "ties": [ { "surface": "...", "surface_name": "...",
              "first_seated_at": 0, "last_seen_at": 0, "signin_count": 1 } ]
}
```

On success the tie for `(account, surface)` is already written —
first-seated set once; on later seatings only `last_seen_at` and
`signin_count` move. The app stores `api_token` (the account's
existing token) for the seat reads below. This is the *only*
credential an app needs; it is the account's, not the app's.

### Seat read — `GET /api/onemind/seat`

Header `x-api-token: <api_token>` → `200` with the seat payload
(same shape as above, minus `api_token`/`tie`). `401` when the
token is missing or unknown. This is the recognition read (§6).

### Later seating — `POST /api/onemind/tie`

Header `x-api-token: <api_token>`, JSON body `{ "surface": "<surface id>" }`.
For an app that already holds the account's token (a relaunch, a
returning session): records the seating and returns
`{ ok:true, tie, ...seat payload }`. Same surface rules.

### Book view — `GET /api/onemind/ties`

Operator-only (`Authorization: Bearer <MUSE_SERVICE_TOKEN>`,
timing-safe; 404 when the token is unset, 401 on a bad token).
Aggregate ties per surface + the tieable-surface list. No
per-person data ever leaves through this door. This is the tie
registry's read window into the Codex/API family — a tie that
isn't in the book isn't real.

Every tie carries the **role at the sitting** (migration 112):
the seat payload's `role` is the account's role, and each tie in
`ties[]` is stamped with the role held when that seating
happened — the book shows where a seat sat, and as what (§1.4).

### Web doors (already live, same account)

- `/signup` and `/login` (web session) seat the `website` tie.
- `/api/bootstrap` (an app WebView holding the account token)
  seats the `website` tie — it *is* a website sign-in.
- `/api/link-account` (the legacy app link) verifies the same
  credentials against the same record and returns the same
  `api_token`; new integrations use `/api/onemind/signin`, which
  additionally writes the caller's own surface tie.

## 5. The surface registry (kids' exclusion by construction)

Tieable surfaces are an explicit allowlist **in code**:
`src/lib/surfaces.js`. The list, in order:

| # | Surface id | Surface |
|---|---|---|
| 1 | `website` | The website — **logged surface #1 of OneMind** |
| 2 | `onemind-app` | The OneMind app |
| 3 | `ai2ai-app` | The AI to AI app |
| 4 | `tac-app` | Tattoo Art Customs app |
| 5 | `tester-hub` | Tester Hub |
| 6 | `killintime-console` | KillinTime Console |
| 7 | `folder-app` | UsefulAppz Folder |

**The website is a first-class logged surface, not an implicit
default** (owner addition, 2026-10-26: "From here on the website
also logs OneMind"). Every website sign-in is logged *as* a
OneMind sign-in in the tie registry, permanently, and the website
stands in the Codex among OneMind's logged surfaces.

Kids' surfaces — Kids' Corner, Little Inkers (site + app), the
Poppy & Ziggy game/show surfaces, Color With Us — **are not in
the registry at all.** There is no flag to flip, no config row, no
request parameter that can seat a tie from them: `recordTie`
refuses any string that is not in the list, kids' names included.
Adding a surface is a code change to `src/lib/surfaces.js`,
reviewed like a schema change. A client-supplied surface string
is *looked up*, never trusted.

## 6. Recognition (named requirement)

> "If you've ever had anything we make and later decide to get
> OneMind, it already recognizes you." — owner, 2026-10-26

When a person with an existing OneMind identity — minted on
**any** surface, including the migration of the existing site
accounts (§3.1) — first opens OneMind (or any surface), the
surface must greet a **known seat**: their account, their
first-seated date, their surfaces/ties — rendered from the seat
payload (`recognized`, `first_seated_at`, `surfaces`, `tie_count`,
`ties`). **Never a fresh sign-up wall for a known account.
Recognition is the default; introduction is the failure mode.**

App-side rendering of this greeting rides the next OneMind build;
the backend exposes everything it needs today via
`POST /api/onemind/signin` and `GET /api/onemind/seat`.

## 7. The device-email link (no sign-in never means no link)

Owner correction, 2026-10-26: *"Why can't no sign in get linked —
it reads the email of the device and send sign in / sign up /
register / verify emails."* The anonymous seam is dead. A person
who has never signed in anywhere is still linkable, through the
email already on their device:

1. **The offer.** The surface offers the device's email (Android
   account picker / Credential Manager hint) — **one tap, zero
   typing**. The address is never silently harvested: **the pick
   is the consent.** If the person picks nothing, nothing is sent
   and nothing is recorded.
2. **Start — `POST /api/onemind/link/start`** with
   `{ "email": "<picked email>", "surface": "<surface id>" }`.
   The surface is validated against the registry first (kids'
   surfaces are refused, like every door). The backend records a
   **pending seat claim** (`seat_claims`; one pending claim per
   email per surface — starting a new one expires the old) and
   sends **one** verify email through the house mail lane. The
   response is `{ ok:true, claim_id, claim_secret, expires_at }`:
   it never reveals whether the email already holds an account,
   and the verify token travels **by email only** — never through
   the API response.
3. **The tap IS the sitting — `GET /api/onemind/link/verify?token=…`**
   (single-use, 1-hour expiry; `?format=json` for programmatic
   taps). On the tap, the seat activates:
   - an existing account under that email is **signed in
     passwordlessly** — everything the person already holds under
     that email is already keyed to that account and links to the
     seat by being the same account;
   - a new email **registers** a real account on the spot
     (mailbox proven by the tap, so the email is verified; the
     account's password is an unguessable random hash until the
     person sets one through the forgot-password door — the email
     link remains their passwordless way in);
   - the **tie is written** for the claim's surface, and the claim
     row records `claim_source: "device-email"`, the seated
     account, and the verify time — honestly, in the book.
   
   One mechanism serves sign-in, sign-up, register, and verify:
   for an account-holder the same email is a passwordless sign-in;
   for a newcomer it is registration. There is no separate flow.
4. **The device receives the seat — `POST /api/onemind/link/status`**
   with `{ "claim_id": "...", "claim_secret": "..." }`. The claim
   secret was handed only to the initiating device at start and
   never leaves it; the token never leaves the mailbox. Polling
   returns `pending`, `expired`, or — once tapped — `verified`
   with the full seat payload + `api_token`, so the app that
   started the link lands the person already seated.

Kids' surfaces are excluded entirely (§5): no device-email
linking is ever started from a kids' surface. (The grown-ups gate
on a kids' product is a different, adult surface moment — §8.3.)

## 8. Surface behavior (required)

### 8.1 One pop

> "It pops notification 1 time — OneMind sign up — boom done."
> — owner, 2026-10-26

Every tieable surface shows the OneMind sign-up pop **exactly
once per person per surface**. The tap runs the device-email flow
(§7): pick email → verify email → seat. **"Boom done" = no forms,
no passwords.** One time means one time: the surface never
re-pops and never nags.

Client state, persisted on the device per surface, exactly four
values:

```
onemind_pop_state: "never" | "popped" | "dismissed" | "registered"
```

- The pop is shown only from `never`, and showing it sets
  `popped` immediately (a crash can never cause a second pop).
- Dismissing sets `dismissed` — permanent silence on that surface.
- A completed link (or any successful OneMind sign-in on that
  surface) sets `registered`.
- No surface may reset another surface's state; each surface owns
  exactly one pop.

### 8.2 Every door

TAC, the bars, the ports, the tools — **the same pop, the same
registration.** Everyone who comes in any door gets the offer
exactly once. A surface that ships without its pop is not
integrated, whatever else it does.

### 8.3 Kids' surfaces: the pop is for mom or dad

The pop **never addresses the child and never appears in the kid
play space.** On a kids' product it lives **behind the grown-ups
gate** (the Poppy & Ziggy game already has one) and addresses
**mom or dad**: the parent registers, **the parent is the tied
seat**, and the family tie is the parent's seat. The child's
surface itself carries no registration, no tie, and no data
collection on the child — the §5 registry exclusion is untouched:
the seating, when a parent completes it, is recorded against the
gated adult moment, never against the kid play space.

## 9. Integration checklist (per app, on its normal update train)

1. Carry the one pop (§8) with its persisted client state.
2. The pop's tap — and any sign-in screen — runs the contract
   doors: **Sign in with Google first where the surface offers it
   (door #1, §4 — the established structure)**, the device-email
   link (§7) as the same thread where no Google door exists,
   `POST /api/onemind/signin` (§4) where a password form is
   offered. No local account store, no local password handling
   beyond passing credentials to the door.
3. Store the returned `api_token` as the account credential.
4. On later launches with a held token, `POST /api/onemind/tie`
   (or just read `GET /api/onemind/seat`) so last-seen stays true.
5. Render recognition (§6) from the seat payload wherever the
   account is shown.
6. Kids' apps integrate none of the sign-in doors. Their only
   OneMind surface behavior is §8.3, behind the grown-ups gate.

## 10. Honest status

Foundation (this contract's backend) is **live**: canonical id on
every account, the existing population migrated with credentials
untouched (§3.1), the tie registry with the website as logged
surface #1, the registry-refusing doors, the seat summary, the
device-email link (claims + verify + status), and the site copy
stating the account is the OneMind account. **Sign in with Google
(door #1) is built** — consent redirect, callback, resolve-by-email
to the same seat, honest 404 + no rendered button while
unconfigured — **and waits on exactly one owner step**: create
the OAuth client (Web application) in Google Cloud Console →
APIs & Services → Credentials with authorized redirect URI
`https://tattoo-art-customs.onrender.com/auth/google/callback`,
then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the
Render service. The moment those land, the door opens on the
login and sign-up pages with no further code. **Not yet true:** the
apps have not integrated — per-app sign-in screens and one-pop
behavior ride their update trains (§9), and the OneMind app's
first-open recognition greeting rides the next OneMind build.
Until an app integrates, its users' ties are written when they
sign in on the web doors or complete a device-email link — the
seat is the same when the app catches up.

**Guest lanes — SETTLED (owner ruling 2026-10-26 19:21,
refined 19:23; no longer an open question).** The no-entry audit
found the two guest checkout lanes (live money doors built
deliberately on 2026-10-15). The owner ruled: **"Keep them
bridged — guest buys, the claim ties their seat after"** — the
lanes stay, no-entry governs member areas and seats, and the
bridge (§1.5) is automatic. The lanes differ:

1. **Guest design checkout — bridges on buy.** `src/routes/orders.js`
   (`POST /orders/buy`) + `src/lib/guestCheckout.js`: a logged-out
   visitor buys a design with only a delivery email; the order
   carries `guest_email` and no buyer account, and the download
   travels by emailed token. The moment the purchase completes,
   `bridgeGuestPurchase` fires a §7 claim for the delivery email
   (`claim_source` 'guest-purchase', `seatClaims
   .startPurchaseClaim`): exactly one verify email — "your
   purchase is tied to your OneMind seat; one tap finishes it" —
   deduped against any pending or recent claim for that email, so
   repeat buys never re-mail inside the window. The tap signs the
   buyer in (or creates the account — an existing account under
   that email is the same seat, never a duplicate) **and attaches
   the order**: every paid guest order under that email gains the
   account reference (`orders.buyer_id`), and the seat summary
   reflects the purchases.
2. **Guest paid-app checkout — bridges at store go-live.**
   `src/routes/buyApp.js` (`/buy-app/:slug`), `src/routes
   /sideload.js` (`/tac-android-pro`), and `src/routes/iosApp.js`
   (`/ios-app`), all on `src/lib/guestCheckout.js`: a logged-out
   visitor buys a sideload app with only a delivery email, same
   guest-order shape. **No claim fires on buy.** While the app is
   sideload-only its buyers stay guests like everyone else; the
   completed purchase records a **pending tie** instead
   (`guest_pending_ties`, migration 113: buyer email x app x
   order; `lib/pendingTies`). When the app goes live on the Play
   store, the pending ties for that app fire — one claim email
   per buyer (the same guest-purchase claim as the design lane;
   its tap seats the buyer and attaches the purchases). **The
   go-live trigger needs no new code:** `POST
   /api/onemind/pending-ties/fire` with the Muse service token
   and `{ "app_key": "..." }` flips the app live
   (`app_store_live`) and drains its queue; `GET
   /api/onemind/pending-ties` shows the book (counts + live
   flags). After the flip, new guest buys of that app bridge on
   buy exactly like designs. `app_key` is the checkout flow's app
   identifier: the buy-app package name (e.g.
   `com.usefulappz.odometer`), `tac_android_pro`, or `ios_app`.
3. **Observed, lesser: tester pool signup** — `src/routes/site.js`
   (`POST /testers`): an email-only roster signup
   (`tester_signups`). It grants no member area, purchase, or
   account access, but a person enters the pool under an email
   alone. Unchanged by the ruling: it holds no door, and when a
   person on the roster takes a seat, the §7 claim under the same
   email is the bridge.

**Partner-login audit (2026-10-26, §1.4): clean, with rosters
named.** Every password check in the codebase runs against the
one `users` table — shop dashboards, designer/artist portals,
and admin are role-gated views of the same OneMind account; no
separate partner credential exists anywhere to close. What does
exist is email-keyed rosters with no login and no internal
access — the Tester Hub developer roster (`tester_hub_developers`,
keyed by Gmail), the tester pool (`tester_signups`), the mailing
list, waitlist, and event/app-launch signups. They hold no door;
when a person on one of them takes a seat, the §7 claim under the
same email is the bridge. Machine lanes are not people lanes:
`MUSE_SERVICE_TOKEN` (operator automation) and the muse device
pairings (`ai_devices` / `ai_pairings`) authenticate machines
and devices, never a person, and grant no person a seat or a
view.
