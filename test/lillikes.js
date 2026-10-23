// Little Inkers hearts tests ([lilhearts], migration 101).
// The coordinator (test/run.js) wires this in; do not run from here.
const { randomUUID } = require('crypto');

async function runHttpTests(ok, req) {
  console.log('lillikes (Little Inkers hearts):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);

  // Plain client (no auth on the LI side; mirrors the suite's helpers).
  async function creq(method, p, { body, headers = {} } = {}) {
    const res = await fetch(`http://localhost:4137${p}`, { method, headers, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  }
  const jpost = (p, obj) => creq('POST', p, {
    body: JSON.stringify(obj || {}), headers: { 'content-type': 'application/json' },
  });
  const jdel = (p, obj) => creq('DELETE', p, {
    body: JSON.stringify(obj || {}), headers: { 'content-type': 'application/json' },
  });
  const enc = encodeURIComponent;

  const v1 = randomUUID();
  const v2 = randomUUID();
  const appKey = 'app:penguin';
  const bundleKey = 'bundle:2026-W42:fox';
  const coloringKey = 'coloring:page_penguin';

  // Like on an app page: count 1, dedupe on repeat, second voter -> 2.
  let r = await jpost('/api/little-inkers/likes/' + enc(appKey), { voter: v1 });
  ok(r.status === 200 && r.json && r.json.liked === true && r.json.like_count === 1 && r.json.page_key === appKey,
    'LI like -> 200, count 1');
  r = await jpost('/api/little-inkers/likes/' + enc(appKey), { voter: v1 });
  ok(r.status === 200 && r.json.like_count === 1, 'repeat LI like from same voter dedupes');
  r = await jpost('/api/little-inkers/likes/' + enc(appKey), { voter: v2 });
  ok(r.status === 200 && r.json.like_count === 2, 'second LI voter increments to 2');

  // The voter_key spelling is accepted too (same shape as design likes).
  r = await jpost('/api/little-inkers/likes/' + enc(coloringKey), { voter_key: v1 });
  ok(r.status === 200 && r.json.like_count === 1, 'coloring: key likes; voter_key body accepted');

  // Bundle keys carry their week and count separately from app keys.
  r = await jpost('/api/little-inkers/likes/' + enc(bundleKey), { voter: v1 });
  ok(r.status === 200 && r.json.like_count === 1, 'bundle: key counts separately');

  // Unlike decrements and floors at the true count.
  r = await jdel('/api/little-inkers/likes/' + enc(appKey), { voter: v1 });
  ok(r.status === 200 && r.json.liked === false && r.json.like_count === 1, 'LI unlike decrements to 1');
  r = await jdel('/api/little-inkers/likes/' + enc(appKey), { voter: v1 });
  ok(r.status === 200 && r.json.like_count === 1, 'repeat LI unlike does not go below true count');

  // Validation: bad page keys and bad/missing voters are 400s.
  r = await jpost('/api/little-inkers/likes/' + enc('penguin'), { voter: v1 });
  ok(r.status === 400, 'unprefixed page_key -> 400');
  r = await jpost('/api/little-inkers/likes/' + enc('design:some-design'), { voter: v1 });
  ok(r.status === 400, 'design: prefix is not an LI key -> 400');
  r = await jpost('/api/little-inkers/likes/' + enc('bundle:fox'), { voter: v1 });
  ok(r.status === 400, 'bundle key without week -> 400');
  r = await jpost('/api/little-inkers/likes/' + enc('app:'), { voter: v1 });
  ok(r.status === 400, 'empty slug -> 400');
  r = await jpost('/api/little-inkers/likes/' + enc(appKey), {});
  ok(r.status === 400, 'missing voter -> 400');
  r = await jpost('/api/little-inkers/likes/' + enc(appKey), { voter: 'x' });
  ok(r.status === 400, 'junk voter -> 400');

  // The counts live in the LI tables only — no bleed into the design or
  // merch tallies, and the rollup matches the raw votes.
  const lilRow = tdb.prepare('SELECT like_count FROM lil_like_counts WHERE page_key = ?').get(appKey);
  ok(lilRow && lilRow.like_count === 1, 'rollup row sits in lil_like_counts');
  const bleedDesign = tdb.prepare('SELECT COUNT(*) AS n FROM design_like_counts WHERE design_id = ?').get(appKey);
  const bleedMerch = tdb.prepare('SELECT COUNT(*) AS n FROM merch_like_counts WHERE merch_id = ?').get(appKey);
  ok(bleedDesign.n === 0 && bleedMerch.n === 0, 'LI hearts never touch design/merch counts');

  // Top-loved: LI pages only, most loved first, zero-count pages omitted.
  r = await jpost('/api/little-inkers/likes/' + enc(bundleKey), { voter: v2 });
  ok(r.status === 200 && r.json.like_count === 2, 'bundle page reaches 2 hearts');
  r = await creq('GET', '/api/little-inkers/top-loved');
  ok(r.status === 200 && r.json && Array.isArray(r.json.pages), 'LI top-loved responds');
  const keys = (r.json.pages || []).map((p) => p.page_key);
  ok(keys.indexOf(bundleKey) === 0 && keys.indexOf(appKey) > 0 && keys.indexOf(coloringKey) > 0,
    'LI top-loved ranks bundle(2) > app(1) = coloring(1)');
  ok(keys.every((k) => /^(app|bundle|coloring):/.test(k)), 'LI top-loved carries LI keys only');

  // limit clamps the list.
  r = await creq('GET', '/api/little-inkers/top-loved?limit=1');
  ok(r.status === 200 && r.json.pages.length === 1 && r.json.pages[0].page_key === bundleKey,
    'LI top-loved honors limit');

  tdb.close();
}

module.exports = { runHttpTests };
