// Merch catalog — data-driven, extensible POD + affiliate product list.
// Owner rule 2026-10-08: anything printable on demand should be addable to
// the merchandise side. Adding a product = appending one entry here (+ i18n
// keys + print asset + Printful variant env). No new pages, no new routes.
//
// Entry shape:
//   id: stable slug (used in /merch/catalog/:id)
//   kind: 'pod' | 'affiliate'
//   status: 'live' | 'coming-soon'   (drafts stay out of this file)
//   nameKey, blurbKey: i18n keys under merch.
//   image: public thumbnail path
//   POD only: printfulProduct (maps to variantIdFor/printful.js + pricing),
//             asset (print file, relative to assetDir, e.g.
//             catalog/merch/music-genres-tee-300dpi.png),
//             open: true = anyone can buy (false = owned-design flow only)
//   AFFILIATE only: url, ctaKey
//
// POD products go live only when printfulConfigured() is true AND the
// Printful variant env vars exist; otherwise they render "coming soon".
const CATALOG = [
  {
    id: 'baselabs-aftercare',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_baselabs_name',
    blurbKey: 'merch.aff_baselabs_blurb',
    image: '/img/merch/baselabs-card.webp',
    url: 'https://baselabs.is/?coupon=TAC20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-recommends',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_amazon_name',
    blurbKey: 'merch.aff_amazon_blurb',
    url: 'https://www.amazon.com/?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  // --- Amazon specific picks (tag tattooartcust-20, live) ---
  {
    id: 'amazon-saniderm',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_saniderm_name',
    blurbKey: 'merch.aff_saniderm_blurb',
    url: 'https://www.amazon.com/dp/B07LGHJMBD?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-hustle-butter',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_hustlebutter_name',
    blurbKey: 'merch.aff_hustlebutter_blurb',
    url: 'https://www.amazon.com/dp/B00AEVIIYK?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-aquaphor',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_aquaphor_name',
    blurbKey: 'merch.aff_aquaphor_blurb',
    url: 'https://www.amazon.com/dp/B001FB5IP0?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  // --- Sponsor/crossover brand picks (tag tattooartcust-20, live 2026-10-09) ---
  {
    id: 'amazon-tattoogoo',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_tattoogoo_name',
    blurbKey: 'merch.aff_tattoogoo_blurb',
    url: 'https://www.amazon.com/dp/B092B5VHVQ?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-prismacolor',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_prismacolor_name',
    blurbKey: 'merch.aff_prismacolor_blurb',
    url: 'https://www.amazon.com/dp/B000E23RSQ?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-ohuhu',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_ohuhu_name',
    blurbKey: 'merch.aff_ohuhu_blurb',
    url: 'https://www.amazon.com/dp/B071R3XMWF?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-crayola',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_crayola_name',
    blurbKey: 'merch.aff_crayola_blurb',
    url: 'https://www.amazon.com/dp/B002EE1TUU?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-fabercastell',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_fabercastell_name',
    blurbKey: 'merch.aff_fabercastell_blurb',
    url: 'https://www.amazon.com/dp/B01MCTOLRY?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-arteza',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_arteza_name',
    blurbKey: 'merch.aff_arteza_blurb',
    url: 'https://www.amazon.com/dp/B01N9IY5QF?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'amazon-strathmore',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_strathmore_name',
    blurbKey: 'merch.aff_strathmore_blurb',
    url: 'https://www.amazon.com/dp/B008D2TU76?tag=tattooartcust-20',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'electrum-supply',
    kind: 'affiliate',
    status: 'live',
    nameKey: 'merch.aff_electrum_name',
    blurbKey: 'merch.aff_electrum_blurb',
    url: 'https://club.co/s/R6gQCOlWghEC9',
    ctaKey: 'merch.aff_cta',
  },
  {
    id: 'tee-music-genres',
    kind: 'pod',
    status: 'coming-soon',
    nameKey: 'merch.cat_music_name',
    blurbKey: 'merch.cat_music_blurb',
    image: '/img/merch/music-genres-tee.webp',
    printfulProduct: 'tee_classic',
    asset: 'catalog/merch/music-genres-tee-300dpi.png',
    open: true,
  },
  {
    id: 'tee-alice-tea-party',
    kind: 'pod',
    status: 'coming-soon',
    nameKey: 'merch.cat_alice_name',
    blurbKey: 'merch.cat_alice_blurb',
    image: '/img/merch/alice-tea-tee.webp',
    printfulProduct: 'tee_classic',
    asset: 'catalog/merch/alice-tea-tee-300dpi.png',
    open: true,
  },
  // --- Printful synced products (live 2026-10-09) ---
  // Bella + Canvas tees & hoodie in Black, S–2XL. syncVariants maps size ->
  // Printful sync_variant_id (used directly in /orders submit).
  {
    id: 'pf-tee-iron-serpent',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_iron_name',
    blurbKey: 'merch.pf_tee_iron_blurb',
    image: 'https://files.cdn.printful.com/files/b3e/b3ed08f0d8b8e2b5b56e47a55ce14b73_preview.png',
    printfulProduct: 'sync_tee_iron_serpent',
    syncVariants: { S: 5561819920, M: 5561819921, L: 5561819922, XL: 5561819923, '2XL': 5561819924 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-hollow-bloom',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_bloom_name',
    blurbKey: 'merch.pf_tee_bloom_blurb',
    image: 'https://files.cdn.printful.com/files/712/71243ed90873cbe87d355afa0fe4a030_preview.png',
    printfulProduct: 'sync_tee_hollow_bloom',
    syncVariants: { S: 5561819925, M: 5561819926, L: 5561819927, XL: 5561819928, '2XL': 5561819929 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-shattered-dragon',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_dragon_name',
    blurbKey: 'merch.pf_tee_dragon_blurb',
    image: 'https://files.cdn.printful.com/files/cfe/cfee9e64ac0487cc74b2d0c8397e20ed_preview.png',
    printfulProduct: 'sync_tee_shattered_dragon',
    syncVariants: { S: 5561819914, M: 5561819915, L: 5561819916, XL: 5561819917, '2XL': 5561819918 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-hoodie-iron-serpent',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_hoodie_iron_name',
    blurbKey: 'merch.pf_hoodie_iron_blurb',
    image: 'https://files.cdn.printful.com/files/acb/acba117ddbf2be1a3efd8435b3c4edea_preview.png',
    printfulProduct: 'sync_hoodie_iron_serpent',
    syncVariants: { S: 5561820002, M: 5561820003, L: 5561820004, XL: 5561820005, '2XL': 5561820006 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 4499, M: 4499, L: 4499, XL: 4499, '2XL': 4799 },
    open: true,
  },
  {
    id: 'pf-mug-serpent-bloom',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_mug_bloom_name',
    blurbKey: 'merch.pf_mug_bloom_blurb',
    image: 'https://files.cdn.printful.com/files/af8/af89d5c871186bf1582233148852d832_preview.png',
    printfulProduct: 'sync_mug_serpent_bloom',
    syncVariants: { OS: 5561820000 },
    sizes: null,
    priceCents: 1599,
    open: true,
  },
  {
    id: 'pf-sticker-serpent-bloom',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_sticker_bloom_name',
    blurbKey: 'merch.pf_sticker_bloom_blurb',
    image: 'https://files.cdn.printful.com/files/d82/d827e4e8171878ff3021d7ae5f517916_preview.png',
    printfulProduct: 'sync_sticker_serpent_bloom',
    syncVariants: { OS: 5561820001 },
    sizes: null,
    priceCents: 799,
    open: true,
  },
  {
    id: 'pf-poster-iron-serpent',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_poster_iron_name',
    blurbKey: 'merch.pf_poster_iron_blurb',
    image: 'https://files.cdn.printful.com/files/675/6753e31e80573aeaba3116aa06c1affd_preview.png',
    printfulProduct: 'sync_poster_iron_serpent',
    syncVariants: { OS: 5561819956 },
    sizes: null,
    priceCents: 1799,
    open: true,
  },
  {
    id: 'pf-poster-hollow-bloom',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_poster_bloom_name',
    blurbKey: 'merch.pf_poster_bloom_blurb',
    image: 'https://files.cdn.printful.com/files/c38/c38bcdbf62ad4e2f7bcc3d082492fb9d_preview.png',
    printfulProduct: 'sync_poster_hollow_bloom',
    syncVariants: { OS: 5561819932 },
    sizes: null,
    priceCents: 1799,
    open: true,
  },
  {
    id: 'pf-poster-shattered-dragon',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_poster_dragon_name',
    blurbKey: 'merch.pf_poster_dragon_blurb',
    image: 'https://files.cdn.printful.com/files/1af/1af7d49bdfea41c49ce5f4d8c02050d6_preview.png',
    printfulProduct: 'sync_poster_shattered_dragon',
    syncVariants: { OS: 5561819931 },
    sizes: null,
    priceCents: 1799,
    open: true,
  },
  // --- 8 new tee designs (live 2026-10-09) ---
  // Bella + Canvas 3001 Black, S–2XL. Picked from gallery originals.
  {
    id: 'pf-tee-astral-anchor',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_astral_name',
    blurbKey: 'merch.pf_tee_astral_blurb',
    image: 'https://files.cdn.printful.com/files/8ea/8ea77578d373c5d38362416485392c1f_preview.png',
    printfulProduct: 'sync_tee_astral_anchor',
    syncVariants: { S: 5562703189, M: 5562703190, L: 5562703192, XL: 5562703201, '2XL': 5562703202 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-veil-between',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_veil_name',
    blurbKey: 'merch.pf_tee_veil_blurb',
    image: 'https://files.cdn.printful.com/files/795/79589a6e1225b974a16d601852a0a986_preview.png',
    printfulProduct: 'sync_tee_veil_between',
    syncVariants: { S: 5562703258, M: 5562703266, L: 5562703273, XL: 5562703278, '2XL': 5562703289 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-hollow-wings',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_wings_name',
    blurbKey: 'merch.pf_tee_wings_blurb',
    image: 'https://files.cdn.printful.com/files/ecc/ecc5ecece1b026df4e9c9f8d25024457_preview.png',
    printfulProduct: 'sync_tee_hollow_wings',
    syncVariants: { S: 5562703345, M: 5562703362, L: 5562703364, XL: 5562703372, '2XL': 5562703375 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-watchers-root',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_watchers_name',
    blurbKey: 'merch.pf_tee_watchers_blurb',
    image: 'https://files.cdn.printful.com/files/a77/a770f4729a543e5acbe68003141adbea_preview.png',
    printfulProduct: 'sync_tee_watchers_root',
    syncVariants: { S: 5562703437, M: 5562703447, L: 5562703460, XL: 5562703467, '2XL': 5562703471 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-mechanical-heart',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_mechheart_name',
    blurbKey: 'merch.pf_tee_mechheart_blurb',
    image: 'https://files.cdn.printful.com/files/30f/30fe40f3d78399832a88af1cdfd0364d_preview.png',
    printfulProduct: 'sync_tee_mechanical_heart',
    syncVariants: { S: 5562703528, M: 5562703532, L: 5562703540, XL: 5562703550, '2XL': 5562703552 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-eternal-cycle',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_eternal_name',
    blurbKey: 'merch.pf_tee_eternal_blurb',
    image: 'https://files.cdn.printful.com/files/d8c/d8cf31644b508071fe605ffcda81577b_preview.png',
    printfulProduct: 'sync_tee_eternal_cycle',
    syncVariants: { S: 5562703702, M: 5562703704, L: 5562703709, XL: 5562703715, '2XL': 5562703731 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-sacred-solitude',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_sacred_name',
    blurbKey: 'merch.pf_tee_sacred_blurb',
    image: 'https://files.cdn.printful.com/files/243/243f662037c102f6ff337cae560ea2c4_preview.png',
    printfulProduct: 'sync_tee_sacred_solitude',
    syncVariants: { S: 5562703809, M: 5562703815, L: 5562703820, XL: 5562703827, '2XL': 5562703832 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
  {
    id: 'pf-tee-time-grows',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.pf_tee_timegrows_name',
    blurbKey: 'merch.pf_tee_timegrows_blurb',
    image: 'https://files.cdn.printful.com/files/852/8529e19e821f8ecee511959c8effb51d_preview.png',
    printfulProduct: 'sync_tee_time_grows',
    syncVariants: { S: 5562703885, M: 5562703886, L: 5562703887, XL: 5562703889, '2XL': 5562703896 },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },
];

function getProduct(id) {
  return CATALOG.find((p) => p.id === id) || null;
}

function liveProducts() {
  return CATALOG.filter((p) => p.status === 'live');
}

function affiliateProducts() {
  return CATALOG.filter((p) => p.kind === 'affiliate' && p.status === 'live');
}

function podProducts() {
  return CATALOG.filter((p) => p.kind === 'pod');
}

// --- SHEIN section (placeholder, 2026-10-09) ---
// Owner: "SHEIN too once it's up and going." The SHEIN seller account is
// NOT approved yet — when it is and products are listed there, add entries
// here with kind: 'shein', status: 'live', nameKey/blurbKey, image, url
// (SHEIN product URL), ctaKey. sheinProducts() feeds the /merch view, which
// only renders the section when the list is non-empty.
function sheinProducts() {
  return CATALOG.filter((p) => p.kind === 'shein' && p.status === 'live');
}

// --- Partner pipeline (not live affiliates — do NOT render) ---
// Programs we've applied to but aren't approved yet (Dr. Tattoo Skin, OOLY,
// This Month's Craft, Electrum Supply, EZ Tattoo, Leda Art Supply, ...).
// They have NO referral links, so they stay out of the catalog. When a
// program approves us, add it as kind: 'affiliate', status: 'live' above.

module.exports = { CATALOG, getProduct, liveProducts, affiliateProducts, podProducts, sheinProducts };
