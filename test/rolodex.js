// Affiliate Rolodex plug tests (Slice 2, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
async function runHttpTests(ok, req) {
  console.log('rolodex (affiliate plug):');
  const get = async (p) => {
    const r = await req('GET', p);
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) {}
    return { status: r.status, json };
  };

  // Full list: live entries only, each carrying link + code + disclosure
  // together (the disclosure lock — no bare links, ever).
  const all = await get('/api/rolodex');
  ok(all.status === 200 && all.json && all.json.ok === true, 'rolodex endpoint responds ok');
  const programs = (all.json && all.json.programs) || [];
  ok(programs.length > 0, 'rolodex returns programs');
  ok(all.json && all.json.count === programs.length, 'rolodex count matches programs');
  ok(programs.every((p) => p.status === 'live'), 'rolodex returns live entries only');
  ok(programs.every((p) => 'link' in p && 'code' in p
    && typeof p.disclosure === 'string' && p.disclosure.length > 0),
    'every entry carries link + code + disclosure (disclosure lock)');
  const names = programs.map((p) => p.name);
  ok(names.includes('Printful'), 'newly-live program (Printful, link landed 2026-10-26) is served');
  ok(!names.includes('Libro.fm'), 'pending program (Libro.fm) stays out');
  ok(!names.includes('FlexOffers'), 'closed program (FlexOffers) stays out');

  // ?all=1 is NOT a public mode: non-live entries stay out regardless.
  const allFlag = await get('/api/rolodex?all=1');
  const allFlagNames = ((allFlag.json && allFlag.json.programs) || []).map((p) => p.name);
  ok(allFlag.status === 200 && !allFlagNames.includes('Libro.fm')
    && (allFlag.json.programs || []).every((p) => p.status === 'live'),
    '?all=1 does not leak non-live entries');

  // By name: one live program, returned whole.
  const one = await get('/api/rolodex?name=' + encodeURIComponent('Base Labs'));
  ok(one.status === 200 && one.json.program && one.json.program.name === 'Base Labs'
    && one.json.program.link === 'https://baselabs.is/?coupon=TAC20'
    && one.json.program.code === 'TAC20'
    && typeof one.json.program.disclosure === 'string' && one.json.program.disclosure.length > 0,
    '?name= returns the single live program whole (link + code + disclosure)');
  const notLive = await get('/api/rolodex?name=' + encodeURIComponent('Libro.fm'));
  ok(notLive.status === 404, '?name= for a non-live program is 404');
  const printful = await get('/api/rolodex?name=' + encodeURIComponent('Printful'));
  ok(printful.status === 200 && printful.json.program
    && printful.json.program.link === 'https://www.printful.com/a/15336743:69c9790aca714659403c1efc4041d4a4'
    && typeof printful.json.program.disclosure === 'string' && printful.json.program.disclosure.length > 0,
    '?name=Printful returns the live program whole (link + disclosure)');
  const missing = await get('/api/rolodex?name=' + encodeURIComponent('No Such Program'));
  ok(missing.status === 404, '?name= for an unknown program is 404');

  // Kid-safe pull: kid-safe entries only — structurally no tattoo programs.
  const kids = await get('/api/rolodex?kid_safe=1');
  const kidPrograms = (kids.json && kids.json.programs) || [];
  ok(kidPrograms.length > 0, 'kid_safe=1 returns programs');
  ok(kidPrograms.every((p) => p.kid_safe === true && p.status === 'live'),
    'kid_safe=1 returns live kid-safe programs only');
  const tattooPrograms = ['Base Labs', 'Electrum Supply', 'DrTattooSkin', 'Recovery Aftercare',
    'Monsters Ink', 'CNC Tattoo', 'EZ Tattoo Supply'];
  ok(!kidPrograms.some((p) => tattooPrograms.includes(p.name)),
    'kid_safe=1 excludes every tattoo program');
  ok(kidPrograms.some((p) => p.name === 'Leda Art Supply'),
    'kid_safe=1 includes Leda Art Supply');

  // Surface pull: filters by surfaces_placed.
  const surf = await get('/api/rolodex?surface=' + encodeURIComponent('/merch'));
  const surfPrograms = (surf.json && surf.json.programs) || [];
  ok(surfPrograms.length > 0
    && surfPrograms.every((p) => (p.surfaces_placed || [])
      .some((s) => String(s).toLowerCase().includes('/merch'))),
    '?surface= filters by surfaces_placed');
  ok(surfPrograms.some((p) => p.name === 'Base Labs'), '?surface=/merch includes Base Labs');

  // The proof consumer: /api/app-links keeps its exact shape and set, with
  // URLs now derived from the rolodex.
  const appLinks = await get('/api/app-links');
  const affs = appLinks.json && appLinks.json.links && appLinks.json.links.affiliates;
  ok(Array.isArray(affs) && affs.length === 7, 'app-links still carries the 7-entry affiliate set');
  ok(!!affs && affs.every((a) => a.id && a.name && a.url),
    'app-links affiliate entries keep the {id, name, url} shape');
  ok(!!affs && affs.map((a) => a.id).join(',')
    === 'baselabs,electrum,drtattooskin,recovery,leda,amazon,monstersink',
    'app-links affiliate ids and order unchanged');
  const base = affs && affs.find((a) => a.id === 'baselabs');
  ok(!!base && base.url === 'https://baselabs.is/?coupon=TAC20',
    'app-links Base Labs URL derives from the rolodex');
  const amz = affs && affs.find((a) => a.id === 'amazon');
  ok(!!amz && amz.url === 'https://www.amazon.com/?tag=tattooartcust-20',
    'app-links Amazon URL derives from the rolodex tag (code)');
  ok(!!affs && !affs.some((a) => /cnctattoo/i.test(a.url)),
    'shop-gated CNC never appears in app-links');
}

module.exports = { runHttpTests };
