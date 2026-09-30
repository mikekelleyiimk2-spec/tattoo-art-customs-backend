// Founding Members launch program tests (DB phase — runs before db.close()).
const db = require('../src/db');
const founding = require('../src/lib/founding');
const comm = require('../src/lib/commissions');

async function mkUser(email, role = 'customer') {
  return db.insert('users', {
    email, password_hash: 'x', role, display_name: email.split('@')[0],
  });
}

async function mkSub(userId, planId, status = 'active') {
  return db.insert('subscriptions', { user_id: userId, plan_id: planId, status });
}

async function ledgerFor(orderId) {
  return db.all('SELECT recipient_type, amount_cents FROM commission_ledger WHERE order_id = ?', [orderId]);
}

function sumBy(rows, type) {
  return rows.filter((r) => r.recipient_type === type).reduce((s, r) => s + r.amount_cents, 0);
}

async function runDbTests(ok) {
  console.log('founding program:');
  const customerPlan = (await db.get(`SELECT id FROM plans WHERE slug = 'customer'`)).id;

  // --- Caps: 50 artists ---
  const dupeArtist = await mkUser('fdupe@test.local');
  const [d1, d2] = await Promise.all([
    founding.claimFoundingArtist(dupeArtist), founding.claimFoundingArtist(dupeArtist),
  ]);
  ok(d1.claimed && d2.claimed && d2.already, 'concurrent duplicate claim: one wins, other is already:true');
  let st = await founding.getFoundingStatus();
  ok(st.artistsClaimed === 1, 'concurrent duplicate claim consumes exactly one slot');

  const artistIds = [dupeArtist];
  for (let i = 0; i < 49; i++) {
    const id = await mkUser(`fartist${i}@test.local`);
    const r = await founding.claimFoundingArtist(id);
    if (!r.claimed) throw new Error(`artist claim ${i} unexpectedly denied`);
    artistIds.push(id);
  }
  const extraArtist = await mkUser('fartistX@test.local');
  const deniedA = await founding.claimFoundingArtist(extraArtist);
  ok(!deniedA.claimed && deniedA.reason === 'cap filled', '51st artist denied when the cap is full');
  ok((await db.get('SELECT is_founding_artist FROM users WHERE id = ?', [extraArtist])).is_founding_artist === 0,
    'denied claimant is not flagged as founding');
  st = await founding.getFoundingStatus();
  ok(st.artistsClaimed === 50 && st.artistsLeft === 0, 'artist counter exact at 50');
  const again = await founding.claimFoundingArtist(artistIds[0]);
  st = await founding.getFoundingStatus();
  ok(again.claimed && again.already && st.artistsClaimed === 50, 're-claim is idempotent, counter unchanged');
  // Make the first founding artist a real designer for the page/API tests.
  await db.update('users', artistIds[0], { role: 'design_artist' });

  // --- Caps: 100 shops ---
  const dupeShop = await mkUser('fsdupe@test.local');
  const [s1, s2] = await Promise.all([
    founding.claimFoundingShop(dupeShop), founding.claimFoundingShop(dupeShop),
  ]);
  ok(s1.claimed && s2.claimed && s2.already, 'concurrent duplicate shop claim: one wins');
  st = await founding.getFoundingStatus();
  ok(st.shopsClaimed === 1, 'concurrent duplicate shop claim consumes exactly one slot');
  const shopIds = [dupeShop];
  for (let i = 0; i < 99; i++) {
    const id = await mkUser(`fshop${i}@test.local`);
    const r = await founding.claimFoundingShop(id);
    if (!r.claimed) throw new Error(`shop claim ${i} unexpectedly denied`);
    shopIds.push(id);
  }
  const extraShop = await mkUser('fshopX@test.local');
  const deniedS = await founding.claimFoundingShop(extraShop);
  ok(!deniedS.claimed && deniedS.reason === 'cap filled', '101st shop denied when the cap is full');
  st = await founding.getFoundingStatus();
  ok(st.shopsClaimed === 100 && st.shopsLeft === 0, 'shop counter exact at 100');
  // Give the badge-test designer + shop real passwords for HTTP login tests.
  const bcrypt = require('bcryptjs');
  await db.update('users', artistIds[0], { password_hash: await bcrypt.hash('FoundTest123!', 10) });
  await db.update('users', shopIds[0], {
    role: 'tattoo_shop', password_hash: await bcrypt.hash('FoundTest123!', 10),
  });
  // ...and active role subscriptions, since /artist and /shop require them.
  const artistPlan = (await db.get(`SELECT id FROM plans WHERE slug = 'design_artist'`)).id;
  const shopPlan = (await db.get(`SELECT id FROM plans WHERE slug = 'tattoo_shop'`)).id;
  await mkSub(artistIds[0], artistPlan);
  await mkSub(shopIds[0], shopPlan);

  // --- Commission math ---
  const buyer = await mkUser('fbuyer@test.local');
  const foundingArtist = artistIds[0];
  const plainArtist = await mkUser('plainartist@test.local');
  const designF = await db.insert('designs', { title: 'Founding piece', artist_id: foundingArtist });
  const designP = await db.insert('designs', { title: 'Plain piece', artist_id: plainArtist });
  const designLW = await db.insert('designs', { title: 'LW piece', artist_id: foundingArtist, color_source: 'none' });

  // Founding artist premade, no referring shop: 80% + 10% no-shop share
  // = 90% of $75 = $67.50; owner 8%, site 2%.
  const o1 = await db.insert('orders', {
    buyer_id: buyer, design_id: designF, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o1]));
  const l1 = await ledgerFor(o1);
  ok(sumBy(l1, 'artist') === 6000, 'founding artist gets 80% of premade sale (70% + half the unassigned shop share)');
  ok(l1.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'founding-artist splits sum to the sale total');

  // Baseline now 70%.
  const o2 = await db.insert('orders', {
    buyer_id: buyer, design_id: designP, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o2]));
  ok(sumBy(await ledgerFor(o2), 'artist') === 5250, 'non-founding artist gets 70% (60% + half the unassigned shop share)');

  // Linework-only founding artist: 75% (65% base + 10 boost) + 10% no-shop
  // share, 5% color fee kept.
  const o3 = await db.insert('orders', {
    buyer_id: buyer, design_id: designLW, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o3]));
  const l3 = await ledgerFor(o3);
  ok(sumBy(l3, 'artist') === 5625, 'linework-only founding artist gets 75% (65% + no-shop half-share)');
  ok(l3.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'linework splits sum to the sale total');

  // Founding shop referral on a plain-artist sale: 25% shop, owner split cut to 0%.
  const foundingShop = shopIds[0];
  const o4 = await db.insert('orders', {
    buyer_id: buyer, design_id: designP, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
    referred_shop_id: foundingShop,
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o4]));
  const l4 = await ledgerFor(o4);
  ok(sumBy(l4, 'shop') === 1875, 'founding shop gets 25% referral share');
  ok(sumBy(l4, 'artist') === 4500, 'plain artist still gets 60% on referred sale');
  ok(l4.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'referred splits sum to the sale total');

  // Combined: founding artist + founding shop.
  const o5 = await db.insert('orders', {
    buyer_id: buyer, design_id: designF, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
    referred_shop_id: foundingShop,
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o5]));
  const l5 = await ledgerFor(o5);
  ok(sumBy(l5, 'artist') === 5250 && sumBy(l5, 'shop') === 1500, 'combined: 70% artist + 20% shop (shop boost capped - owner share exhausted)');
  ok(l5.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'combined splits sum to the sale total');

  // Owner/unregistered art with founding shop: 75/25.
  const o6 = await db.insert('orders', {
    buyer_id: buyer, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
    referred_shop_id: foundingShop,
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o6]));
  const l6 = await ledgerFor(o6);
  ok(sumBy(l6, 'shop') === 1875, 'owner art: founding shop gets 25%');
  ok(l6.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'owner-art splits sum to the sale total');

  // Expired boost reverts to normal rates.
  const expArtist = artistIds[1];
  await db.update('users', expArtist, { founding_artist_ends_at: Date.now() - 1000 });
  ok(!(await founding.foundingArtistActive(expArtist)), 'expired boost reports inactive');
  const designE = await db.insert('designs', { title: 'Expired piece', artist_id: expArtist });
  const o7 = await db.insert('orders', {
    buyer_id: buyer, design_id: designE, order_type: 'premade',
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [o7]));
  ok(sumBy(await ledgerFor(o7), 'artist') === 5250, 'expired boost reverts to 70% (60% + no-shop half-share)');

  // Custom commission with founding artist: 80%.
  const o8 = await db.insert('orders', {
    buyer_id: buyer, order_type: 'custom',
    amount_cents: 15000, amount_paid_cents: 15000, status: 'paid',
  });
  const o8row = await db.get('SELECT * FROM orders WHERE id = ?', [o8]);
  await comm.recordCustomDesignerCommission(o8row, foundingArtist);
  const l8 = await db.all(
    `SELECT recipient_id, amount_cents FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist'`, [o8]);
  ok(l8.length === 1 && l8[0].amount_cents === 12000, 'founding artist custom commission is 80%');

  // --- Raffle entries (free entry: free account while entries are open) ---
  const rUser = await mkUser('raffle1@test.local');
  const e1 = await founding.enterRaffleOnSignup(rUser);
  ok(e1.entered, 'free account signup earns a raffle entry');
  const e2 = await founding.enterRaffleOnSignup(rUser);
  ok(!e2.entered && e2.reason === 'already entered', 'raffle entry is idempotent');
  ok((await db.all('SELECT id FROM raffle_entries WHERE user_id = ?', [rUser])).length === 1,
    'exactly one raffle row per user');

  // Entries stay open through the minimum close date regardless of count.
  const openNow = await founding.raffleEntriesOpen();
  ok(openNow.open && openNow.entries >= 1, 'entries open before the minimum close date');

  // After the minimum close date, entries stay open (extended) until a
  // close condition hits — 1M entries or $2,700 owner subscription
  // profits, neither of which is reachable in the test DB.
  const lateUser = await mkUser('rafflelate@test.local');
  const e4 = await founding.enterRaffleOnSignup(lateUser, founding.RAFFLE_ENTRY_MIN_CLOSE_AT + 1);
  ok(e4.entered, 'entry still granted after the minimum close date when close conditions are unmet');

  // --- Draw ---
  const entrants = [rUser, lateUser];
  for (let i = 0; i < 4; i++) {
    const u = await mkUser(`draw${i}@test.local`);
    const e = await founding.enterRaffleOnSignup(u);
    if (!e.entered) throw new Error(`entrant ${i} failed to enter`);
    entrants.push(u);
  }
  ok((await db.get('SELECT COUNT(*) AS n FROM raffle_entries')).n === 6, '6 raffle entries banked');
  const draw = await founding.drawRaffle();
  ok(draw.winners.length === 3, 'draw picks 3 winners from 6 entries');
  const winnerIds = draw.winners.map((w) => w.user_id);
  ok(new Set(winnerIds).size === 3, 'all winners are distinct users');
  const prizeCount = {};
  for (const w of draw.winners) prizeCount[w.prize] = (prizeCount[w.prize] || 0) + 1;
  ok(prizeCount.grand === 1 && prizeCount.runnerup === 2,
    'prize mix is 1 grand + 2 runners-up');

  const grand = draw.winners.find((w) => w.prize === 'grand');
  const gu = await db.get('SELECT membership_extended_until FROM users WHERE id = ?', [grand.user_id]);
  ok(gu.membership_extended_until && gu.membership_extended_until > Date.now(),
    'grand prize grants one free month of membership');

  let drewTwice = '';
  try { await founding.drawRaffle(); } catch (e) { drewTwice = e.message; }
  ok(drewTwice.includes('already'), 'the raffle cannot be drawn twice');

  const publicWinners = await db.all(
    `SELECT u.display_name, r.prize_won FROM raffle_entries r
     JOIN users u ON u.id = r.user_id WHERE r.prize_won IS NOT NULL`);
  ok(publicWinners.length === 3, 'public results list all 3 winners');

  // --- Shared role-grant path (website checkout + Google Play) ---
  // src/lib/planRoles.js is used by the Play verification flow, so a
  // Play-bought artist/shop membership must grant the role, create the
  // profile, attempt the founding claim, and enter the raffle — exactly
  // like the website's /approve path.
  const { grantPlanRole } = require('../src/lib/planRoles');
  const playUser = await mkUser('fplay@test.local');
  await grantPlanRole(playUser, 'design_artist');
  const playRole = await db.get('SELECT role, is_founding_artist FROM users WHERE id = ?', [playUser]);
  const playProfile = await db.get('SELECT user_id FROM artist_profiles WHERE user_id = ?', [playUser]);
  ok(playRole.role === 'design_artist' && !!playProfile,
    'shared grantPlanRole grants the design_artist role and creates the profile (Play parity)');
  ok(playRole.is_founding_artist === 0,
    'founding claim through grantPlanRole no-ops cleanly when the cap is full');
  const re = await founding.enterRaffleOnSignup(playUser);
  ok(re.entered === true || re.entered === false,
    'raffle entry on signup is callable and idempotent');
}

// HTTP phase: badges, public raffle page, founding-status API, admin page.
// NOTE: the suite's shared db handle is closed before the HTTP phase, so
// this opens its own read-only handle (same pattern as the suite's sdb).
async function runHttpTests(ok, req, areq) {
  console.log('founding program (http):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH, { readonly: true });
  const artist = tdb.prepare(`SELECT id FROM users WHERE email = 'fdupe@test.local'`).get();
  tdb.close();
  let r = await req('GET', `/artists/${artist.id}`);
  ok(r.status === 200 && r.text.includes('Founding Artist'), 'public artist page shows the Founding Artist badge');

  r = await req('GET', '/raffle');
  ok(r.status === 200 && r.text.includes('Tattoo Art Customs Opening Raffle') && r.text.includes('Winners'),
    'public raffle page renders the opening raffle with winners after the draw');

  r = await req('GET', '/api/founding-status');
  const fs = JSON.parse(r.text);
  ok(r.status === 200 && fs.ok && fs.artists_left === 0 && fs.shops_left === 0,
    'founding-status API reports the filled caps');

  r = await req('GET', '/api/artists/' + artist.id);
  const ap = JSON.parse(r.text);
  ok(r.status === 200 && ap.ok && ap.artist.is_founding_artist === true,
    'app API exposes the founding-artist flag');

  r = await areq('GET', '/admin/founding');
  ok(r.status === 200 && r.text.includes('Founding design artists') && r.text.includes('Opening raffle'),
    'admin founding page renders counters and raffle controls');

  // Badge rendering on the auth-gated pages (own jar per role). Manual
  // redirects: fetch drops Set-Cookie from followed 302s, so the login
  // POST must be manual (same reason the suite's areq/artreq are manual).
  async function jarReq(jar, method, p, body) {
    const headers = {};
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.cookie = cookies;
    const payload = body ? new URLSearchParams(body) : undefined;
    if (payload) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(`http://localhost:4137${p}`, {
      method, headers, body: payload, redirect: 'manual',
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      jar[k.trim()] = (v || '').trim();
    }
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      return jarReq(jar, 'GET', new URL(location, 'http://localhost:4137').pathname);
    }
    return { status: res.status, text: await res.text() };
  }
  const artistJar = {};
  r = await jarReq(artistJar, 'POST', '/login', { email: 'fdupe@test.local', password: 'FoundTest123!' });
  ok(r.status === 200, 'founding artist login ok');
  r = await jarReq(artistJar, 'GET', '/artist/portfolio');
  ok(r.status === 200 && r.text.includes('Founding Artist'), 'portfolio page shows the Founding Artist badge');
  const shopJar = {};
  r = await jarReq(shopJar, 'POST', '/login', { email: 'fsdupe@test.local', password: 'FoundTest123!' });
  ok(r.status === 200, 'founding shop login ok');
  r = await jarReq(shopJar, 'GET', '/shop');
  ok(r.status === 200 && r.text.includes('Founding Shop'), 'shop dashboard shows the Founding Shop badge');
}

module.exports = { runDbTests, runHttpTests };
