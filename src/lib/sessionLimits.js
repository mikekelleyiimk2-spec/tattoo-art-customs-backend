// Concurrent-session (device) limits — revenue-leak fix.
// Caps (owner-set): tattoo_shop subscribers = 3 concurrent sessions,
// design_artist = 2, customer/member = 2. population_admin-flagged users and
// head_admin are EXEMPT (owner's trusted circle; their sessions are untouched).
//
// Enforcement runs on login (wherever req.session.userId is established —
// NOT on head-admin impersonation, which is not a login). If the account is
// at/over its cap, the oldest sessions are evicted first (ORDER BY
// expires_at ASC) until under the cap, and the user gets a "new sign-in —
// your oldest session was signed out" email alert. The session just created
// is never evicted.
//
// No schema change: everything reads/writes the existing sessions table
// (id, user_id, data, expires_at).
const db = require('../db');
const { sendMail } = require('./mail');

// Session TTL mirrors the express-session cookie maxAge in src/index.js
// (14 days) — expires_at is refreshed on touch, so last activity is
// derived as expires_at - SESSION_TTL_MS.
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

const CAPS = {
  tattoo_shop: 3,
  design_artist: 2,
  customer: 2,
  member: 2,
  admin: 3, // staff (non-head); head_admin is exempt below
};
const DEFAULT_CAP = 2;

async function capForUserId(userId) {
  const user = await db.get(
    'SELECT id, email, role, population_admin FROM users WHERE id = ?', [userId]);
  if (!user) return { cap: DEFAULT_CAP, exempt: false, user: null };
  const exempt = user.role === 'head_admin' || !!user.population_admin;
  const cap = CAPS[user.role] || DEFAULT_CAP;
  return { cap, exempt, user };
}

// Lightweight user-agent parse for the account page's device list.
// No dependency — just enough to say "Chrome on Windows" / "Safari on iPhone".
function parseUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  let os = 'Unknown OS';
  if (/iPhone/i.test(s)) os = 'iPhone';
  else if (/iPad/i.test(s)) os = 'iPad';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'Mac';
  else if (/Linux/i.test(s)) os = 'Linux';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  let browser = 'Unknown browser';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/CriOS/i.test(s)) browser = 'Chrome (iOS)';
  else if (/FxiOS/i.test(s)) browser = 'Firefox (iOS)';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s) && /Version\//i.test(s)) browser = 'Safari';
  return `${browser} on ${os}`;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Enforce the cap right after login. Records device info on the new session
// (so the account page can list it), evicts oldest-first when at/over cap,
// and emails the user when an eviction happened. Never throws — a limit
// failure must never break a login.
async function enforceSessionCap(req) {
  try {
    const userId = req.session && req.session.userId;
    if (!userId) return { enforced: false };
    const { cap, exempt, user } = await capForUserId(userId);
    if (exempt || !user) return { enforced: false, exempt };

    // Record device info on the just-created session for the device list.
    const ua = (req.get && req.get('user-agent')) || req.headers?.['user-agent'] || '';
    req.session.device = {
      ua: String(ua).slice(0, 300),
      ip: String(req.ip || '').slice(0, 64),
      at: Date.now(),
    };

    const sid = req.sessionID;
    const now = Date.now();
    // Active non-expired sessions for this account, oldest first, EXCLUDING
    // the session just created — it must never be evicted.
    const rows = await db.all(
      `SELECT id, expires_at FROM sessions
       WHERE user_id = ? AND expires_at > ? AND id != ?
       ORDER BY expires_at ASC`,
      [userId, now, sid || '']);
    if (rows.length < cap) return { enforced: true, cap, evicted: [] };

    const evict = rows.slice(0, rows.length - cap + 1);
    for (const r of evict) {
      await db.query('DELETE FROM sessions WHERE id = ?', [r.id]);
    }

    // Alert the user — this is the one authorized outbound email.
    const device = parseUserAgent(ua);
    try {
      await sendMail({
        to: user.email,
        subject: 'New sign-in to your Tattoo Art Customs account',
        text: `A new sign-in to your Tattoo Art Customs account was detected.\n\n` +
          `Device: ${device}\nIP: ${req.ip || 'unknown'}\nTime: ${new Date().toUTCString()}\n\n` +
          `Your plan allows ${cap} concurrent sign-in${cap === 1 ? '' : 's'}, so your oldest ` +
          `session was signed out to make room. If this wasn't you, change your password ` +
          `immediately and use "Sign out all other devices" on your account page.`,
      });
    } catch (e) {
      console.error('session-limit alert email failed:', e.message);
    }
    return { enforced: true, cap, evicted: evict.map((r) => r.id) };
  } catch (e) {
    console.error('enforceSessionCap failed:', e.message);
    return { enforced: false, error: e.message };
  }
}

// Active sessions for the account page: device/browser parsed from the
// stored user-agent, IP, and last activity (derived from expires_at).
async function listSessions(userId, currentSid) {
  const now = Date.now();
  const rows = await db.all(
    `SELECT id, data, expires_at FROM sessions
     WHERE user_id = ? AND expires_at > ?
     ORDER BY expires_at DESC`,
    [userId, now]);
  return rows.map((r) => {
    let info = {};
    try { info = (JSON.parse(r.data || '{}').device) || {}; } catch (e) { /* corrupt row */ }
    return {
      id: r.id,
      current: r.id === currentSid,
      device: parseUserAgent(info.ua),
      ip: info.ip || 'unknown',
      lastActivity: relativeTime(r.expires_at - SESSION_TTL_MS),
      signedInAt: info.at ? new Date(info.at).toLocaleString() : null,
    };
  });
}

// Revoke one session. Refuses to revoke the caller's own current session
// (use revokeOtherSessions for sign-out-everywhere).
async function revokeSession(userId, sid, currentSid) {
  if (!sid || sid === currentSid) return { revoked: false };
  const row = await db.get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [sid, userId]);
  if (!row) return { revoked: false };
  await db.query('DELETE FROM sessions WHERE id = ?', [sid]);
  return { revoked: true };
}

// "Sign out all other devices": keeps the current session, deletes the rest.
async function revokeOtherSessions(userId, currentSid) {
  const res = await db.query(
    'DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, currentSid || '']);
  // better-sqlite3 returns { changes }; pg wrapper returns rowCount-ish.
  const n = res && (res.changes != null ? res.changes : res.rowCount);
  return { revoked: typeof n === 'number' ? n : 0 };
}

module.exports = {
  SESSION_CAPS: CAPS,
  DEFAULT_CAP,
  SESSION_TTL_MS,
  capForUserId,
  parseUserAgent,
  enforceSessionCap,
  listSessions,
  revokeSession,
  revokeOtherSessions,
};
