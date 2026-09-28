// Print products + fulfillment provider hook.
//
// Fulfillment is manual in v1: paid print orders land in the admin print queue
// with the full-resolution file and the shipping address; the admin prints/ships
// (or forwards to a local print shop) and marks the order fulfilled.
//
// To plug in a print-on-demand API later (e.g. Printful), set PRINTFUL_API_KEY
// and implement submitToProvider() below — the order flow already collects
// everything a POD provider needs (file, product, quantity, address).
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
};

function productIds() {
  return Object.keys(PRODUCTS);
}

// Fulfillment provider selection. 'manual' until a POD API key is configured.
function fulfillmentProvider() {
  if (process.env.PRINTFUL_API_KEY) return 'printful';
  return 'manual';
}

// Future hook: submit a paid print order to the POD provider.
// Receives the print_orders row + absolute path of the print file.
async function submitToProvider(printOrder, fileAbsPath) {
  const provider = fulfillmentProvider();
  if (provider === 'manual') return { provider, external_id: null };
  throw new Error(`Fulfillment provider "${provider}" is not implemented yet.`);
}

module.exports = { PRODUCTS, productIds, fulfillmentProvider, submitToProvider };
