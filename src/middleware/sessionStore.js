// DB-backed session store for express-session.
// Works on both PostgreSQL and SQLite via the db abstraction.
const { Store } = require('express-session');
const db = require('../db');

class DbStore extends Store {
  constructor(options = {}) {
    super(options);
    this.ttlMs = options.ttlMs || 1000 * 60 * 60 * 24 * 14; // 14 days
  }
  async get(sid, cb) {
    try {
      const row = await db.get('SELECT data, expires_at FROM sessions WHERE id = ?', [sid]);
      if (!row || row.expires_at < Date.now()) {
        if (row) await db.query('DELETE FROM sessions WHERE id = ?', [sid]);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  async set(sid, session, cb) {
    try {
      const expires = Date.now() + (session.cookie?.maxAge || this.ttlMs);
      // NOTE: the cookie must be stored — express-session requires sess.cookie on load.
      const data = JSON.stringify(session);
      const existing = await db.get('SELECT id FROM sessions WHERE id = ?', [sid]);
      if (existing) {
        await db.query('UPDATE sessions SET user_id = ?, data = ?, expires_at = ? WHERE id = ?',
          [session.userId || '', data, expires, sid]);
      } else {
        await db.query('INSERT INTO sessions (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)',
          [sid, session.userId || '', data, expires]);
      }
      cb(null);
    } catch (e) { cb(e); }
  }
  async destroy(sid, cb) {
    try { await db.query('DELETE FROM sessions WHERE id = ?', [sid]); cb(null); }
    catch (e) { cb(e); }
  }
  async touch(sid, session, cb) { this.set(sid, session, cb); }
}

module.exports = { DbStore };
