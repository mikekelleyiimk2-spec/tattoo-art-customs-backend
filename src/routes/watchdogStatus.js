// OneMind command watchdog — status door (Brief #39).
//
//   GET /api/onemind/watchdog — Muse service-token only, the exact
//   gate pattern of GET /api/onemind/ties in src/routes/onemind.js
//   (404 when MUSE_SERVICE_TOKEN is unset, 401 on a bad token):
//   the watchdog's tuning (stall threshold, attempt cap) and the
//   most recent stall alerts raised by lib/commandWatchdog. No
//   per-person data: command ids, lanes, counts, timestamps only.
const express = require('express');
const crypto = require('crypto');
const commandWatchdog = require('../lib/commandWatchdog');
const { WATCHDOG_MS, MAX_ATTEMPTS } = require('../worker/apiLane');

const router = express.Router();

function serviceAuthorized(req) {
  const expected = process.env.MUSE_SERVICE_TOKEN || '';
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/onemind/watchdog', async (req, res) => {
  if (!process.env.MUSE_SERVICE_TOKEN) return res.status(404).json({ ok: false });
  if (!serviceAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.json({
    ok: true,
    watchdog_ms: WATCHDOG_MS,
    max_attempts: MAX_ATTEMPTS,
    alert_log: 'logs/onemind-command-watchdog.log',
    alerts_in_memory: commandWatchdog.stallAlertCount(),
    recent_alerts: commandWatchdog.recentStallAlerts(20),
  });
});

module.exports = router;
