// Database abstraction: PostgreSQL when DATABASE_URL is set, otherwise
// better-sqlite3 at SQLITE_PATH. One SQL dialect is used for both:
//   - TEXT primary keys generated in JS (no SERIAL/AUTOINCREMENT)
//   - INTEGER 0/1 for booleans, INTEGER unix-ms for timestamps
//   - money in INTEGER cents
// All queries use `?` placeholders; they are rewritten to $1,$2... for pg.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let mode = 'sqlite';
let pgPool = null;
let sqliteDb = null;

function placeholdersToPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function init() {
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: config.databaseUrl });
    await pgPool.query('SELECT 1');
    mode = 'pg';
  } else {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
    sqliteDb = new Database(config.sqlitePath);
    sqliteDb.pragma('journal_mode = WAL');
    mode = 'sqlite';
  }
  return mode;
}

function getMode() { return mode; }

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function now() { return Date.now(); }

// Returns { rows: [...] } in both modes.
async function query(sql, params = []) {
  if (mode === 'pg') {
    const res = await pgPool.query(placeholdersToPg(sql), params);
    return { rows: res.rows };
  }
  const stmt = sqliteDb.prepare(sql);
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
    return { rows: stmt.all(...params) };
  }
  const info = stmt.run(...params);
  return { rows: [], info };
}

async function get(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

async function all(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows;
}

// Insert a row; id/created_at defaulted when the table uses them.
const NO_CREATED_AT = new Set(['migrations', 'plans', 'conversation_participants', 'sessions', 'settings']);
async function insert(table, data) {
  const row = { id: newId(), ...data };
  if (!NO_CREATED_AT.has(table) && row.created_at === undefined) row.created_at = now();
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await query(sql, cols.map((c) => row[c]));
  return row.id;
}

async function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  await query(sql, [...cols.map((c) => data[c]), id]);
}

async function updateWhere(table, data, whereCol, whereVal) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${whereCol} = ?`;
  await query(sql, [...cols.map((c) => data[c]), whereVal]);
}

// Insert, or update the existing row when keyCol already exists.
async function upsert(table, keyCol, data) {
  const existing = await get(`SELECT ${keyCol} FROM ${table} WHERE ${keyCol} = ?`, [data[keyCol]]);
  if (existing) {
    const rest = { ...data };
    delete rest[keyCol];
    delete rest.id;
    await updateWhere(table, rest, keyCol, data[keyCol]);
    return data[keyCol];
  }
  return insert(table, data);
}

async function close() {
  if (pgPool) await pgPool.end();
  if (sqliteDb) sqliteDb.close();
}

module.exports = { init, getMode, query, get, all, insert, update, updateWhere, upsert, newId, now, close };
