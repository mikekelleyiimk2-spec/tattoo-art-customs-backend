// Applies pending SQL migrations in filename order, tracking in `migrations`.
const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  await db.init();
  // Ensure the tracking table exists even if the migration file list changes.
  await db.query(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);

  const mode = db.getMode();
  // Repair the tracker itself before anything else: databases created by the
  // earliest deploys have migrations.applied_at as INTEGER, and the very
  // first tracker insert (a millisecond timestamp) overflowed it — so no
  // migration was ever recorded and every deploy re-runs from 001. This
  // ALTER is a harmless no-op when the column is already BIGINT.
  if (mode === 'pg') {
    await db.query('ALTER TABLE migrations ALTER COLUMN applied_at TYPE BIGINT');
  }
  const dir = path.join(__dirname, '..', '..', 'migrations');
  // `.pg.sql` migrations run on Postgres only (SQLite is dynamically typed:
  // its INTEGER already stores 64-bit values, and it lacks ALTER COLUMN).
  // `.sqlite.sql` is the mirror for symmetry.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).filter((f) => {
    if (f.endsWith('.pg.sql')) return mode === 'pg';
    if (f.endsWith('.sqlite.sql')) return mode === 'sqlite';
    return true;
  }).sort();
  const applied = new Set((await db.all('SELECT id FROM migrations')).map((r) => r.id));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // Split on semicolons at line ends; the migration files are simple DDL.
    const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (let stmt of statements) {
      // Tolerate re-running a migration whose DDL already applied (see the
      // tracker repair above): on Postgres, ADD COLUMN IF NOT EXISTS makes
      // the re-run a no-op instead of an error. SQLite keeps exact behavior.
      if (mode === 'pg') stmt = stmt.replace(/ADD COLUMN /g, 'ADD COLUMN IF NOT EXISTS ');
      await db.query(stmt);
    }
    await db.insert('migrations', { id: file, applied_at: db.now() });
    console.log(`applied migration ${file}`);
  }
}

if (require.main === module) {
  migrate().then(() => db.close()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { migrate };
