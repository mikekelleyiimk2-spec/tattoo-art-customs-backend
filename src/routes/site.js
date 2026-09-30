// Public pages: home, gallery, design detail, terms, privacy.
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { requireLogin, isActiveMember } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { premadePriceCents, customFullCents, isSaleWindow, lineworkOnlyPriceCents, LINEWORK_ONLY_DISCOUNT, salePriceActive, withFeeCents, processingFeeCents, money } = require('../lib/pricing');
const { viewerFor, displayImgFile, canViewUnblurred } = require('../lib/contentPolicy');

const router = express.Router();

// Wallet hub: one URL for the app + website that lands each user on their
// own money page — artists/shops get their payout settings, everyone else
// gets their site credit.
router.get('/wallet', requireLogin, (req, res) => {
  if (req.user.role === 'design_artist') return res.redirect('/artist#payouts');
  if (req.user.role === 'tattoo_shop') return res.redirect('/shop#payouts');
  res.redirect('/account#credit');
});

// App cashout page (owner rule 2026-09-28): the app's Wallet tab loads this
// for artists/shops. It offers cashout to already-configured destinations
// only — payout-destination setup/verification is website-only, so this page
// carries no setup forms or links to them, just the notice below.
router.get('/wallet/app', requireLogin, async (req, res) => {
  const { payoutDashboardData } = require('../lib/payoutRoutes');
  if (req.user.role === 'design_artist') {
    const payout = await payoutDashboardData(req.user.id, 'artist');
    return res.render('wallet/cashout', {
      title: 'Cashout — Tattoo Art Customs', metaDescription: '',
      payoutBase: '/artist', ...payout,
    });
  }
  if (req.user.role === 'tattoo_shop') {
    const payout = await payoutDashboardData(req.user.id, 'shop');
    return res.render('wallet/cashout', {
      title: 'Cashout — Tattoo Art Customs', metaDescription: '',
      payoutBase: '/shop', ...payout,
    });
  }
  res.redirect('/account#credit');
});

// ads.txt — required by Google AdSense so ad revenue is credited to us.
// Serves automatically once ADSENSE_PUBLISHER_ID is set.
router.get('/ads.txt', (req, res) => {
  const raw = (config.adsense.publisherId || '').trim();
  if (!raw) return res.status(404).type('text/plain').send('Not configured');
  const pubId = raw.replace(/^ca-pub-/i, 'pub-');
  res.type('text/plain').send(`google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`);
});

// Apple Pay domain verification (via PayPal) — Apple fetches this file to
// confirm the domain is authorized for Apple Pay. Served from the
// APPLE_PAY_DOMAIN_ASSOCIATION env var when set, otherwise from the shipped
// PayPal-signed file. Served byte-exact (no trailing newline) as
// application/octet-stream per PayPal's docs.
router.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  let content = (config.applePay.domainAssociation || '').trim();
  if (!content) {
    try {
      content = fs.readFileSync(
        path.join(__dirname, '..', 'public', '.well-known', 'apple-developer-merchantid-domain-association'),
        'utf8').trim();
    } catch (e) { /* not shipped */ }
  }
  if (!content) return res.status(404).type('text/plain').send('Not configured');
  res.type('application/octet-stream').send(content);
});

// robots.txt — allow all crawlers; point them at the sitemap.
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

// sitemap.xml — home, gallery, key pages, and every approved design.
router.get('/sitemap.xml', async (req, res) => {
  const base = config.baseUrl.replace(/\/$/, '');
  const urls = [
    { loc: `${base}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${base}/gallery`, changefreq: 'daily', priority: '0.9' },
    { loc: `${base}/membership`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${base}/advertise`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${base}/about`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${base}/raffle`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${base}/terms`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${base}/privacy`, changefreq: 'monthly', priority: '0.3' },
  ];
  try {
    const designs = await db.all(
      `SELECT id, created_at FROM designs WHERE status = 'approved' AND listing_scope = 'gallery'
       AND members_only = 0 ORDER BY created_at DESC LIMIT 5000`);
    for (const d of designs) {
      const lastmod = d.created_at ? new Date(Number(d.created_at)).toISOString().slice(0, 10) : '';
      urls.push({ loc: `${base}/design/${d.id}`, changefreq: 'weekly', priority: '0.8', lastmod });
    }
    // Public artist portfolios (include portfolio-only custom pieces;
    // opted-in shops are designers too).
    const artists = await db.all(
      `SELECT DISTINCT u.id FROM users u JOIN designs d ON d.artist_id = u.id
       LEFT JOIN shop_profiles sp ON sp.user_id = u.id
       WHERE u.role IN ('design_artist','tattoo_shop','admin','head_admin')
       AND d.status = 'approved' LIMIT 5000`);
    for (const a of artists) {
      urls.push({ loc: `${base}/artists/${a.id}`, changefreq: 'weekly', priority: '0.7' });
    }
  } catch { /* sitemap still serves without design URLs */ }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>`;
  res.type('application/xml').send(xml);
});

function parseDesign(row) {
  if (!row) return null;
  let categories = [];
  try { categories = JSON.parse(row.categories || '[]'); } catch { /* keep empty */ }
  return { ...row, categories };
}

async function approvedDesigns(member = false) {
  // Main gallery: approved pre-designs only. Portfolio-only custom pieces
  // never appear here — they live on the artist's own portfolio page.
  // Member-exclusive designs are hidden from non-members everywhere.
  const rows = await db.all(
    `SELECT * FROM designs WHERE status = 'approved' AND listing_scope = 'gallery'
     AND (members_only = 0 OR ? = 1) ORDER BY created_at DESC`, [member ? 1 : 0]);
  return rows.map(parseDesign);
}

// Capture referral codes (?ref=CODE) into a cookie for checkout attribution.
router.use((req, res, next) => {
  if (req.query.ref) {
    res.cookie('ref_code', String(req.query.ref).slice(0, 32), {
      maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax',
    });
  }
  next();
});

router.get('/', async (req, res) => {
  const member = await isActiveMember(req.user);
  const all = await approvedDesigns(member);
  const viewer = await viewerFor(req.user);
  const designs = all.slice(0, 12).map((d) => ({ ...d, thumb: displayImgFile(d, viewer) }));
  const base = config.baseUrl.replace(/\/$/, '');
  const ogImg = designs.length && designs[0].thumb ? `${base}/img/designs/${designs[0].thumb}` : '';
  res.render('site/index', {
    title: 'Buy Original Tattoo Designs Online — Custom Tattoo Designs | Tattoo Art Customs',
    designs, designCount: all.length, sale: await salePriceActive(req.user),
    premadePrice: withFeeCents(premadePriceCents(new Date(), member)), customPrice: withFeeCents(customFullCents(new Date(), member)),
    metaDescription: 'Buy original tattoo designs online from independent artists. 900+ ready-made designs plus custom tattoo designs with 48-hour delivery.',
    canonical: `${base}/`,
    ogImage: ogImg,
    playStoreUrl: config.playStoreUrl,
  });
});

router.get('/gallery', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const cat = (req.query.cat || '').trim().toLowerCase();
  const member = await isActiveMember(req.user);
  let designs = await approvedDesigns(member);
  const allCats = [...new Set(designs.flatMap((d) => d.categories))].sort();
  if (cat) designs = designs.filter((d) => d.categories.some((c) => c.toLowerCase() === cat));
  if (q) {
    designs = designs.filter((d) =>
      d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) ||
      d.categories.some((c) => c.toLowerCase().includes(q)));
  }
  const viewer = await viewerFor(req.user);
  const thumbs = designs.map((d) => ({ ...d, thumb: displayImgFile(d, viewer) }));
  res.render('site/gallery', {
    title: 'Tattoo Design Gallery — Buy Original Tattoo Designs | Tattoo Art Customs',
    designs: thumbs, allCats, q: req.query.q || '', cat: req.query.cat || '', sale: await salePriceActive(req.user),
    premadePrice: withFeeCents(premadePriceCents(new Date(), member)),
    metaDescription: 'Search 900+ original tattoo designs by style and category. Buy ready-made tattoo designs from independent artists — full color and linework included.',
    canonical: `${config.baseUrl.replace(/\/$/, '')}/gallery`,
  });
});

router.get('/design/:id', async (req, res) => {
  const design = parseDesign(await db.get(
    "SELECT * FROM designs WHERE id = ? AND status = 'approved'", [req.params.id]));
  const member = await isActiveMember(req.user);
  if (!design || (design.members_only && !member)) {
    return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  }
  const artist = design.artist_id
    ? await db.get('SELECT display_name FROM users WHERE id = ?', [design.artist_id])
    : null;
  // Portfolio custom pieces sell at the custom-design price (sale-aware);
  // pre-designs sell at the premade price. Members get the early sale entry.
  const isCustom = design.listing_type === 'custom';
  const price = isCustom ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member);
  let owned = false;
  if (req.user) {
    const o = await db.get(
      `SELECT id FROM orders WHERE buyer_id = ? AND design_id = ? AND status = 'paid' AND order_type = 'premade'`,
      [req.user.id, design.id]
    );
    owned = !!o;
  }
  const { withFeeCents, processingFeeCents } = require('../lib/pricing');
  const lineworkBase = lineworkOnlyPriceCents(price);
  const viewer = await viewerFor(req.user);
  const imgFile = displayImgFile(design, viewer, owned);
  const blurred = design.sensitivity === 'explicit' && !canViewUnblurred(design, viewer, owned);
  const base = config.baseUrl.replace(/\/$/, '');
  const canonical = `${base}/design/${design.id}`;
  const styleBit = design.style ? `${design.style} ` : '';
  const artistName = artist && artist.display_name ? artist.display_name : 'Tattoo Art Customs';
  const catBit = design.categories.length ? ` (${design.categories.slice(0, 3).join(', ')})` : '';
  const priceTotalCents = withFeeCents(price);
  const priceStr = `$${(priceTotalCents / 100).toFixed(2)}`;
  const ogImgFile = imgFile || (design.linework_wm_path || '').split('/').pop();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${design.title} — ${styleBit}tattoo design`,
    image: ogImgFile ? `${base}/img/designs/${ogImgFile}` : canonical,
    description: `Original ${styleBit}tattoo design "${design.title}" by ${artistName}. Buy the full color and clean linework files at Tattoo Art Customs.`,
    brand: { '@type': 'Brand', name: 'Tattoo Art Customs' },
    offers: {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: 'USD',
      price: (priceTotalCents / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
    },
  };
  res.render('site/design', {
    title: `${design.title} — ${styleBit}Tattoo Design for Sale | Tattoo Art Customs`,
    design, artist, price, isCustom, sale: await salePriceActive(req.user), owned,
    imgFile, blurred,
    // Linework-only purchase option (3% discount). Pieces with no color
    // version are linework-only automatically.
    lineworkPrice: lineworkBase,
    // Checkout totals include the 3.5% + $0.49 processing fee.
    priceTotal: priceTotalCents,
    priceFee: processingFeeCents(price),
    lineworkTotal: withFeeCents(lineworkBase),
    lineworkFee: processingFeeCents(lineworkBase),
    lineworkDiscount: LINEWORK_ONLY_DISCOUNT,
    metaDescription: `Buy "${design.title}" — an original ${styleBit}tattoo design${catBit} by ${artistName}. ${priceStr}, full color + linework delivered after purchase.`,
    canonical, ogImage: ogImgFile ? `${base}/img/designs/${ogImgFile}` : '', ogType: 'product', jsonLd,
    creditBalance: req.user ? await require('../lib/credits').getCreditBalance(req.user.id) : 0,
  });
});

// Public artist portfolio: bio + pieces (watermarked linework only).
// No login required. Includes tattoo shops opted into the free designer
// membership — they are designers on the site too.
router.get('/artists/:id', async (req, res) => {
  const artist = await db.get(
    `SELECT u.id, u.display_name, u.is_founding_artist FROM users u
     LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND u.role IN ('design_artist','tattoo_shop','admin','head_admin')`,
    [req.params.id]);
  if (!artist) return res.status(404).render('error', { title: 'Not found', message: 'That artist portfolio does not exist.' });
  const profile = await db.get("SELECT bio FROM artist_profiles WHERE user_id = ? AND bio_status = 'ok'", [artist.id]);
  const member = await isActiveMember(req.user);
  const rows = await db.all(
    `SELECT * FROM designs WHERE artist_id = ? AND status = 'approved'
     AND (members_only = 0 OR ? = 1) ORDER BY created_at DESC`, [artist.id, member ? 1 : 0]);
  const pieces = rows.map((d) => {
    const isCustom = d.listing_type === 'custom';
    return { ...d, price: isCustom ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member), isCustom };
  });
  const artViewer = await viewerFor(req.user);
  const piecesWithThumbs = pieces.map((p) => ({ ...p, thumb: displayImgFile(p, artViewer) }));
  res.render('site/artist', {
    title: `${artist.display_name || 'Artist'} — Tattoo Designs for Sale | Tattoo Art Customs`,
    artist, bio: profile ? profile.bio : '', pieces: piecesWithThumbs, sale: await salePriceActive(req.user),
    metaDescription: `${artist.display_name || 'Artist'} — buy original tattoo designs from this artist's portfolio at Tattoo Art Customs.`,
    canonical: `${config.baseUrl.replace(/\/$/, '')}/artists/${artist.id}`,
  });
});

router.get('/terms', (req, res) => res.render('site/terms', {
  title: 'Terms of Service — Tattoo Art Customs',
  metaDescription: 'Tattoo Art Customs terms of service.',
}));

router.get('/privacy', (req, res) => res.render('site/privacy', {
  title: 'Privacy Policy — Tattoo Art Customs',
  metaDescription: 'Tattoo Art Customs privacy policy.',
}));

router.get('/about', (req, res) => res.render('site/about', {
  title: 'About — Tattoo Art Customs',
  metaDescription: 'About Tattoo Art Customs marketplace.',
}));

// Tester bug reports: anyone (signed in or not) can file one. Each report is
// saved and emailed to the owner the moment it lands.
router.get('/report-bug', (req, res) => {
  res.render('site/report-bug', {
    title: 'Report a Bug — Tattoo Art Customs',
    metaDescription: 'Report a bug on Tattoo Art Customs — it goes straight to the site owner.',
  });
});
router.post('/report-bug', formLimiter, checkHoneypot, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const details = String(req.body.details || '').trim().slice(0, 2000);
  const pageUrl = String(req.body.page_url || '').trim().slice(0, 300);
  const severity = ['normal', 'annoying', 'blocking'].includes(req.body.severity) ? req.body.severity : 'normal';
  const reporterEmail = req.user ? req.user.email : String(req.body.reporter_email || '').trim().slice(0, 120);
  if (!title || !details) {
    req.session.flash = 'Please give the bug a title and describe what happened.';
    return res.redirect('/report-bug');
  }
  const id = await db.insert('bug_reports', {
    user_id: req.user ? req.user.id : null,
    reporter_email: reporterEmail || null,
    page_url: pageUrl || null,
    title, details, severity,
    status: 'open', created_at: db.now(),
  });
  const body = `Severity: ${severity}\nPage: ${pageUrl || '—'}\nReporter: ${reporterEmail || 'anonymous'}\n\n${details}`;
  // Email the owner immediately (ADMIN_EMAIL, else every head admin).
  try {
    const { sendMail } = require('../lib/mail');
    let to = [config.adminEmail].filter(Boolean);
    if (!to.length) {
      const heads = await db.all("SELECT email FROM users WHERE role = 'head_admin' AND email IS NOT NULL");
      to = heads.map((h) => h.email);
    }
    for (const addr of to) {
      await sendMail({ to: addr, subject: `[Bug: ${severity}] ${title}`, text: `New bug report #${String(id).slice(0, 8)}\n\n${body}` });
    }
  } catch (e) { console.error('bug report email failed:', e.message); }
  // In-app nudge for admins too.
  try {
    await require('../lib/notify').notifyAdmins({
      kind: 'bug', title: `Bug reported: ${title}`,
      body: `${severity} — ${pageUrl || 'no page given'}`,
      link: '/admin/bugs',
    });
  } catch (e) { console.error('bug report notify failed:', e.message); }
  req.session.flash = 'Thanks — your bug report was sent to the site owner.';
  res.redirect('/report-bug');
});

// App launch notify: homepage "coming soon" banner collects an email so we
// can announce the mobile app launch. The list doubles as warm customer
// leads for outreach.
router.post('/app-notify', formLimiter, checkHoneypot, async (req, res) => {
  const raw = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) {
    req.session.flash = 'Please enter a valid email address.';
    return res.redirect('/#app');
  }
  try {
    const existing = await db.get('SELECT id FROM app_launch_signups WHERE email = ?', [raw]);
    if (!existing) {
      await db.insert('app_launch_signups', { email: raw, created_at: db.now(), notified_at: null });
    }
  } catch (e) { console.error('app-notify insert failed:', e.message); }
  req.session.flash = "You're on the list — we'll email you the moment the app launches.";
  res.redirect('/#app');
});

// Public opening-raffle page: prizes, entry progress, winners once drawn.
router.get('/raffle', async (req, res) => {
  const founding = require('../lib/founding');
  const open = await founding.raffleEntriesOpen();
  const status = await founding.getFoundingStatus();
  const drawn = status.raffleDrawn;
  const winners = drawn ? await db.all(
    `SELECT r.prize_won, r.drawn_at, u.display_name
     FROM raffle_entries r JOIN users u ON u.id = r.user_id
     WHERE r.prize_won IS NOT NULL ORDER BY
       CASE r.prize_won WHEN 'grand' THEN 0 ELSE 1 END`) : [];
  res.render('site/raffle', {
    title: 'Tattoo Art Customs Opening Raffle — Free Entry',
    metaDescription: 'The Tattoo Art Customs Opening Raffle: free entry with a free account. Grand prize is any premade design of your choice plus a free month of membership; two runners-up win a free premade design each.',
    raffleOpen: status.raffleOpen,
    raffleDrawn: drawn,
    raffleEntries: open.entries || 0,
    entryTarget: founding.RAFFLE_ENTRY_TARGET,
    minClosesAt: founding.RAFFLE_ENTRY_MIN_CLOSE_AT,
    profitTargetCents: founding.RAFFLE_OWNER_PROFIT_TARGET_CENTS,
    winners,
    alreadyEntered: req.user ? !!(await db.get(
      'SELECT id FROM raffle_entries WHERE user_id = ?', [req.user.id])) : false,
  });
});


router.get('/notifications', requireLogin, async (req, res) => {
  const { unreadCount } = require('../lib/notify');
  const notes = await db.all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]).catch(() => []);
  res.render('site/notifications', {
    title: 'Notifications — Tattoo Art Customs', notifications: notes,
    metaDescription: '',
  });
  res.locals.notifCount = 0; // header badge refreshes on the next page
});

router.post('/notifications/:id/read', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  await db.query(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?',
    [db.now(), req.params.id, req.user.id]).catch(() => {});
  res.redirect('/notifications');
});

module.exports = router;
