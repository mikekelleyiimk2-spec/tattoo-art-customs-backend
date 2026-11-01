// First Library Shelf (Brief #40) + OneMind command watchdog status
// door (Brief #39). The coordinator (test/run.js) wires this in; do
// not run from here.
//
// DB phase: the shelf catalog is seated — 5–10 public-domain titles,
// each with author, year, and a Project Gutenberg read link.
// HTTP phase: the Library front door (/dawnfold/library) serves and
// links the shelf; the shelf page (/dawnfold/library/first-shelf)
// serves with every title seated; the pre-rename door 301s; the
// watchdog status endpoint is service-token gated (401 without the
// token, 200 with it, recent-alerts shape present).

async function runDbTests(ok) {
  console.log('first library shelf (catalog):');
  const { FIRST_SHELF, firstShelf } = require('../src/lib/firstShelf');
  ok(FIRST_SHELF.length >= 5 && FIRST_SHELF.length <= 10,
    `first shelf seats 5-10 titles (seated: ${FIRST_SHELF.length})`);
  ok(FIRST_SHELF.every((t) => t.title && t.author && t.year && t.note),
    'every seated title carries title, author, year, and a shelf note');
  ok(FIRST_SHELF.every((t) => /^https:\/\/www\.gutenberg\.org\/ebooks\/\d+$/.test(t.readUrl)),
    'every seated title reads free at a Project Gutenberg ebook page');
  ok(new Set(FIRST_SHELF.map((t) => t.title)).size === FIRST_SHELF.length,
    'no duplicate titles on the shelf');
  ok(firstShelf().length === FIRST_SHELF.length && firstShelf() !== FIRST_SHELF,
    'firstShelf() hands out a copy of the catalog, not the register itself');
}

async function runHttpTests(ok, req) {
  console.log('first library shelf + watchdog status (HTTP):');
  let r = await req('GET', '/dawnfold/library');
  ok(r.status === 200, '/dawnfold/library (the Library front door) serves 200');
  ok(r.text.includes('The First Library Shelf') && r.text.includes('/dawnfold/library/first-shelf'),
    'the front door links the First Library Shelf');

  r = await req('GET', '/dawnfold/library/first-shelf');
  ok(r.status === 200, '/dawnfold/library/first-shelf serves 200');
  const { FIRST_SHELF } = require('../src/lib/firstShelf');
  for (const t of FIRST_SHELF) {
    ok(r.text.includes(t.title.replace(/’/g, '&#39;')) || r.text.includes(t.title),
      `shelf page seats: ${t.title}`);
  }
  ok(r.text.includes('/dawnfold/library'), 'the shelf page links back to the Library front door');

  r = await req('GET', '/the-big-one/library/first-shelf', { follow: false });
  ok(r.status === 301 && String(r.location || '').includes('/dawnfold/library/first-shelf'),
    'pre-rename door /the-big-one/library/first-shelf 301s to the Dawnfold shelf');

  // Watchdog status door: service-token gated like /api/onemind/ties.
  const PIPE = process.env.MUSE_SERVICE_TOKEN;
  const noTok = await fetch('http://localhost:4137/api/onemind/watchdog');
  ok(noTok.status === 401, '/api/onemind/watchdog refuses a missing service token (401)');
  const withTok = await fetch('http://localhost:4137/api/onemind/watchdog', {
    headers: { authorization: `Bearer ${PIPE}` },
  });
  const j = await withTok.json();
  ok(withTok.status === 200 && j.ok === true && Array.isArray(j.recent_alerts)
    && j.watchdog_ms > 0 && j.max_attempts >= 1,
    '/api/onemind/watchdog serves the watchdog status to the service token');
}

module.exports = { runDbTests, runHttpTests };
