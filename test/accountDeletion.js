// Self-serve account deletion tests (privacy follow-up, 2026-11-02).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers: the /account control + confirm page, the type-your-email gate,
// the deletion itself (account + seat + personal rows gone, sessions
// ended), the sold/unsold design split, order-record scrubbing, and the
// public confirmation + info pages.
async function runHttpTests(ok, req) {
  console.log('accountDeletion (self-serve account delete):');
  const Database = require('better-sqlite3');
  const wdb = new Database(process.env.SQLITE_PATH);

  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, headers = {}, follow = true } = {}) {
      const h = { ...headers };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      const res = await fetch(`http://localhost:4137${p}`, {
        method, headers: h, body, redirect: follow ? 'follow' : 'manual',
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        jar[k.trim()] = (v || '').trim();
      }
      const text = await res.text();
      return { status: res.status, text, location: res.headers.get('location') };
    };
  }
  const form = (obj) => ({
    body: new URLSearchParams(obj),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // Public pages carry the self-serve path.
  let r = await req('GET', '/delete-account');
  ok(r.status === 200 && r.text.includes('Delete it yourself'), 'public /delete-account page offers the self-serve delete');
  r = await req('GET', '/privacy');
  ok(r.status === 200 && r.text.includes('signs you out everywhere'), 'privacy policy describes the built deletion behavior');

  // Sign up the member who will delete their account.
  const user = makeClient();
  r = await user('POST', '/signup', { ...form({ display_name: 'Del User', email: 'deluser@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, 'deletion-test signup redirects');
  const urow = wdb.prepare('SELECT id FROM users WHERE email = ?').get('deluser@test.local');
  ok(!!urow, 'deletion-test user exists');
  const uid = urow.id;

  // The dashboard carries the control; the confirm page explains the deal.
  r = await user('GET', '/account');
  ok(r.status === 200 && r.text.includes('Delete my account'), 'account dashboard carries the delete control');
  r = await user('GET', '/account/delete');
  ok(r.status === 200 && r.text.includes('Type your account email to confirm'), 'delete confirm page renders with the email gate');

  // Seed the member's footprint: a photo, a favorite, an unsold design,
  // a sold design, and an order carrying their email.
  wdb.prepare('INSERT INTO member_photos (id, user_id, path, caption, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('delphoto1', uid, '/img/photos/del.jpg', 'mine', Date.now());
  const insDesign = wdb.prepare(`INSERT INTO designs
    (id, title, description, style, categories, status, listing_type, listing_scope, price_cents, created_at, artist_id, sale_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insDesign.run('del-unsold', 'Del Unsold', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now(), uid, 0);
  insDesign.run('del-sold', 'Del Sold', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now(), uid, 2);
  insDesign.run('del-other', 'Del Other', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now(), null, 0);
  r = await user('POST', '/api/favorites/del-other', { body: '{}', headers: { 'content-type': 'application/json' } });
  ok(r.status === 200, 'favorite seeded for deletion test');
  wdb.prepare(`INSERT INTO orders
    (id, buyer_id, order_type, amount_cents, deposit_cents, amount_paid_cents, status, paypal_order_id,
     payment_method, referral_code, custom_brief, created_at, custom_color_path, custom_linework_path,
     custom_status, drafts_json, admin_notes, client_email)
    VALUES (?, ?, 'premade', 7500, 0, 7500, 'paid', '', 'paypal', '', '', ?, '', '', 'none', '[]', '', 'deluser@test.local')`)
    .run('del-order-1', uid, Date.now());
  const tiesBefore = wdb.prepare('SELECT COUNT(*) AS n FROM account_ties WHERE user_id = ?').get(uid).n;
  ok(tiesBefore >= 1, 'seat tie exists before deletion');
  const sessionsBefore = wdb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n;
  ok(sessionsBefore >= 1, 'web session exists before deletion');

  // Wrong confirmation email: nothing is deleted.
  r = await user('POST', '/account/delete', { ...form({ website: '', confirm_email: 'someoneelse@test.local' }), follow: false });
  ok(r.status === 302 && r.location === '/account/delete', 'wrong confirm email bounces back to the confirm page');
  ok(!!wdb.prepare('SELECT id FROM users WHERE id = ?').get(uid), 'account survives a wrong confirmation');
  r = await user('GET', '/account');
  ok(r.status === 200, 'still signed in after a wrong confirmation');

  // Correct confirmation: account, seat, and personal data go; the
  // session ends; sold art + the order record stay, scrubbed.
  r = await user('POST', '/account/delete', { ...form({ website: '', confirm_email: 'deluser@test.local' }), follow: false });
  ok(r.status === 302 && r.location === '/account-deleted', 'correct confirmation redirects to the deleted page');
  r = await user('GET', '/account-deleted');
  ok(r.status === 200 && r.text.includes('has been deleted'), 'public confirmation page renders after deletion');

  ok(!wdb.prepare('SELECT id FROM users WHERE id = ?').get(uid), 'users row (the seat) is deleted');
  ok(wdb.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n === 0, 'all sessions ended');
  ok(wdb.prepare('SELECT COUNT(*) AS n FROM account_ties WHERE user_id = ?').get(uid).n === 0, 'seat ties deleted');
  ok(wdb.prepare('SELECT COUNT(*) AS n FROM member_photos WHERE user_id = ?').get(uid).n === 0, 'member photos deleted');
  ok(wdb.prepare('SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?').get(uid).n === 0, 'favorites deleted');
  ok(!wdb.prepare('SELECT id FROM designs WHERE id = ?').get('del-unsold'), 'unsold design deleted with the account');
  const sold = wdb.prepare('SELECT artist_id FROM designs WHERE id = ?').get('del-sold');
  ok(!!sold && sold.artist_id === null, 'sold design kept for its buyers, artist unattributed');
  const order = wdb.prepare('SELECT client_email FROM orders WHERE id = ?').get('del-order-1');
  ok(!!order && order.client_email === '', 'order record kept with the buyer email scrubbed');

  // The old session is dead and the deleted credentials no longer sign in.
  r = await user('GET', '/account', { follow: false });
  ok(r.status === 302 && String(r.location || '').includes('/login'), 'old session no longer reaches the account page');
  r = await user('POST', '/login', { ...form({ email: 'deluser@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302 && String(r.location || '').includes('/login'), 'deleted account cannot sign in again');

  // The same email can register fresh (a brand-new, empty account).
  const again = makeClient();
  r = await again('POST', '/signup', { ...form({ display_name: 'Del User', email: 'deluser@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, 'the freed email can sign up again');
  const newRow = wdb.prepare('SELECT id FROM users WHERE email = ?').get('deluser@test.local');
  ok(!!newRow && newRow.id !== uid, 're-registration is a new account, not a resurrection');
}

module.exports = { runHttpTests };
