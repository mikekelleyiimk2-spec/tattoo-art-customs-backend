// Library shelf sponsorships (Bundle C Build 2, 2026-10-28).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers: the shelf config is grounded in the Library app's own
// shelves, every assessed price is flagged pending owner strike,
// the offer page renders honestly (availability shown, no invented
// reach numbers, inquiry rides POST /contact), and the sponsor
// chair partial renders labelled in its unsold state.
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

  // Assessed pricing: flagged on every entry, scaled off the Big One
  // card ($25/mo department, $75/mo presented-by — thebigone.js).
  ok(lib.PRICE_STATUS === 'ASSESSED — PENDING OWNER STRIKE', 'price status flag is ASSESSED — PENDING OWNER STRIKE');
  ok(lib.SHELVES.every((s) => s.priceStatus === lib.PRICE_STATUS)
    && lib.WHOLE_LIBRARY.priceStatus === lib.PRICE_STATUS, 'every price entry carries the assessed flag');
  const verne = lib.shelfByKey('the-verne-shelf');
  ok(verne && verne.baseCents === 2500, 'Verne Shelf assessed at the Big One department level ($25/mo base)');
  ok(lib.WHOLE_LIBRARY.baseCents === 7500, 'whole-Library presented-by assessed at the Big One presented-by level ($75/mo base)');
  ok(lib.shelfPriceCents(verne) === pricing.withFeeCents(2500), 'register price = base + house fee pass-through (same math as /the-big-one/sponsors)');
  ok(lib.eligibleShelves().every((s) => s.baseCents >= 2000 && s.baseCents <= 3000), 'eligible shelf bases scale sensibly ($20–$30/mo)');

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
  ok(r.text.includes('founding rate — pending final confirmation') && r.text.includes('assessed — pending owner strike'),
    'assessed prices carry the pending-final-confirmation label');
  ok(r.text.includes('$26.37') || r.text.includes('$25'), 'a shelf founding rate is shown (Big One price pattern: prices shown, not hidden)');
  ok(r.text.includes('action="/contact"') && r.text.includes('Library shelf sponsorship:'),
    'inquiry form rides POST /contact with the Library shelf marker preselected in the message');
  ok(r.text.includes('name="shelf"'), 'inquiry form carries a shelf selector');
  ok(!/\d[\d,]* (readers|subscribers|views|downloads) (per|a) (day|month)/i.test(r.text), 'no invented reach numbers on the offer page');
  ok(r.text.includes('SPONSOR') && r.text.includes('founding sponsor chair open'), 'sponsor chairs render labelled + unsold on the offer page');

  // The chair on a real shelf surface: the Documentary Shelf
  // department of The Big One edition.
  const edition = await req('GET', '/the-big-one');
  ok(edition.status === 200 && edition.text.includes('The Documentary Shelf'), 'edition still serves with its Documentary Shelf');
  ok(edition.text.includes('This shelf is carried by') && edition.text.includes('/library/sponsors#shelf-the-documentary-shelf'),
    'Documentary Shelf in the edition carries the unsold Library sponsor chair linking to /library/sponsors');
}

module.exports = { runDbTests, runHttpTests };
