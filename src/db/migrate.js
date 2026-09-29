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
  // Column-level repair (2026-09-29): a past deploy recorded migrations 017/020
  // as applied without their ADD COLUMNs taking effect (tracker rows present,
  // orders.fee_cents missing). Ensure the columns exist before serving
  // traffic; the ADD is skipped when the column is already there. Done in code
  // (like the tracker repair above), not in a migration file.
  const REQUIRED_COLUMNS = [
    ['orders', 'fee_cents', 'BIGINT NOT NULL DEFAULT 0'],
    ['orders', 'linework_only', 'BIGINT NOT NULL DEFAULT 0'],
    ['credit_topups', 'fee_cents', 'BIGINT NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, ddl] of REQUIRED_COLUMNS) {
    let exists = false;
    let tableExists = false;
    if (mode === 'pg') {
      const t = await db.query('SELECT 1 FROM information_schema.tables WHERE table_name = ?', [table]);
      tableExists = t.rows.length > 0;
      if (tableExists) {
        const r = await db.query(
          'SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
          [table, column]
        );
        exists = r.rows.length > 0;
      }
    } else {
      const t = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
      tableExists = t.length > 0;
      if (tableExists) {
        // NOTE: `PRAGMA table_info(x)` cannot be read through db.all — the
        // query wrapper only treats SELECT/WITH as reads, so it returns [].
        // Use the table-valued pragma function instead, which is a SELECT.
        const cols = await db.all('SELECT name FROM pragma_table_info(?)', [table]);
        exists = cols.some((c) => c.name === column);
      }
    }
    if (tableExists && !exists) {
      const add = mode === 'pg' ? 'ADD COLUMN IF NOT EXISTS ' : 'ADD COLUMN ';
      await db.query(`ALTER TABLE ${table} ${add}${column} ${ddl}`);
      console.log(`repaired missing column ${table}.${column}`);
    }
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
      // Only guard plain ADD COLUMN: a migration that already says
      // ADD COLUMN IF NOT EXISTS must pass through untouched, or the
      // replace below would double it into "... IF NOT EXISTS IF NOT
      // EXISTS ..." which Postgres rejects with a syntax error.
      // (2026-09-29: this exact double-apply broke Render deploy of 038.)
      if (mode === 'pg') stmt = stmt.replace(/ADD COLUMN (?!IF NOT EXISTS )/g, 'ADD COLUMN IF NOT EXISTS ');
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
