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

module.exports = { CATALOG, getProduct, liveProducts, affiliateProducts, podProducts };
