// Merch Drops tests (Hearts -> Merch Drops, 2026-10-28, Bundle C Build 4).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the build's load-bearing rules:
//  - the yardstick is config: CANDIDATE_THRESHOLD = 2000 SIGNED-IN
//    hearts, NEAR band at 50% ("climbing").
//  - the scan counts ONLY design_likes rows with voter_key LIKE
//    'user:%' — guest hearts ('guest:<uuid>') never move the signal,
//    and Little Inkers hearts (lil_likes) are never read or mixed in.
//  - the candidate upsert is idempotent and never touches a row that
//    is already queued/approved/dismissed: a dismissal survives a
//    re-scan, and the scan never writes a non-'candidate' status.
//  - the Printful-prep handoff checklist is exported with the OWNER
//    mockup-approval gate step present (nothing publishes without it).
const { randomUUID } = require('crypto');

// Chunked multi-row like seeding (design_likes has no id column, so
// db.insert — which mints one — cannot be used for it).
async function seedLikes(db, designId, prefix, n, ts) {
  const CHUNK = 250;
  for (let off = 0; off < n; off += CHUNK) {
    const m = Math.min(CHUNK, n - off);
    const vals = [];
    const params = [];
    for (let i = 0; i < m; i++) {
      vals.push('(?, ?, ?)');
      params.push(designId, `${prefix}md-${designId}-${off + i}`, ts);
    }
    await db.query(
      `INSERT INTO design_likes (design_id, voter_key, created_at) VALUES ${vals.join(', ')}`, params);
  }
}

async function runDbTests(ok) {
  console.log('merch drops (threshold watcher):');
  const md = require('../src/lib/merchDrops');
  const db = require('../src/db');
  const now = Date.now();

  // Config: the yardstick and the near band.
  ok(md.CANDIDATE_THRESHOLD === 2000, 'candidate threshold = 2000 signed-in hearts');
  ok(md.NEAR_THRESHOLD === 1000 && md.NEAR_FRACTION === 0.5, 'near band = 50% of threshold (1000, "climbing")');
  ok(md.meetsThreshold(2000) === true && md.meetsThreshold(1999) === false, 'meetsThreshold is exact at 2000');
  ok(md.bandFor(2000) === 'candidate' && md.bandFor(1000) === 'climbing' && md.bandFor(999) === 'below',
    'bands: >=2000 candidate, >=1000 climbing, below otherwise');

  // The counting query's shape: signed-in filter present, the LI table
  // never named. (The seeded rows below prove the semantics; this pins
  // the SQL so the filter cannot quietly fall off in an edit.)
  ok(/FROM design_likes/.test(md.SIGNED_IN_COUNTS_SQL), 'counting query reads design_likes');
  ok(md.SIGNED_IN_COUNTS_SQL.includes("voter_key LIKE 'user:%'"), "counting query filters voter_key LIKE 'user:%' (signed-in only)");
  ok(!/lil_likes|lil_like_counts/.test(md.SIGNED_IN_COUNTS_SQL), 'counting query never touches the Little Inkers tables');
  ok(!/merch_likes/.test(md.SIGNED_IN_COUNTS_SQL), 'counting query never touches merch_likes (this signal is design hearts)');

  // Checklist: five steps, the owner mockup-approval gate among them.
  ok(Array.isArray(md.HANDOFF_CHECKLIST) && md.HANDOFF_CHECKLIST.length === 5, 'handoff checklist exported (5 steps)');
  const gate = md.HANDOFF_CHECKLIST.find((s) => s.key === 'owner_mockup_approval');
  ok(!!gate && gate.gate === true && /OWNER mockup approval/.test(gate.label) && /Nothing publishes without it/.test(gate.label),
    'checklist carries the OWNER mockup-approval gate step (nothing publishes without it)');
  ok(md.HANDOFF_CHECKLIST[0].key === 'clean_print_file_prep' && md.HANDOFF_CHECKLIST[1].key === 'mockup_built'
    && md.HANDOFF_CHECKLIST[3].key === 'catalog_entry_drafted' && md.HANDOFF_CHECKLIST[4].key === 'owner_final_go',
    'checklist order: print prep -> mockup -> (gate) -> catalog draft -> owner final go');

  // Fixtures: three designs.
  //  hero     — exactly 2000 signed-in + 5000 guest hearts: candidate.
  //             total_hearts context must read 7000 while the SIGNAL
  //             reads exactly 2000.
  //  climbing — 1000 signed-in + 3000 guest hearts, plus LI decoy rows
  //             keyed by its id: climbing band, never a candidate, and
  //             the decoys must not move its count by one.
  //  guesty   — 2500 guest hearts and zero signed-in: over the numeric
  //             yardstick in guests alone, still NOT a candidate and
  //             absent from the signed-in counts entirely.
  const hero = 'md-hero-' + randomUUID().slice(0, 8);
  const climbing = 'md-climb-' + randomUUID().slice(0, 8);
  const guesty = 'md-guest-' + randomUUID().slice(0, 8);
  for (const [id, title] of [[hero, 'MD Hero'], [climbing, 'MD Climbing'], [guesty, 'MD Guesty']]) {
    await db.insert('designs', { id, title, status: 'approved', created_at: now });
  }
  await seedLikes(db, hero, 'user:', md.CANDIDATE_THRESHOLD, now);
  await seedLikes(db, hero, 'guest:', 5000, now);
  await seedLikes(db, climbing, 'user:', md.NEAR_THRESHOLD, now);
  await seedLikes(db, climbing, 'guest:', 3000, now);
  await seedLikes(db, guesty, 'guest:', 2500, now);
  // LI decoys: rows in lil_likes keyed by the climbing design's id,
  // with signed-in-shaped voter keys — a reader of the wrong table
  // would see 300 extra "hearts". This watcher must not.
  {
    const vals = [];
    const params = [];
    for (let i = 0; i < 300; i++) { vals.push('(?, ?, ?)'); params.push(climbing, `user:md-lil-decoy-${i}`, now); }
    await db.query(`INSERT INTO lil_likes (page_key, voter_key, created_at) VALUES ${vals.join(', ')}`, params);
  }

  const counts = await md.signedInHeartCounts();
  const byId = Object.fromEntries(counts.map((c) => [c.design_id, c]));
  ok(byId[hero] && byId[hero].signed_in_hearts === 2000, 'hero: signed-in count is exactly 2000 (guest hearts excluded)');
  ok(byId[hero] && byId[hero].total_hearts === 7000, 'hero: total_hearts context counts all voters (2000 + 5000 guests)');
  ok(byId[hero] && byId[hero].band === 'candidate', 'hero: band = candidate at the threshold');
  ok(byId[climbing] && byId[climbing].signed_in_hearts === 1000, 'climbing: signed-in count is 1000 — LI decoy rows never read');
  ok(byId[climbing] && byId[climbing].band === 'climbing', 'climbing: band = climbing at 50% of threshold');
  ok(!byId[guesty], 'guesty: 2500 guest hearts alone never appear in the signed-in counts');
  const top = await md.topSignedInDesigns(10);
  ok(top[0] && top[0].design_id === hero, 'top signed-in list ranks the hero first');

  // The scan: only the hero is flagged, as a bare candidate.
  const scan1 = await md.scanForCandidates(now);
  ok(scan1.flagged_new === 1 && scan1.over_threshold === 1 && scan1.flagged_designs.includes(hero),
    'scan flags exactly the at-threshold design');
  let cands = await md.listCandidates();
  ok(cands.length === 1 && cands[0].design_id === hero && cands[0].status === 'candidate',
    "candidate row exists with status 'candidate' (never auto-approved)");
  ok(cands[0].signed_in_hearts === 2000 && cands[0].total_hearts === 7000,
    'candidate row stores the signed-in signal and the all-voter total');

  // Idempotent re-run: nothing new, nothing duplicated, nothing reset.
  const scan2 = await md.scanForCandidates(now);
  ok(scan2.flagged_new === 0 && scan2.already_queued === 1, 're-scan flags nothing new (idempotent)');
  cands = await md.listCandidates();
  ok(cands.length === 1, 're-scan leaves exactly one candidate row');

  // An owner dismissal survives every later scan — the watcher never
  // resurrects or resets a row a human already decided.
  const candId = cands[0].id;
  ok(await md.setCandidateStatus(candId, 'dismissed') === true, 'owner dismiss writes the dismissed status');
  ok(await md.setCandidateStatus(candId, 'published') === false, 'a non-lifecycle status is refused (nothing auto-publishes)');
  const scan3 = await md.scanForCandidates(now);
  ok(scan3.flagged_new === 0, 'scan after dismissal flags nothing new');
  cands = await md.listCandidates();
  ok(cands.length === 1 && cands[0].status === 'dismissed', 'dismissed candidate stays dismissed after re-scan');

  // Cleanup: the shared temp DB returns to its pre-test contents.
  await db.query('DELETE FROM merch_drop_candidates WHERE design_id IN (?, ?, ?)', [hero, climbing, guesty]);
  await db.query('DELETE FROM design_likes WHERE design_id IN (?, ?, ?)', [hero, climbing, guesty]);
  await db.query('DELETE FROM lil_likes WHERE page_key = ?', [climbing]);
  await db.query('DELETE FROM designs WHERE id IN (?, ?, ?)', [hero, climbing, guesty]);
}

// ---- HTTP tests (against the spawned server, same temp DB) ----
async function runHttpTests(ok, req, areq) {
  console.log('merch drops (owner queue):');
  if (typeof areq !== 'function') { ok(false, 'areq (admin client) provided by the suite'); return; }
  const md = require('../src/lib/merchDrops');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);
  const now = Date.now();
  const hero = 'md-http-' + randomUUID().slice(0, 8);
  tdb.prepare(`INSERT INTO designs (id, title, status, created_at) VALUES (?, ?, 'approved', ?)`)
    .run(hero, 'MD HTTP Hero', now);
  const likeIns = tdb.prepare('INSERT INTO design_likes (design_id, voter_key, created_at) VALUES (?, ?, ?)');
  const seedMany = tdb.transaction((prefix, n) => {
    for (let i = 0; i < n; i++) likeIns.run(hero, `${prefix}md-http-${i}`, now);
  });
  seedMany('user:', md.CANDIDATE_THRESHOLD);
  seedMany('guest:', 25);

  // The queue is admin-only: an anonymous hit bounces to login.
  // Cookieless raw fetch: the shared `req` jar may hold a non-admin
  // session from earlier suites, which would mask the anonymous path.
  let anonStatus = 0; let anonLoc = '';
  if (process.env.BASE_URL) {
    const af = await fetch(`${process.env.BASE_URL}/admin/merch-drops`, { redirect: 'manual' });
    anonStatus = af.status; anonLoc = af.headers.get('location') || '';
  } else {
    const rr = await req('GET', '/admin/merch-drops', { follow: false });
    anonStatus = rr.status; anonLoc = rr.location || '';
  }
  ok(anonStatus === 302 && anonLoc.includes('/login'), 'merch-drops queue requires an admin login');
  let r;

  // Admin view: the scan on view flags the hero; the page carries the
  // candidate, its signed-in count vs the threshold, and the checklist
  // with its owner-approval gate.
  r = await areq('GET', '/admin/merch-drops');
  ok(r.status === 200 && r.text.includes('Merch drops'), 'admin merch-drops page renders');
  ok(r.text.includes('MD HTTP Hero') && r.text.includes(hero), 'queue lists the flagged design by title + id');
  ok(r.text.includes('2000'), 'queue shows the signed-in count / 2000 yardstick');
  ok(r.text.includes('OWNER mockup approval') && r.text.includes('Clean print file prep'),
    'queue renders the handoff checklist incl. the owner mockup-approval gate');
  ok(r.text.includes('Top hearted designs'), 'queue shows the top-hearted landscape section');

  const cand = tdb.prepare('SELECT id, status FROM merch_drop_candidates WHERE design_id = ?').get(hero);
  ok(!!cand && cand.status === 'candidate', 'viewing the queue flagged the hero as a candidate (scan on view)');

  // Approve POST follows the neighboring admin pattern and flips only
  // the queue status — the design itself is untouched, nothing goes
  // live.
  r = await areq('POST', `/admin/merch-drops/${cand.id}/approve`, { body: { website: '' } });
  ok(r.status === 302 && (r.location || '').includes('/admin/merch-drops'), 'approve POST redirects back to the queue');
  const after = tdb.prepare('SELECT status FROM merch_drop_candidates WHERE id = ?').get(cand.id);
  ok(after && after.status === 'approved', 'approve POST sets the candidate status to approved');

  tdb.prepare('DELETE FROM merch_drop_candidates WHERE design_id = ?').run(hero);
  tdb.prepare('DELETE FROM design_likes WHERE design_id = ?').run(hero);
  tdb.prepare('DELETE FROM designs WHERE id = ?').run(hero);
  tdb.close();
}

module.exports = { runDbTests, runHttpTests };
