// PayPal Plug — Service Plug Playbook #2 (2026-10-26). The read lane
// behind Money Watch's mk4 door (playbook:
// ~/workspace/app/service-plug/playbook-paypal.md — read it before
// touching this file).
//
// WHAT THIS IS: a READ-ONLY client for the estate's Business PayPal
// (mk4, mikekelleyii.mk4@gmail.com) over PayPal's REST reporting APIs:
// an OAuth2 client-credentials token, then balances + transaction
// history reads. There is NO payment, payout, refund, or write call in
// this module and there may never be one added casually — the
// playbook's operation set is reads, and a playbook that would touch
// money movement needs its own custody paper first (custody draft §1).
//
// CREDENTIAL SEAT: this door's OWN REST app credential, seated in the
// server env as PAYPAL_WATCH_CLIENT_ID / PAYPAL_WATCH_CLIENT_SECRET.
// Deliberately NOT the plain PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
// names — those belong to the website checkout lane (src/lib/paypal.js),
// a different door with a different scope; each door gets its own
// credential and its own env seat (per-door custody isolation). The
// secret is read live from env at call time, used only inside the
// token request's Authorization header to PayPal itself, and never
// logged, returned, stored, or registered anywhere in this codebase —
// the plug registry holds a sha256 fingerprint + this env path only
// (registered at seating time, Playbook #2 §2).
//
// CONFIGURED = both env vars present. Unconfigured is a normal,
// honest state (the door reads "built — awaiting credential
// registration" in Money Watch), never an error: every function here
// is only called when configured() is true.
//
// ERRORS carry a playbook error class on err.paypalClass:
//   credential_rejected (401 from the token endpoint — the secret was
//     regenerated or the app deleted; staged owner step, never guessed)
//   permission_denied (403 / insufficient scope — the app's
//     Transaction Search feature is off; owner re-checks the app)
//   platform_unreachable (network failure / 5xx — park, next run)
//   read_failed (anything else)
// Callers park the door on error: the watermark does not advance, no
// retry loop, no re-auth storm (the plug laws).
//
// TESTS: _setTransportForTests(fn) replaces the HTTP layer wholesale
// (token + data), so the suite exercises the full lane with zero
// network and zero credential. fn receives {method, url, headers,
// body} and returns {status, json}.

const DEFAULT_BASE = 'https://api-m.paypal.com';
const DAY_MS = 24 * 3600 * 1000;
// Transaction Search serves at most a 31-day window per call.
const MAX_WINDOW_MS = 31 * DAY_MS;

function clientId() { return process.env.PAYPAL_WATCH_CLIENT_ID || ''; }
function clientSecret() { return process.env.PAYPAL_WATCH_CLIENT_SECRET || ''; }

function configured() {
  return clientId().length > 0 && clientSecret().length > 0;
}

function apiBase() {
  return (process.env.PAYPAL_WATCH_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

// ---- transport ------------------------------------------------------

let testTransport = null;
function _setTransportForTests(fn) { testTransport = fn || null; }

async function http(method, url, { headers = {}, body } = {}) {
  if (testTransport) return testTransport({ method, url, headers, body });
  const res = await fetch(url, { method, headers, body });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body: status speaks */ }
  return { status: res.status, json };
}

function plugError(paypalClass, message) {
  const e = new Error(message);
  e.paypalClass = paypalClass;
  return e;
}

function classForStatus(status, what) {
  if (status === 401) return plugError('credential_rejected', `PayPal rejected the credential at ${what} (401)`);
  if (status === 403) return plugError('permission_denied', `PayPal refused the read at ${what} (403 — scope/feature)`);
  if (status >= 500) return plugError('platform_unreachable', `PayPal platform error at ${what} (${status})`);
  return plugError('read_failed', `PayPal read failed at ${what} (${status})`);
}

// ---- the lane -------------------------------------------------------

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(nowMs = Date.now()) {
  if (tokenCache.token && tokenCache.expiresAt > nowMs + 30000) return tokenCache.token;
  const auth = Buffer.from(`${clientId()}:${clientSecret()}`, 'utf8').toString('base64');
  let r;
  try {
    r = await http('POST', `${apiBase()}/v1/oauth2/token`, {
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (e) {
    throw plugError('platform_unreachable', `PayPal token request unreachable: ${e.message}`);
  }
  if (r.status !== 200 || !r.json || !r.json.access_token) throw classForStatus(r.status, 'the token endpoint');
  tokenCache = {
    token: r.json.access_token,
    expiresAt: nowMs + (Number(r.json.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

async function authedGet(pathname) {
  const token = await getAccessToken();
  let r;
  try {
    r = await http('GET', `${apiBase()}${pathname}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
  } catch (e) {
    throw plugError('platform_unreachable', `PayPal read unreachable: ${e.message}`);
  }
  if (r.status !== 200) throw classForStatus(r.status, pathname.split('?')[0]);
  return r.json;
}

// The proof read (Playbook #2 §4): one cheap, unambiguous call — the
// account's balances. Used at seating and as the door's liveness read.
async function fetchBalances() {
  const json = await authedGet('/v1/reporting/balances');
  return Array.isArray(json && json.balances) ? json.balances : [];
}

// One watcher scan of the transaction history between fromMs and
// toMs (the window is clamped to the API's 31-day maximum). Returns
// normalized rows: { id, at, amount_cents (signed), currency,
// event_code, status }. Only completed rows (transaction_status 'S')
// are returned — a pending row fires nothing, and when it completes it
// returns under the same transaction ID and is absorbed then, so a
// transaction can still only ever fire once.
async function scanTransactions(fromMs, toMs) {
  const start = Math.max(Number(fromMs) || 0, toMs - MAX_WINDOW_MS);
  const rows = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const q = new URLSearchParams({
      start_date: new Date(start).toISOString(),
      end_date: new Date(toMs).toISOString(),
      fields: 'all',
      page_size: '500',
      page: String(page),
    });
    const json = await authedGet(`/v1/reporting/transactions?${q.toString()}`);
    const details = Array.isArray(json && json.transaction_details) ? json.transaction_details : [];
    for (const d of details) {
      const ti = (d && d.transaction_info) || {};
      if (ti.transaction_status !== 'S') continue;
      const id = typeof ti.transaction_id === 'string' ? ti.transaction_id : '';
      const at = Date.parse(ti.transaction_updated_date || ti.transaction_initiation_date || '');
      const rawAmt = ti.transaction_amount && ti.transaction_amount.value;
      const amount = typeof rawAmt === 'string' || typeof rawAmt === 'number' ? Number(rawAmt) : NaN;
      if (!id || !Number.isFinite(at) || !Number.isFinite(amount)) continue;
      rows.push({
        id,
        at,
        amount_cents: Math.round(amount * 100),
        currency: (ti.transaction_amount && ti.transaction_amount.currency_code) || '',
        event_code: typeof ti.transaction_event_code === 'string' ? ti.transaction_event_code : '',
        status: ti.transaction_status,
      });
    }
    totalPages = Number(json && json.total_pages) || 1;
    page += 1;
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

module.exports = {
  configured,
  fetchBalances,
  scanTransactions,
  _setTransportForTests,
  // exposed for tests/diagnostics only: where the door would call.
  apiBase,
};
