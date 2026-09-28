// Applies pending SQL migrations in filename order, tracking in `migrations`.
const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  await db.init();
  // Ensure the tracking table exists even if the migration file list changes.
  await db.query(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);

  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.all('SELECT id FROM migrations')).map((r) => r.id));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // Split on semicolons at line ends; the migration files are simple DDL.
    const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
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
