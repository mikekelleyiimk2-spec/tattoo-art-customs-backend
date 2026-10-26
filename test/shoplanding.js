// Public "for shops" landing at /shop (Approval Batch #1 item 15).
// Logged-out visitors and logged-in non-subscribers get the public sell
// page; active tattoo_shop subscribers keep landing on their dashboard.
// The coordinator (test/run.js) wires this in; do not run from here.
const { randomUUID } = require('crypto');

async function runHttpTests(ok, req) {
  console.log('shoplanding (public /shop landing):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);

  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, headers = {}, follow = true } = {}) {
      const h = { ...headers };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      const res = await fetch(`http://localhost:4137${p}`, {
        method, headers: h, body,
        redirect: follow ? 'follow' : 'manual',
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        jar[k.trim()] = (v || '').trim();
      }
      const text = await res.text();
      return { status: res.status, text, location: res.headers.get('location') || '' };
    };
  }
  const form = (obj) => ({
    body: new URLSearchParams(obj), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // 1. Logged-out visitor: the public landing, NOT a login bounce.
  const guest = makeClient();
  let r = await guest('GET', '/shop', { follow: false });
  ok(r.status === 200, '[15] guest GET /shop -> 200 landing (no login redirect)');
  ok(r.text.includes('Your shop, on Tattoo Art Customs'), '[15] landing headline renders');
  ok(r.text.includes('Earn 20% on every verified sale you refer'), '[15] landing carries the real 20% referral offer');
  ok(r.text.includes('22% at 25+') && r.text.includes('25% at 50+'), '[15] landing carries the real referral tiers');
  ok(r.text.includes('CNC Tattoo') && r.text.includes('Monsters Ink'), '[15] landing names the subscriber supply perks');
  ok(r.text.includes('earns a commission on qualifying purchases'), '[15] affiliate disclosure rides the landing');
  ok(!r.text.includes('cnctattoo.com/?ref='), '[15] gated perk LINKS stay behind the wall (names only)');
  ok(r.text.includes('href="/membership"'), '[15] landing join CTA points at /membership');
  ok(r.text.includes('href="/login"'), '[15] landing carries the owner login door');
  const jars = (r.text.match(/WA9DS6J8ERSHW/g) || []).length;
  ok(jars === 1, '[15] tip jar renders exactly once on the landing');

  // 2. Shop subpaths keep the wall: /shop/perks still bounces guests to login.
  r = await guest('GET', '/shop/perks', { follow: false });
  ok(r.status === 302 && r.location.includes('/login'), '[15] /shop/perks stays login-walled for guests');

  // 3. Logged-in NON-subscriber: landing too (not the old /membership bounce).
  const plain = makeClient();
  r = await plain('POST', '/signup', { ...form({ display_name: 'Plain User', email: 'plainshop@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, '[15] plain user signup redirects');
  r = await plain('GET', '/shop', { follow: false });
  ok(r.status === 200 && r.text.includes('Your shop, on Tattoo Art Customs'),
    '[15] logged-in non-subscriber gets the landing, not a bounce');

  // 4. Active shop subscriber: dashboard exactly as before, no landing.
  const shop = makeClient();
  r = await shop('POST', '/signup', { ...form({ display_name: 'Landing Shop', email: 'landingshop@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, '[15] shop user signup redirects');
  const shopId = tdb.prepare('SELECT id FROM users WHERE email = ?').get('landingshop@test.local').id;
  const planS = tdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get();
  tdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(randomUUID(), shopId, planS.id, 'active', Date.now());
  r = await shop('GET', '/shop', { follow: false });
  ok(r.status === 200 && r.text.includes('Shop dashboard'), '[15] subscriber still lands on the shop dashboard');
  ok(!r.text.includes('Your shop, on Tattoo Art Customs'), '[15] subscriber does NOT see the public landing');

  tdb.close();
}

module.exports = { runHttpTests };
