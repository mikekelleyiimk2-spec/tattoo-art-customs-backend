// Print products catalog.
//
// Fulfillment: paid print orders land in the admin print queue; live
// print-on-demand fulfillment runs through lib/printful.js when
// PRINTFUL_API_KEY is configured.
const PRODUCTS = {
  print_8x10: {
    name: 'Fine-art print — 8×10"',
    description: 'Archival matte print of your design.',
    price_cents: 2500,
  },
  print_12x16: {
    name: 'Fine-art print — 12×16"',
    description: 'Large archival matte print of your design.',
    price_cents: 4000,
  },
  poster_18x24: {
    name: 'Poster — 18×24"',
    description: 'Bold poster print of your design.',
    price_cents: 6000,
  },
  canvas_16x20: {
    name: 'Gallery canvas — 16×20"',
    description: 'Your design on stretched gallery canvas.',
    price_cents: 12000,
  },
  // POD custom tee (owner rule 2026-09-30): Bella + Canvas 3001 via
  // Printful. Apparel product: price is size-adjusted at checkout via
  // pricing.teePriceCents(); variant IDs come from
  // PRINTFUL_VARIANT_TEE_<COLOR>_<SIZE> env (see lib/printful.js).
  tee_classic: {
    name: 'Custom tee — Bella + Canvas 3001',
    description: 'Your purchased design printed on a premium Bella + Canvas 3001 tee.',
    price_cents: 2899,
    apparel: true,
  },
};

function productIds() {
  return Object.keys(PRODUCTS);
}

module.exports = { PRODUCTS, productIds };
