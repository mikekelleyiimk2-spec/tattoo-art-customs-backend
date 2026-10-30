// Library shelf sponsorships (Bundle C Build 2, 2026-10-28).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers: the shelf config is grounded in the Library app's own
// shelves; the per-shelf price was OWNER-STRUCK 2026-10-30 at a
// flat $9.99/mo for every eligible shelf (flagged owner-struck),
// while the whole-Library "Presented by" offer was NOT struck and
// stays flagged assessed/pending at its assessed figure; the offer
// page renders honestly (availability shown, no invented reach
// numbers, inquiry rides POST /contact), and the sponsor chair
// partial renders labelled in its unsold state.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

async function runDbTests(ok) {
  console.log('library sponsors (shelf config + assessed prices):');
  const lib = require('../src/lib/librarySponsors');
  const pricing = require('../src/lib/pricing');

  // Grounded shelves: the six book shelves are the Library app's own
  // SHELVES, verbatim (work/manifest.py + bundled books/index.js).
  const bookShelves = ['The Verne Shelf', 'Classics', 'Adventure & the Sea',
    'Mystery & Detectives', 'Sci-Fi & the Strange', "Children's Classics"];
  for (const name of bookShelves) {
    ok(lib.SHELVES.some((s) => s.name === name), `grounded book shelf in config: ${name}`);
  }
  ok(lib.SHELVES.some((s) => s.name === 'The Listening Shelf'), 'grounded shelf in config: The Listening Shelf (LibriVox)');
  ok(lib.SHELVES.some((s) => s.name === 'The Documentary Shelf'), 'grounded shelf in config: The Documentary Shelf (Big One #doc)');
  ok(lib.SHELVES.every((s) => s.source && s.source.length > 10), 'every shelf names the file it is grounded in');
  ok(lib.SHELVES.every((s) => s.availability === 'Founding — available' || s.availability === 'Not sponsor-eligible'),
    'availability is honest: every eligible shelf is Founding — available, none marked taken');

  // Pricing: per-shelf rate OWNER-STRUCK 2026-10-30 at a flat
  // $9.99/mo (replacing the assessed $20–$30 scale); whole-Library
  // presented-by NOT struck — still assessed/pending at $75/mo base.
  ok(lib.PRICE_STATUS === 'OWNER-STRUCK — LIVE (2026-10-30)', 'shelf price status flag is OWNER-STRUCK — LIVE (2026-10-30)');
  ok(lib.eligibleShelves().every((s) => s.priceStatus === lib.PRICE_STATUS),
    'every eligible shelf carries the owner-struck flag');
  ok(lib.WHOLE_LIBRARY.priceStatus === lib.ASSESSED_STATUS
    && lib.ASSESSED_STATUS === 'ASSESSED — PENDING OWNER STRIKE',
  'whole-Library offer still carries the assessed — pending owner strike flag (not part of the strike)');
  const verne = lib.shelfByKey('the-verne-shelf');
  ok(verne && verne.baseCents === 999, 'Verne Shelf at the owner-struck flat rate ($9.99/mo base)');
  ok(lib.eligibleShelves().every((s) => s.baseCents === 999), 'EVERY eligible shelf is the flat struck $9.99/mo base');
  ok(lib.WHOLE_LIBRARY.baseCents === 7500, 'whole-Library presented-by left exactly as assessed ($75/mo base)');
  ok(lib.shelfPriceCents(verne) === pricing.withFeeCents(999), 'register price = base + house fee pass-through (same math as /dawnfold/sponsors)');

  // Kid-safe rule: the children's shelf sells no chairs.
  const kids = lib.shelfByKey('childrens-classics');
  ok(kids && kids.sponsorEligible === false && kids.baseCents === null
    && lib.shelfPriceCents(kids) === null, "Children's Classics is NOT sponsor-eligible and has no price");

  // Sponsor chair partial: labelled, unsold state, points at the offer page.
  const partial = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'partials', 'sponsor-chair.ejs'), 'utf8');
  const chairHtml = await ejs.render(partial, { shelf: { key: 'the-documentary-shelf', name: 'The Documentary Shelf' } }, { async: true });
  ok(chairHtml.includes('SPONSOR'), 'sponsor chair partial is labelled SPONSOR');
  ok(chairHtml.includes('founding sponsor chair open') && chairHtml.includes('This shelf is carried by'),
    'sponsor chair renders in its unsold state (founding chair open)');
  ok(chairHtml.includes('/library/sponsors#shelf-the-documentary-shelf'), 'sponsor chair links to the shelf on /library/sponsors');
  const soldHtml = await ejs.render(partial, { shelf: { key: 'classics', name: 'Classics' }, sponsorName: 'Bayou Books' }, { async: true });
  ok(soldHtml.includes('Classics is carried by Bayou Books') && soldHtml.includes('SPONSOR'),
    'sponsor chair names a sponsor when one carries the shelf (still labelled)');
}

async function runHttpTests(ok, req) {
  console.log('library sponsors (offer page):');
  const r = await req('GET', '/library/sponsors');
  ok(r.status === 200, '/library/sponsors serves 200');
  ok(r.text.includes('Sponsor a Library Shelf'), 'offer page names the Library shelf sponsorships');
  // Names as they appear in the rendered HTML (& and ' are entity-escaped).
  for (const name of ['The Verne Shelf', 'Classics', 'Adventure &amp; the Sea', 'Mystery &amp; Detectives',
    'Sci-Fi &amp; the Strange', 'The Listening Shelf', 'The Documentary Shelf', 'Children&#39;s Classics']) {
    ok(r.text.includes(name), `offer page lists shelf: ${name.replace(/&amp;/g, '&').replace(/&#39;/g, "'")}`);
  }
  ok(r.text.includes('Founding — available'), 'offer page shows honest founding availability');
  ok(r.text.includes('Not sponsor-eligible'), "offer page marks Children's Classics not sponsor-eligible");
  ok(r.text.includes('owner-struck — live (2026-10-30)') && r.text.includes('set by the owner'),
    'struck shelf prices carry the owner-set label (fine print shows the struck status)');
  ok(r.text.includes('founding rate — pending final confirmation') && r.text.includes('assessed — pending owner strike'),
    'the unstruck whole-Library offer still carries the pending-final-confirmation label');
  ok(r.text.includes('$10.83'), 'the struck shelf rate is shown at register ($9.99 base + fee pass-through = $10.83; Big One price pattern: prices shown, not hidden)');
  ok(r.text.includes('action="/contact"') && r.text.includes('Library shelf sponsorship:'),
    'inquiry form rides POST /contact with the Library shelf marker preselected in the message');
  ok(r.text.includes('name="shelf"'), 'inquiry form carries a shelf selector');
  ok(!/\d[\d,]* (readers|subscribers|views|downloads) (per|a) (day|month)/i.test(r.text), 'no invented reach numbers on the offer page');
  ok(r.text.includes('SPONSOR') && r.text.includes('founding sponsor chair open'), 'sponsor chairs render labelled + unsold on the offer page');

  // The chair on a real shelf surface: the Documentary Shelf
  // department of Dawnfold edition.
  const edition = await req('GET', '/dawnfold');
  ok(edition.status === 200 && edition.text.includes('The Documentary Shelf'), 'edition still serves with its Documentary Shelf');
  ok(edition.text.includes('This shelf is carried by') && edition.text.includes('/library/sponsors#shelf-the-documentary-shelf'),
    'Documentary Shelf in the edition carries the unsold Library sponsor chair linking to /library/sponsors');
}

module.exports = { runDbTests, runHttpTests };
