'use strict';
// Original editorial copy for gallery STYLE pages (owner order 2026-10-16:
// the optical-illusion and stipple styles get browsable pages with the same
// treatment category pages get — intro copy, style-specific title/meta, and
// sitemap entries). Mirrors categoryContent.js: style names/blurbs are
// content data (English, like design titles), so they live here rather than
// in the i18n catalogs. A style page intro is built only for styles listed
// in BLURBS; SITEMAP_STYLES lists the style pages the sitemap advertises.

const NAMES = {
  'optical-illusion': 'Optical Illusion',
  'stipple': 'Stipple',
};

const BLURBS = {
  'optical-illusion':
    'Impossible cubes, Penrose triangles, staircases that climb into themselves, faces that are also vases, waves that move when you stare — optical illusion tattoos are built to trick the eye and reward a second look. The effect lives or dies on clean geometry, so these designs are drawn with bold, precise linework that keeps the illusion readable on skin for years. They sit best where the skin gives the geometry a fair canvas: forearms, calves, shoulders and upper arms, sized large enough for the trick to land.',
  'stipple':
    'Stipple tattoos shade with nothing but dots — thousands of them, packed tight where the shadow is deep and scattered where it fades. The result is a soft, grainy gradient no solid fill can copy, with a hand-drawn texture that ages gracefully because there are no hard shading edges to blur. This collection covers the full range the technique is loved for: stippled animals, botanicals, portraits, skulls and geometric pieces, every one drawn dot-density first so your artist can follow the exact same build on skin.',
};

// Styles with a browsable page (intro + sitemap entry). Keep in sync with
// BLURBS above: a style is listed here only once it has a blurb.
const SITEMAP_STYLES = ['optical-illusion', 'stipple'];

function humanizeStyle(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function nameForStyle(slug) {
  const key = String(slug || '').toLowerCase();
  return NAMES[key] || humanizeStyle(key);
}

function blurbForStyle(slug) {
  return BLURBS[String(slug || '').toLowerCase()] || null;
}

module.exports = { SITEMAP_STYLES, nameForStyle, blurbForStyle };
