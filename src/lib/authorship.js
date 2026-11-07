'use strict';
// Authorship / E-E-A-T layer (AdSense DO-NOW pass 2026-11-07).
//
// The benchmark study's gap #4: every approved small site puts a named
// author and a date on its content; ours was anonymous and undated.
// The byline identity is the site's own, as presented on the About
// page — Tattoo Art Customs is "built and run by Useful Appz
// Development Studios," and Mike's Customs™ is the studio's public
// brand (About page logo cards; the merch storefront trades as Mike's
// Custom Tees). Guides are written by the studio desk, so the byline
// names the desk and the studio — no invented individual.
//
// Dates are the honest editorial record: `published` is when the page
// first went live (from the repo's own history), `updated` when its
// copy last materially changed. Pages first published by the
// 2026-11-07 article series carry that date.

const AUTHOR = {
  name: 'The Tattoo Art Customs Studio Desk',
  role: 'Tattoo Art Customs — built and run by Useful Appz Development Studios (Mike’s Customs™)',
  note: 'Written and kept current by the studio’s own desk — the same people who draw the designs, run the gallery and answer the contact form. Guide copy is checked against what our artists and partner shops tell clients at the chair.',
};

const PAGES = {
  'guide-first-tattoo': { published: '2026-11-07', updated: '2026-11-07' },
  'guide-stencil-day': { published: '2026-11-07', updated: '2026-11-07' },
  'guide-aftercare': { published: '2026-10-12', updated: '2026-11-07' },
  'guide-choosing-design': { published: '2026-10-12', updated: '2026-11-07' },
  'guide-custom-process': { published: '2026-10-12', updated: '2026-11-07' },
  'guide-for-shops': { published: '2026-10-12', updated: '2026-11-07' },
  guides: { published: '2026-10-12', updated: '2026-11-07' },
  about: { published: '2026-10-05', updated: '2026-11-07' },
  worlds: { published: '2026-10-27', updated: '2026-11-07' },
  watch: { published: '2026-10-25', updated: '2026-11-07' },
  show: { published: '2026-10-27', updated: '2026-11-07' },
  'poppy-ziggy': { published: '2026-10-27', updated: '2026-11-07' },
};

function humanDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

// Same byline + JSON-LD for a dated article in the /articles series,
// whose dates live on the article record itself (lib/articles).
function bylineFromDates({ published, updated }, { base, path, headline, description }) {
  return buildByline({ published, updated }, { base, path, headline, description });
}

// Render-ready byline block + Article structured data for a content
// page. `base` is the site origin, `path` the canonical path.
function bylineFor(key, opts) {
  const dates = PAGES[key];
  if (!dates) return null;
  return buildByline(dates, opts);
}

function buildByline(dates, { base, path, headline, description }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline,
    description,
    author: { '@type': 'Organization', name: AUTHOR.name, parentOrganization: { '@type': 'Organization', name: 'Useful Appz Development Studios' } },
    publisher: { '@type': 'Organization', name: 'Tattoo Art Customs' },
    datePublished: dates.published,
    dateModified: dates.updated,
    mainEntityOfPage: `${base}${path}`,
  };
  return {
    authorName: AUTHOR.name,
    authorRole: AUTHOR.role,
    authorNote: AUTHOR.note,
    publishedIso: dates.published,
    updatedIso: dates.updated,
    published: humanDate(dates.published),
    updated: humanDate(dates.updated),
    jsonLd,
  };
}

module.exports = { AUTHOR, PAGES, bylineFor, bylineFromDates, humanDate };
