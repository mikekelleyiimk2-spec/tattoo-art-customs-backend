// Merch catalog tests (owner directive 2026-10-08): extensible POD +
// affiliate product catalog on /merch. The coordinator (test/run.js) wires
// this in; do not run from here.
async function runDbTests(ok) {
  console.log('merch-catalog (db):');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  const cols = sdb.prepare('SELECT name FROM pragma_table_info(?)').all('print_orders').map((r) => r.name);
  ok(cols.includes('catalog_asset'), 'migration 063: print_orders has catalog_asset column');
  sdb.close();

  const catalog = require('../src/lib/merchCatalog');
  ok(Array.isArray(catalog.CATALOG) && catalog.CATALOG.length > 0, 'catalog has entries');
  ok(catalog.getProduct('baselabs-aftercare').kind === 'affiliate', 'Base Labs affiliate entry present');
  ok(catalog.getProduct('tee-music-genres').kind === 'pod', 'music genres POD entry present');
  ok(catalog.CATALOG.every((p) => p.id && p.nameKey && p.blurbKey && ['live', 'coming-soon'].includes(p.status)),
    'every entry has id, i18n keys, valid status');
}

async function runHttpTests(ok, req, areq) {
  console.log('merch-catalog (http):');
  const client = areq || req;
  // /merch renders with the affiliate + catalog sections.
  let r = await req('GET', '/merch');
  ok(r.status === 200, 'GET /merch 200');
  ok(r.text.includes('baselabs.is/?coupon=TAC20'), '/merch carries the Base Labs affiliate link');
  ok(r.text.includes('rel="noopener nofollow sponsored"'), 'affiliate link has sponsored rel');
  ok(r.text.includes('Music Genres Tee'), '/merch shows the music genres catalog product');
  ok(r.text.includes('Coming soon'), '/merch marks catalog products coming soon');

  // Catalog order routes degrade safely: coming-soon product -> redirect.
  // (Authenticated: requireLogin passes, product gate redirects to /merch.)
  r = await client('GET', '/merch/catalog/tee-music-genres');
  ok(r.status === 302 && (r.location || '').includes('/merch'), 'coming-soon catalog product redirects to /merch');
  r = await client('GET', '/merch/catalog/nope-not-real');
  ok(r.status === 302, 'unknown catalog product redirects');
  // Note: the requireLogin gate on catalog routes mirrors /merch/tee/:designId;
  // anon-redirect-to-login is covered by the shared auth tests, not repeated here.
}

module.exports = { runDbTests, runHttpTests };
