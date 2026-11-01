// OneMind command watchdog — the ALERT half (Brief #39, owner accepted
// 2026-10-25: "a stalled OneMind command raises an alert instead of
// dying silently").
//
// The detection half already lived in src/worker/apiLane.js: its
// watchdog re-queues a claimed/running command older than WATCHDOG_MS
// and fails it after MAX_ATTEMPTS — but it did so SILENTLY. Nobody was
// told. This module is the bell the watchdog now rings on every stall:
//
//   1. The house alert route: notify.notifyAdmins — in-app
//      notification + email + push to every admin (the same route
//      every other house alert travels).
//   2. A clearly named, append-only log:
//      logs/onemind-command-watchdog.log (one JSON line per stall;
//      path overridable with ONEMIND_WATCHDOG_LOG). *.log is already
//      gitignored, so the log is a runtime artifact, never a commit.
//   3. An in-process ring of the most recent alerts, served by the
//      service-token status endpoint GET /api/onemind/watchdog
//      (src/routes/watchdogStatus.js).
//
// Alerting is best-effort BY CONSTRUCTION: a failed alert must never
// break the watchdog's re-queue/fail work, so every leg catches its
// own errors and raiseStallAlert() never throws.
const fs = require('fs');
const path = require('path');

const RING_CAP = 50;
const ring = [];

function logPath() {
  return process.env.ONEMIND_WATCHDOG_LOG
    || path.join(__dirname, '..', '..', 'logs', 'onemind-command-watchdog.log');
}

// Test/embedding hook: when a sink is set it receives every alert
// INSTEAD of the file + notifyAdmins legs (the ring is still kept).
let sink = null;
function setAlertSink(fn) { sink = typeof fn === 'function' ? fn : null; }

function recentStallAlerts(limit = 20) {
  return ring.slice(-Math.max(1, Math.min(limit, RING_CAP))).reverse();
}

function stallAlertCount() { return ring.length; }

async function raiseStallAlert(alert) {
  const entry = {
    at: new Date().toISOString(),
    kind: 'onemind_command_stalled',
    command_id: alert.command_id != null ? alert.command_id : null,
    lane: alert.lane || 'api',
    status: alert.status || null,
    attempts: alert.attempts != null ? alert.attempts : null,
    claimed_by: alert.claimed_by || null,
    stalled_for_ms: alert.stalled_for_ms != null ? alert.stalled_for_ms : null,
    action: alert.action || null, // 'requeued' | 'failed'
    text: String(alert.text || '').slice(0, 200),
  };
  ring.push(entry);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  if (sink) {
    try { await sink(entry); } catch (e) { console.error('[command-watchdog] alert sink failed:', e.message); }
    return entry;
  }
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[command-watchdog] alert log write failed:', e.message);
  }
  try {
    const { notifyAdmins } = require('./notify');
    const title = entry.action === 'failed'
      ? 'OneMind command stalled and failed'
      : 'OneMind command stalled — re-queued';
    const body = `Command #${entry.command_id} (${entry.lane} lane) stalled for `
      + `${Math.round((entry.stalled_for_ms || 0) / 1000)}s after ${entry.attempts} attempt(s) `
      + `and was ${entry.action === 'failed' ? 'marked failed' : 're-queued'} by the watchdog. `
      + `Text: "${entry.text}"`;
    await notifyAdmins({
      kind: 'onemind_watchdog',
      title,
      body,
      link: '/admin',
      emailSubject: `[OneMind watchdog] ${title}`,
      emailText: body,
    });
  } catch (e) {
    console.error('[command-watchdog] notifyAdmins failed:', e.message);
  }
  return entry;
}

module.exports = { raiseStallAlert, recentStallAlerts, stallAlertCount, setAlertSink, logPath };
