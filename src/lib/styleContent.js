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
  'traditional-old-school': 'American Traditional',
  'neo-traditional': 'Neo-Traditional',
  'black-grey': 'Black & Grey',
  'realism': 'Realism',
  'japanese-irezumi': 'Japanese (Irezumi)',
  'blackwork': 'Blackwork',
  'fine-line': 'Fine Line',
  'watercolor': 'Watercolor',
  'geometric': 'Geometric',
  'dotwork': 'Dotwork',
  'tribal': 'Tribal',
  'new-school': 'New School',
  'minimalist': 'Minimalist',
  'trash-polka': 'Trash Polka',
  'mandala': 'Mandala',
  'chicano': 'Chicano',
};

const BLURBS = {
  'optical-illusion':
    'Impossible cubes, Penrose triangles, staircases that climb into themselves, faces that are also vases, waves that move when you stare — optical illusion tattoos are built to trick the eye and reward a second look. The effect lives or dies on clean geometry, so these designs are drawn with bold, precise linework that keeps the illusion readable on skin for years. They sit best where the skin gives the geometry a fair canvas: forearms, calves, shoulders and upper arms, sized large enough for the trick to land.',
  'stipple':
    'Stipple tattoos shade with nothing but dots — thousands of them, packed tight where the shadow is deep and scattered where it fades. The result is a soft, grainy gradient no solid fill can copy, with a hand-drawn texture that ages gracefully because there are no hard shading edges to blur. This collection covers the full range the technique is loved for: stippled animals, botanicals, portraits, skulls and geometric pieces, every one drawn dot-density first so your artist can follow the exact same build on skin.',
  'traditional-old-school':
    'Eagles, anchors, swallows, daggers and roses — American traditional is the style that built modern tattooing: heavy black outlines, flat fields of red, green, gold and brown, and symbols drawn to stay readable for a lifetime. "Bold will hold" is the rule, and this collection follows it: single strong emblems sized for forearms, upper arms, calves and chests, each with clean linework your artist can stencil directly.',
  'neo-traditional':
    'Neo-traditional keeps traditional tattooing\'s bold skeleton and grows it up: wider jewel-tone palettes, blended shading, and decorative detail — foxes, owls, lady heads and daggers wrapped in botanicals and ornamental frames. The outer contour stays strong so the piece reads for decades, while the interior carries the richness. Most of these designs are drawn for four inches and up, where the detail has room to live.',
  'black-grey':
    'Black and grey realism renders photographs in ink wash: portraits, statues, wildlife and memorial pieces built from smooth grey gradients with highlights left as open skin. There are no outlines to hide behind — form is pure value — so these designs are drawn with the strong black structure that keeps them reading as they soften over the years. Flat, calm placements and honest size (portraits five inches and up) get the best from this collection.',
  'realism':
    'Color realism is photographic tattooing in a full palette: tigers, birds, flowers, eyes and film scenes built from layered color and soft edges instead of linework. Judge these designs the way artists do — by the value structure underneath the color. They are drawn for flat, low-motion skin at five inches and up, where the blends and textures have room to register.',
  'japanese-irezumi':
    'Dragons, koi, tigers, peonies and waves composed the Japanese way: bold subjects in motion, bound together by wind bars, clouds and water. Irezumi is a visual language — every subject carries a meaning, and the background is half the artwork. This collection runs from single motifs to sleeve and back-piece compositions whose backgrounds are drawn to extend as your suit grows.',
  'blackwork':
    'Blackwork is pure black ink at full strength: bold graphic shapes, ornamental pattern, dark illustrative work and the heavy saturation that makes it tattooing\'s cover-up answer. Skin is the second ink here — the shapes left open inside a piece are drawn as deliberately as the black. Judge these designs in silhouette; if the shape reads across the room, the details will take care of themselves.',
  'fine-line':
    'Fine line tattoos are drawn with single needles and a light hand: hair-thin botanicals, tiny script, small symbols and soft, sketch-like pieces that sit quietly on the skin. This collection is drawn at honest sizes — small, but with the breathing room between lines that keeps delicate work legible as it settles. Protected placements like the inner forearm, ankle and collarbone keep these pieces crisp longest.',
  'watercolor':
    'Watercolor tattoos mimic wet pigment: translucent washes, splatters and drips escaping around a solidly drawn subject — a bird, a flower, a fox — that anchors the splash. The pieces here are built with that anchor on purpose, plus genuinely dark values at the core, because that structure is what lets a watercolor tattoo age into a softer version of itself instead of fading away.',
  'geometric':
    'Geometric tattoos are engineered: circles, triangles, sacred-geometry diagrams and faceted animals drawn on true grids so the symmetry survives the transfer to curved skin. This collection spans bold simple emblems that work at two inches and dense patterned pieces drawn for four to six, with line spacing chosen for how ink settles over a decade, not just how it photographs fresh.',
  'dotwork':
    'Dotwork builds entire images from single dots — shading, gradients and scenes stippled point by point into a soft, grainy surface no blended shading can copy. It is one of the gentlest-aging techniques in tattooing, because dots soften into the gradient instead of losing detail. These designs are drawn dot-density first, so your artist can follow the exact construction on skin.',
  'tribal':
    'Tribal tattooing is pure black form: tapered blades, spirals, waves and woven bands flowing with the body\'s musculature, descended from the indigenous traditions of Polynesia, Samoa, Borneo and the Māori. This collection covers flowing abstract work and pattern-based designs, drawn bold and well-spaced — the way tribal has stayed readable on skin for centuries.',
  'new-school':
    'New school is tattooing turned cartoon: exaggerated characters, graffiti energy, candy-bright color and heavy outlines with highlights that pop the subject off the skin. Game characters, animals in costume, food with attitude — if it benefits from being louder than life, it lives here. Pieces are drawn for the four-to-seven-inch range, where the expressions and perspective land.',
  'minimalist':
    'Minimalist tattoos carry the biggest meaning in the fewest lines: single-line faces, tiny symbols, coordinates, constellations and quiet marks only the wearer can fully decode. Every design here states its minimum size and is drawn at a line weight that survives — minimal in concept, never so small that physics erases it.',
  'trash-polka':
    'Trash Polka collides photorealistic black and grey with saturated red graphic chaos — brush strokes, splatter, typography and abstract blocks composed like a poster. Invented in Würzburg, Germany, it is a large-format style: this collection holds composed pieces meant for sleeves, backs and whole limbs, drawn to be tattooed at scale, in sessions.',
  'mandala':
    'Mandalas bloom from a center point in perfect radial symmetry: rings of petals, dots, lace and geometry with roots in Hindu and Buddhist sacred art. These designs are drawn as true radial files — the symmetry is exact — and range from two-inch accents to sternum and back compositions engineered for the body\'s center lines.',
  'chicano':
    'Chicano tattooing is fine-line black and grey with a culture\'s diary inside it: payasas, lowriders, portraits, Catholic imagery and ornate script lettering, shaded soft as pencil. Born in the barrios and penitentiaries of the Southwest, it is the root of modern fine-line realism. These pieces are drawn with the deep black structure the style needs to keep its soul as it softens.',
};

// Styles with a browsable page (intro + sitemap entry). Keep in sync with
// BLURBS above: a style is listed here only once it has a blurb.
const SITEMAP_STYLES = [
  'optical-illusion', 'stipple', 'traditional-old-school', 'neo-traditional',
  'black-grey', 'realism', 'japanese-irezumi', 'blackwork', 'fine-line',
  'watercolor', 'geometric', 'dotwork', 'tribal', 'new-school',
  'minimalist', 'trash-polka', 'mandala', 'chicano',
];

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
