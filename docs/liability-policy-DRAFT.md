# DRAFT — Platform-Wide Liability Policy (requires attorney review, not final legal copy)

> **THIS DOCUMENT IS A DRAFT.** It is internal working copy only — **not
> legal advice and not final legal language.** Every clause below must be
> reviewed, rewritten as needed, and approved by a licensed attorney before
> it is published on the site or in the app. Do not copy-paste this text
> into production without counsel sign-off.

**Date:** 2026-09-30
**Scope:** Tattoo Art Customs website (`tattoo-art-customs.onrender.com`)
and the Tattoo Art Customs mobile app (site + app wide).
**Parties covered:** customers, design artists, and tattoo shops.

## Current state (verified 2026-09-30)

The site already has a Terms of Service page (`src/views/site/terms.ejs`,
rendered at `/terms`). It covers marketplace mechanics only — pricing,
all-sales-final, contact rules, off-site sales, artist payouts, acceptable
use — and contains **no liability language whatsoever**: no
marketplace-not-provider statement, no assumption of risk, no limitation of
liability, no indemnification, no governing law. **The site already takes
money.** Owner instruction: ship a reviewed version with v1.0 if possible.

## 1. Marketplace-not-provider

**Intent:** The platform is a marketplace and directory. It does not
perform, supervise, employ, or control tattoo services. Shops and artists
listed on the platform are independent third parties; the platform is not
their agent, employer, or partner.

**DRAFT clause intent (attorney to finalize):**
"Tattoo Art Customs provides an online marketplace, directory, and booking
facilitation tools. Tattoo services booked through shops or artists listed
on the platform are performed solely by those independent third parties.
We do not perform tattoo services, do not supervise tattoo procedures, do
not select or credential tattoo artists on behalf of customers, and make no
representation that any listed shop or artist meets any particular
standard of skill, hygiene, or professionalism."

## 2. Assumption of risk — tattoo services

**Intent:** Tattoos are permanent bodily modifications with inherent risks
(infection, scarring, allergic reaction, bloodborne illness, unsatisfactory
aesthetic outcome). Customers assume those risks when booking services
through the platform; they are responsible for verifying a shop's hygiene,
licensing, and portfolio themselves.

**DRAFT clause intent (attorney to finalize):**
"By booking a tattoo appointment through the platform, you acknowledge and
assume all risks inherent in receiving a tattoo, including but not limited
to infection, allergic reaction, scarring, unsatisfactory results, and
permanence. You agree to consult a qualified health professional about any
medical concerns before being tattooed, and to verify for yourself the
licensing, hygiene practices, and qualifications of any shop or artist you
book."

**Age floor:** Tattoo services are for adults only. Customers must be of
legal age to be tattooed in the jurisdiction where the service is performed
(18+ in most US states). The platform is not responsible for verifying
customer age — shops must verify age at appointment time and their waivers
should include age attestation.

## 3. Limitation of liability

**Intent:** To the maximum extent permitted by law, cap platform liability;
exclude indirect/consequential damages (e.g., cost of cover-up or laser
removal, lost wages from infection, emotional distress over a bad tattoo).

**DRAFT clause intent (attorney to finalize):**
"To the maximum extent permitted by applicable law, Tattoo Art Customs'
total liability arising from your use of the platform shall not exceed the
greater of (a) the amount you paid to the platform in the twelve months
preceding the claim, or (b) one hundred US dollars ($100). In no event
shall the platform be liable for indirect, incidental, consequential,
special, or punitive damages — including costs of tattoo removal,
cover-up work, or medical treatment — arising from tattoo services
performed by third-party shops or artists."

**Attorney note:** Some jurisdictions limit how far liability can be
disclaimed (especially for gross negligence). Counsel must confirm the
cap and carve-outs for the jurisdictions we operate in.

## 4. Indemnification

**Intent:** Users (customers, artists, shops) hold the platform harmless
for claims arising from their own conduct: a customer's claim against
their shop, an artist's IP infringement, a shop's botched tattoo.

**DRAFT clause intent (attorney to finalize):**
"You agree to indemnify, defend, and hold harmless Tattoo Art Customs and
its owner, operators, and affiliates from any claims, damages, losses, or
expenses (including reasonable attorneys' fees) arising from (a) tattoo
services you performed or received, (b) content you uploaded, (c) your
violation of these terms, or (d) your violation of any law."

## 5. No endorsement; reviews are not guarantees

**Intent:** Listings, badges ("verified"), ratings, and reviews are
informational. A "verified shop" badge means the shop completed our
verification process — it is not a certification of skill, safety, or
quality, and must not be presented as one.

**DRAFT clause intent (attorney to finalize):**
"Shop listings, verification badges, ratings, and reviews are provided for
informational purposes only and do not constitute an endorsement,
certification, or guarantee of any shop's or artist's skill, hygiene, or
quality of work. We do not independently inspect shops or audit their
practices."

## 6. Designer-facing terms (IP & originality)

**Intent:** Design artists warrant their uploads are original (or properly
licensed) and indemnify the platform against infringement claims. This
pairs with the existing acceptable-use clause in `/terms` §7.

**DRAFT clause intent (attorney to finalize):**
"By uploading a design, you represent and warrant that you own or hold
sufficient rights to the design, that it does not infringe any third
party's intellectual property rights, and that it is not generated from or
a copy of another artist's protected work. You agree to indemnify the
platform against claims arising from alleged infringement of your uploads."

## 7. Shop waivers ↔ platform terms (interaction)

This is the piece the v1.1 Digital Waivers feature makes operational. The
rules below must be reflected in the waiver product UI when it ships:

1. **Shop waivers are between the shop and the customer.** The platform is
   not a party to any waiver signed through the waiver tool; the waiver
   covers the tattoo procedure performed by the shop.
2. **Platform terms still apply.** Signing a shop waiver does not waive,
   limit, or replace the customer's agreement with the platform (these
   terms). If a shop waiver purports to release the *platform* from
   liability, that release is between shop and customer — the platform's
   own limitation of liability in §3 stands on its own.
3. **No legal-advice presentation.** Waiver templates are shop-supplied;
   the platform provides the tooling only. Every waiver template editor
   and every signing page must carry the disclaimer: *"Tattoo Art Customs
   provides waiver tooling only and is not your lawyer. Have your waiver
   reviewed by your own attorney."*
4. **Waiver data handling.** Signed waivers and captured ID photos are the
   shop's business records, stored by the platform as a processor. ID
   photos are encrypted at rest and auto-deleted per the shop's retention
   setting (default 730 days). Shops must disclose ID capture and
   retention to customers in their own waiver text.
5. **Conflicts.** If a shop waiver conflicts with platform terms as to the
   platform's liability, platform terms control as to the platform.

## 8. Disclaimers (as-is; no warranties)

**DRAFT clause intent (attorney to finalize):**
"The platform is provided 'as is' and 'as available' without warranties of
any kind, express or implied, including implied warranties of
merchantability, fitness for a particular purpose, and non-infringement.
We do not warrant that the platform will be uninterrupted, error-free, or
free of harmful components."

## 9. Account termination & content removal

(Already partially covered by `/terms` §7 acceptable use — attorney should
confirm the suspension/removal right is stated broadly enough to cover
liability-driven removals, e.g. a shop listing drawing repeated safety
complaints.)

## 10. Governing law & disputes — ATTORNEY TO DECIDE

Placeholder issues for counsel: governing law and venue; whether to require
binding arbitration and a class-action waiver; small-claims carve-out;
notice-and-cure period. Do not ship without counsel's call here.

## 11. How to ship it

1. Attorney reviews and finalizes this draft → final copy.
2. Append finalized sections to `/terms` (`src/views/site/terms.ejs`),
   bump "Last updated," add section numbering that doesn't collide with
   existing §§1–7.
3. **App parity:** the app's WebView already loads site pages; link
   `/terms` from the app's account/settings area so the liability terms
   are reachable in-app, not just on the website.
4. **Acceptance:** add an explicit "I agree to the Terms of Service"
   checkbox on signup and on first booking checkout, timestamped and
   stored (version of terms accepted). Existing users: banner prompting
   re-acceptance when the liability sections go live.
5. Keep this DRAFT file in the repo (docs/) as the paper trail of what
   counsel reviewed.

## 12. Minimum viable v1.0 version

If counsel time is limited before v1.0, ship at minimum: §1
(marketplace-not-provider), §2 (assumption of risk), §3 (limitation of
liability), and the §7.3 waiver disclaimer — reviewed by the attorney —
appended to `/terms`, with the acceptance checkbox in §11.4. The rest can
follow in v1.1.
