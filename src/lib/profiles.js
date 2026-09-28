// Profile tables (artist_profiles, shop_profiles) use user_id as their primary
// key and have NO id column, so db.insert()/db.upsert() — which always add an
// id — crash on them with SQLITE_ERROR. Use this helper for every write to
// those tables.
const db = require('../db');

async function upsertProfile(table, userId, data) {
  if (table !== 'artist_profiles' && table !== 'shop_profiles') {
    throw new Error('upsertProfile: unknown table ' + table);
  }
  const existing = await db.get(`SELECT user_id FROM ${table} WHERE user_id = ?`, [userId]);
  if (existing) {
    if (Object.keys(data).length) await db.updateWhere(table, data, 'user_id', userId);
    return;
  }
  const keys = Object.keys(data);
  const cols = ['user_id', ...keys, 'created_at'];
  const vals = [userId, ...keys.map((k) => data[k]), db.now()];
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
}

module.exports = { upsertProfile };
