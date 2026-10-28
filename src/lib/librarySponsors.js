// Library shelf sponsorships — the offer config for The Library
// (owner-approved build order, Bundle C Build 2, 2026-10-28).
//
// ONE config place for Library shelf sponsorships, mirroring the
// house pattern in src/lib/thebigone.js (SPONSORS rate card): routes
// and views read from this module only — no price is typed twice.
//
// SHELVES — grounded, nothing invented:
// - The six book shelves are the Library app's own shelves, verbatim:
//   SHELVES in ~/workspace/app/library/work/manifest.py and
//   window.SHELVES in the bundled books/index.js (28 public-domain
//   books bundled in the app, pulled from Project Gutenberg).
// - "The Listening Shelf" is the Library app's own audiobook shelf
//   (index.html / listening.html in the app; LibriVox recordings).
// - "The Documentary Shelf" is The Big One's Library department
//   (Edition No. 1, section #doc: "From the Library's public-domain
//   shelves — real films, free forever"), sourced from the Prelinger
//   Collection at the Internet Archive as printed in the edition.
// These are NOT The Big One's departments renamed — the departments
// list belongs to thebigone.js; this list is the Library's shelves.
//
// PRICES — ASSESSED, PENDING OWNER STRIKE:
// Every baseCents below is an Aria assessment, NOT an owner-settled
// price. Scale: The Big One's owner-ordered department sponsorship
// is $25/mo and its edition "Presented by" is $75/mo
// (src/lib/thebigone.js SPONSORS, 2026-10-27), so a single Library
// shelf is assessed at the department level ($25/mo for the flagship
// shelves, $20/mo for the narrower shelves), the Documentary Shelf
// at $30/mo (it also carries a chair in The Big One's edition), and
// the whole-Library "Presented by" at $75/mo. PRICE_STATUS carries
// the flag on every entry.
//
// Price presentation mirrors /the-big-one/sponsors exactly (that
// page SHOWS its prices): the route displays the register price —
// base + the house fee pass-through, pricing.withFeeCents, the same
// function the Big One route uses — labelled as a founding rate.
// Because these rates are assessed rather than owner-ordered, the
// page adds the one honesty line the Big One page does not need:
// "founding rate — pending final confirmation". No reach, traffic,
// reader, or download numbers are claimed anywhere: the Library is
// growing and no such numbers are printed until they can be proved,
// the same honest-founding rule as the Big One sponsors page.
//
// Availability: every eligible shelf is "Founding — available"
// today. No shelf is marked taken — no sponsor has booked one.
//
// KID-SAFE RULE: "Children's Classics" is a shelf of classic
// children's literature inside the general-audience Library app
// (the app's own readiness note stresses it is NOT the Kids' Wing,
// which is a separate child-directed app). It is nevertheless
// marked NOT sponsor-eligible here: no sponsor chairs are sold on a
// children's shelf, and nothing on it points to Tattoo Art Customs
// or carries tattoo sponsors.
const pricing = require('./pricing');

const PRICE_STATUS = 'ASSESSED — PENDING OWNER STRIKE';
const AVAILABLE = 'Founding — available';

const SHELVES = [
  {
    key: 'the-verne-shelf',
    name: 'The Verne Shelf',
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'Jules Verne, whole: Twenty Thousand Leagues under the Sea, A Journey to the Centre of the Earth, Around the World in Eighty Days, The Mysterious Island, From the Earth to the Moon, and Five Weeks in a Balloon.',
    baseCents: 2500, // $25/mo assessed — the Big One department level
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'classics',
    name: 'Classics',
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'The long shelf: Pride and Prejudice, Frankenstein, Jane Eyre, Great Expectations, A Tale of Two Cities, and their neighbours — the books readers come back to.',
    baseCents: 2500, // $25/mo assessed — the Big One department level
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'adventure-and-the-sea',
    name: 'Adventure & the Sea',
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'Treasure Island, Robinson Crusoe, Kidnapped, The Call of the Wild, and King Solomon\u2019s Mines — storms, islands, and maps that never stay folded.',
    baseCents: 2000, // $20/mo assessed — narrower shelf, under department level
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'mystery-and-detectives',
    name: 'Mystery & Detectives',
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'The Adventures of Sherlock Holmes, A Study in Scarlet, The Hound of the Baskervilles, and The Moonstone — the shelf that is read after dark.',
    baseCents: 2000, // $20/mo assessed — narrower shelf, under department level
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'sci-fi-and-the-strange',
    name: 'Sci-Fi & the Strange',
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'The Time Machine, The War of the Worlds, The Island of Doctor Moreau, and A Princess of Mars — the strange shelf, where the future was invented early.',
    baseCents: 2000, // $20/mo assessed — narrower shelf, under department level
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'the-listening-shelf',
    name: 'The Listening Shelf',
    source: 'Library app listening.html / index.html — The Listening Shelf (LibriVox)',
    blurb: 'The Library\u2019s audiobook shelf: free public-domain recordings from LibriVox, linked title by title from the shelf — for readers who listen.',
    baseCents: 2500, // $25/mo assessed — a distinct listening audience
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'the-documentary-shelf',
    name: 'The Documentary Shelf',
    source: 'The Big One Edition No. 1, section #doc — "From the Library\u2019s public-domain shelves"',
    blurb: 'Real public-domain films, one at a time — the shelf The Big One\u2019s Documentary department draws from. This sponsorship also carries the labeled sponsor chair printed in that department of the edition.',
    baseCents: 3000, // $30/mo assessed — shelf + the chair in The Big One edition
    per: 'month',
    availability: AVAILABLE,
    sponsorEligible: true,
    priceStatus: PRICE_STATUS,
  },
  {
    key: 'childrens-classics',
    name: "Children's Classics",
    source: 'Library app shelves (work/manifest.py SHELVES; bundled books/index.js window.SHELVES)',
    blurb: 'Alice\u2019s Adventures in Wonderland, Peter Pan, The Jungle Book, and The Wonderful Wizard of Oz. This shelf carries no sponsor chairs — no sponsors are sold on a children\u2019s shelf.',
    baseCents: null,
    per: 'month',
    availability: 'Not sponsor-eligible',
    sponsorEligible: false,
    priceStatus: PRICE_STATUS,
  },
];

// The whole-Library offer, mirroring The Big One's edition
// "Presented by" ($75/mo, owner-ordered there; assessed here).
const WHOLE_LIBRARY = {
  key: 'whole-library',
  name: 'The Whole Library — “Presented by” sponsorship',
  blurb: 'Your name on the Library itself for a month — “The Library, presented by …” — with a labeled sponsor chair on every eligible shelf above.',
  baseCents: 7500, // $75/mo assessed — the Big One "Presented by" level
  per: 'month',
  availability: AVAILABLE,
  sponsorEligible: true,
  priceStatus: PRICE_STATUS,
};

// Register price for a shelf/offer: base + house fee pass-through,
// exactly as /the-big-one/sponsors computes its offers. Null for a
// shelf that is not sponsor-eligible (no price exists to show).
function shelfPriceCents(entry) {
  if (!entry || !entry.sponsorEligible || !entry.baseCents) return null;
  return pricing.withFeeCents(entry.baseCents);
}

function eligibleShelves() {
  return SHELVES.filter((s) => s.sponsorEligible);
}
function shelfByKey(key) {
  return SHELVES.find((s) => s.key === key) || null;
}

module.exports = {
  PRICE_STATUS, AVAILABLE, SHELVES, WHOLE_LIBRARY,
  shelfPriceCents, eligibleShelves, shelfByKey,
};
