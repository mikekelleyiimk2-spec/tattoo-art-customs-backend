'use strict';
// The Tattoo Art Customs article series (AdSense DO-NOW pass 2026-11-07).
//
// Benchmark gap #2: every approved small site in our niche runs a
// dated, bylined article stream; we had none — the guides are static
// and undated. This module is the series' registry: each article is a
// full editorial piece (1,200+ words) rendered from its own EJS view,
// listed here with its dates, its gallery category and its guide link
// so the index, the sitemap and the cross-links all read one source.
//
// First tranche (2026-11-07): six pieces on meanings, placement and
// choosing — the topics the gallery already spans. Add new articles at
// the TOP of the list (newest first) as the cadence continues.

const ARTICLES = [
  {
    slug: 'rose-tattoo-meaning',
    title: 'Rose Tattoo Meaning: Love, Balance, and the Flower That Earned It',
    deck: 'The rose is tattooing\'s oldest love letter — but the meaning changes with the color, the thorns, and what you plant next to it. Here is what a rose tattoo actually says, and how to size and place one so it still says it in thirty years.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Flowers & Botanicals',
    guide: { href: '/guides/choosing-a-design', label: 'How to Choose a Tattoo Design That Ages Well' },
    styleGuide: { href: '/styles/traditional-old-school', label: 'the American Traditional style guide' },
  },
  {
    slug: 'forearm-tattoo-placement-guide',
    title: 'Forearm Tattoos: Placement, Pain, and How They Age in Public',
    deck: 'The forearm is the most visible canvas most people own. What faces up, what faces you, how much it honestly hurts, what the sun does to it at work, and the sizes that keep a forearm piece readable — the full placement brief.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Animals & Wildlife',
    guide: { href: '/guides/stencil-day', label: 'Stencil Day: Size, Placement & the Mirror Check' },
    styleGuide: { href: '/styles/fine-line', label: 'the Fine Line style guide' },
  },
  {
    slug: 'koi-fish-tattoo-meaning',
    title: 'Koi Fish Tattoo Meaning: Perseverance, Direction, and the Dragon Gate',
    deck: 'A koi swimming up is a different sentence from a koi swimming down. The legend, the colors, the direction, and why koi are drawn big — the meaning and the mechanics of tattooing\'s most storied fish.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Mythology & Fantasy',
    guide: { href: '/guides/choosing-a-design', label: 'How to Choose a Tattoo Design That Ages Well' },
    styleGuide: { href: '/styles/japanese-irezumi', label: 'the Japanese (Irezumi) style guide' },
  },
  {
    slug: 'first-tattoo-placement-pain-guide',
    title: 'Where It Hurts Least: A First-Tattoo Placement and Pain Guide',
    deck: 'An honest pain map of the body for a first tattoo — the spots that forgive beginners, the ones that don\'t, why pain is the wrong first question anyway, and how to choose a placement you will still love at fifty.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Characters / People',
    guide: { href: '/guides/first-tattoo', label: 'Your First Tattoo: A Complete, Calm Walkthrough' },
    styleGuide: { href: '/styles/minimalist', label: 'the Minimalist style guide' },
  },
  {
    slug: 'semicolon-tattoo-meaning',
    title: 'Semicolon Tattoo Meaning: The Small Mark With the Long Story',
    deck: 'Two dots and a pause that carry a whole movement. Where the semicolon tattoo came from, what it means to the people who wear it, where it sits best, and how to keep a tiny tattoo legible for life.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Lettering / Symbols',
    guide: { href: '/guides/first-tattoo', label: 'Your First Tattoo: A Complete, Calm Walkthrough' },
    styleGuide: { href: '/styles/fine-line', label: 'the Fine Line style guide' },
  },
  {
    slug: 'cover-up-tattoo-guide',
    title: 'Cover-Up Tattoos: What Actually Works (and What Never Will)',
    deck: 'A cover-up is not an eraser — it is a new tattoo with a harder brief. What can be covered, what can only be reworked, the physics of ink over ink, laser fading first, and how to brief an artist for the job.',
    published: '2026-11-07',
    updated: '2026-11-07',
    category: 'Skulls / Death / Gothic',
    guide: { href: '/guides/custom-design-process', label: 'How Custom Tattoo Designs Work, Step by Step' },
    styleGuide: { href: '/styles/blackwork', label: 'the Blackwork style guide' },
  },
];

function articleForSlug(slug) {
  return ARTICLES.find((a) => a.slug === slug) || null;
}

module.exports = { ARTICLES, articleForSlug };
