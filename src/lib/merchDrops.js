// Merch Drops — Hearts -> Merch Drops watcher (owner order 2026-10-28,
// Bundle C Build 4).
//
// WHAT THIS IS: when a gallery design earns enough SIGNED-IN hearts, it
// becomes a CANDIDATE for a merch drop of that design — a tee/print of
// the art people already proved they want. This module is the threshold
// watcher + the owner queue data behind GET /admin/merch-drops. It
// flags candidates and nothing more.
//
// THE SIGNAL (ground truth, src/routes/api.js + migration 055):
//   gallery hearts are design_likes rows. A SIGNED-IN heart is a row
//   whose voter_key is 'user:<user_id>'; a guest heart is
//   'guest:<uuid>' and does NOT count for this signal — owner rule:
//   signed-in hearts move the count (a couple of thousand hearts is the
//   yardstick for a merch decision, and that yardstick is measured in
//   people who cared enough to sign in). design_like_counts holds the
//   public total (all voters); it is read here only as context
//   (total_hearts), never as the signal.
//   Little Inkers hearts live in lil_likes / lil_like_counts
//   (migration 101) — a SEPARATE table this module NEVER reads or
//   mixes in. Merch-product hearts (merch_likes, migration 100) are
//   typed favorites for existing products, also not this signal: this
//   build is DESIGN hearts -> merch drops of that design.
//
// NOTHING AUTO-PUBLISHES, EVER: a scan inserts status 'candidate'
// only. It never auto-approves, and it never touches a row that is
// already in the queue (candidate / approved / dismissed / prepped) —
// an owner's dismissal or approval can never be resurrected or reset
// by a re-run. Publishing a drop runs the HANDOFF_CHECKLIST below, and
// its owner mockup-approval step is THE GATE: no mockup approval, no
// catalog entry, no drop.
//
// RUNNING IT: a callable lib function (scanForCandidates) plus a small
// CLI guard at the bottom (`node src/lib/merchDrops.js`) so a cron can
// call it later. No cron/schedule is created by this build.
const db = require('../db');

// ---- the yardstick (config) ------------------------------------------
// "A couple thousand hearts is the working yardstick" (owner rule) —
// measured in SIGNED-IN hearts only.
const CANDIDATE_THRESHOLD = 2000;
// The NEAR band: at or over this fraction of the threshold a design is
// "climbing" — shown on the owner queue for information, never flagged
// as a candidate by the scan.
const NEAR_FRACTION = 0.5;
const NEAR_THRESHOLD = Math.floor(CANDIDATE_THRESHOLD * NEAR_FRACTION);

// The only voter_key prefix that counts for this signal.
const SIGNED_IN_VOTER_PREFIX = 'user:';
const SIGNED_IN_VOTER_LIKE = 'user:%';

// Candidate lifecycle (migration 116). The scan only ever writes
// 'candidate'; every later status is a human (owner) decision.
const STATUSES = ['candidate', 'approved', 'dismissed', 'prepped'];

// ---- candidate -> Printful-prep handoff checklist --------------------
// Exported data, rendered per candidate on the owner queue. The owner
// mockup-approval step is the gate — nothing publishes without it.
const HANDOFF_CHECKLIST = [
  {
    key: 'clean_print_file_prep',
    label: 'Clean print file prep — full-resolution, print-ready file prepared from the design (no watermark, correct size/DPI for the product)',
    gate: false,
  },
  {
    key: 'mockup_built',
    label: 'Mockup built — Printful draft/mockup created for the product (draft only, nothing published)',
    gate: false,
  },
  {
    key: 'owner_mockup_approval',
    label: 'OWNER mockup approval — THE GATE: the owner approves the mockup personally. Nothing publishes without it.',
    gate: true,
  },
  {
    key: 'catalog_entry_drafted',
    label: 'Catalog entry drafted — merch catalog entry written up as a draft (price, product, design art) for review',
    gate: false,
  },
  {
    key: 'owner_final_go',
    label: 'Owner final go — the owner gives the final go before the drop goes live; only then does anything publish',
    gate: true,
  },
];

function bandFor(signedInHearts) {
  const n = Number(signedInHearts) || 0;
  if (n >= CANDIDATE_THRESHOLD) return 'candidate';
  if (n >= NEAR_THRESHOLD) return 'climbing';
  return 'below';
}

function meetsThreshold(signedInHearts) {
  return (Number(signedInHearts) || 0) >= CANDIDATE_THRESHOLD;
}

// ---- counting ----------------------------------------------------------
// Per-design SIGNED-IN heart counts, straight from design_likes with
// the 'user:%' voter_key filter. total_hearts is the all-voter count
// from the same table (context only). lil_likes is never read here.
// The SQL is exported as a constant so tests can pin its shape: the
// signed-in filter must never quietly fall off this query.
const SIGNED_IN_COUNTS_SQL = `
  SELECT dl.design_id AS design_id,
         d.title AS title,
         COUNT(*) AS signed_in_hearts,
         (SELECT COUNT(*) FROM design_likes dl2
           WHERE dl2.design_id = dl.design_id) AS total_hearts
    FROM design_likes dl
    LEFT JOIN designs d ON d.id = dl.design_id
   WHERE dl.voter_key LIKE 'user:%'
   GROUP BY dl.design_id, d.title
   ORDER BY signed_in_hearts DESC, dl.design_id ASC`;

async function signedInHeartCounts({ limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  const rows = await db.all(lim ? `${SIGNED_IN_COUNTS_SQL} LIMIT ${lim}` : SIGNED_IN_COUNTS_SQL);
  return rows.map((r) => ({
    design_id: r.design_id,
    title: r.title || null,
    signed_in_hearts: Number(r.signed_in_hearts) || 0,
    total_hearts: Number(r.total_hearts) || 0,
    band: bandFor(r.signed_in_hearts),
  }));
}

// The current landscape: top designs by signed-in hearts, whatever
// band they sit in — the owner queue shows this even below threshold
// so the real distance to the yardstick is always visible.
async function topSignedInDesigns(limit = 10) {
  return signedInHeartCounts({ limit });
}

// ---- the scan ----------------------------------------------------------
// One watcher pass: every design at/over CANDIDATE_THRESHOLD that is
// not already in merch_drop_candidates gets ONE row, status
// 'candidate'. Existing rows are never touched (ON CONFLICT DO
// NOTHING) — a dismissed design stays dismissed, an approved one stays
// approved, and a re-run flags nothing twice. Idempotent by
// construction (design_id is UNIQUE in migration 116).
async function scanForCandidates(nowMs = Date.now()) {
  const counts = await signedInHeartCounts();
  const over = counts.filter((c) => meetsThreshold(c.signed_in_hearts));
  let flagged = 0;
  let alreadyQueued = 0;
  const flaggedDesigns = [];
  for (const c of over) {
    const res = await db.query(
      `INSERT INTO merch_drop_candidates
         (id, design_id, signed_in_hearts, total_hearts, status, first_flagged_at, updated_at, owner_note)
       VALUES (?, ?, ?, ?, 'candidate', ?, ?, NULL)
       ON CONFLICT(design_id) DO NOTHING`,
      [db.newId(), c.design_id, c.signed_in_hearts, c.total_hearts, nowMs, nowMs]);
    if (res && res.changes) { flagged += 1; flaggedDesigns.push(c.design_id); }
    else alreadyQueued += 1;
  }
  return {
    ran_at: new Date(nowMs).toISOString(),
    threshold: CANDIDATE_THRESHOLD,
    designs_with_signed_in_hearts: counts.length,
    over_threshold: over.length,
    flagged_new: flagged,
    already_queued: alreadyQueued,
    flagged_designs: flaggedDesigns,
  };
}

// ---- the owner queue ---------------------------------------------------
async function listCandidates() {
  const rows = await db.all(
    `SELECT c.id, c.design_id, c.signed_in_hearts, c.total_hearts, c.status,
            c.first_flagged_at, c.updated_at, c.owner_note,
            d.title AS title, d.linework_path AS linework_path, d.color_path AS color_path
       FROM merch_drop_candidates c
       LEFT JOIN designs d ON d.id = c.design_id
      ORDER BY c.signed_in_hearts DESC, c.first_flagged_at ASC`);
  return rows.map((r) => ({
    ...r,
    signed_in_hearts: Number(r.signed_in_hearts) || 0,
    total_hearts: Number(r.total_hearts) || 0,
  }));
}

// Owner status flip (approve / dismiss / prepped) for the queue's POST
// routes. Only the four known statuses are writable, and this is the
// ONLY writer of a non-'candidate' status — the scan never sets one.
async function setCandidateStatus(id, status, ownerNote) {
  if (!STATUSES.includes(status)) return false;
  const row = await db.get('SELECT id FROM merch_drop_candidates WHERE id = ?', [id]);
  if (!row) return false;
  const data = { status, updated_at: db.now() };
  if (typeof ownerNote === 'string') data.owner_note = ownerNote.slice(0, 1000) || null;
  await db.update('merch_drop_candidates', id, data);
  return true;
}

module.exports = {
  CANDIDATE_THRESHOLD,
  NEAR_FRACTION,
  NEAR_THRESHOLD,
  SIGNED_IN_VOTER_PREFIX,
  SIGNED_IN_VOTER_LIKE,
  STATUSES,
  HANDOFF_CHECKLIST,
  SIGNED_IN_COUNTS_SQL,
  bandFor,
  meetsThreshold,
  signedInHeartCounts,
  topSignedInDesigns,
  scanForCandidates,
  listCandidates,
  setCandidateStatus,
};

// CLI guard: `node src/lib/merchDrops.js` runs one scan against the
// configured database (DATABASE_URL -> Postgres, otherwise the local
// SQLite file) so a cron can call it later. No schedule is created
// here. Prints the scan summary as JSON and exits.
if (require.main === module) {
  (async () => {
    const { migrate } = require('../db/migrate');
    await migrate(); // migrate() inits the db layer itself
    const result = await scanForCandidates();
    console.log(JSON.stringify(result, null, 2));
    await db.close();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
