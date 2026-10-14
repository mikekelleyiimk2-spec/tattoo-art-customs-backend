// Purchase tokens for gated sideload app updates (owner ruling 2026-10-14).
//
// Paid apps in the app-updates registry (entry.gated === true) must NEVER
// serve APK bytes on the public /api/apps/:package/apk URL. A buyer gets a
// stateless update token at purchase time (shown on the download page as
// "Your update code"); the app presents it on later update downloads via
// the x-update-token header or ?t= query param.
//
// Token format:  <orderId>.<first 32 hex chars of HMAC-SHA256>
//   HMAC key  = config.sessionSecret
//   HMAC data = orderId + ":" + packageName
// Verification is two steps: verify() here checks the HMAC (timing-safe)
// and returns the orderId; the caller must then DB-check that the order
// exists, is status 'paid', and has order_type === "sideload:" + package.
const crypto = require('crypto');
const config = require('../config');

function signature(orderId, packageName) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${orderId}:${packageName}`)
    .digest('hex')
    .slice(0, 32);
}

function issue(orderId, packageName) {
  return `${orderId}.${signature(orderId, packageName)}`;
}

// Returns the orderId when the token's HMAC is valid for this package,
// otherwise null. Purely cryptographic — no DB access here.
function verify(token, packageName) {
  if (!token || typeof token !== 'string' || !packageName) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const orderId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!/^[0-9a-f]{32}$/.test(sig)) return null;
  const expected = signature(orderId, packageName);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return orderId;
}

module.exports = { issue, verify };
